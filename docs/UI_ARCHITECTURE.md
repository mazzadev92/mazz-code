# Architecture de l’interface et contrats backend

## 1. Vue d’ensemble

```
Navigateur (127.0.0.1:3333)
  apps/web  React 19 + Vite 8 + Tailwind 4 + Lucide + CodeMirror 6 (chargé à la demande)
     |  fetch JSON  /  SSE via fetch (POST + AbortSignal)
packages/core  MazzServer : routeur, garde d’origine, statique, stockages
     |-- agent (boucle MAZZ) -- providers (llama.cpp, OpenAI-compatibles, Anthropic, Gemini, test)
     |-- tools (fs, terminal, gcc, git, checkpoints)
     |-- model-manager (parseur GGUF, superviseur llama-server)
     |-- hermes-bridge
Données : %APPDATA%\MAZZ_AGENT_STUDIO (MAZZ_STUDIO_DATA pour surcharger)
```

Le serveur sert `apps/web/dist` (CSP stricte, cache immuable des assets) ; `npm run dev:web` lance Vite sur 5173 avec proxy `/api`.

## 2. Arborescence frontend

```
apps/web/src
  main.tsx                 thème appliqué avant rendu, polling, racine
  styles/index.css         jetons, thèmes, animations, composants CSS
  lib/
    api.ts sse.ts          client HTTP, parseur SSE incrémental
    store.ts               état global (useSyncExternalStore), routage par hash, polling
    agentRuns.ts           exécutions live par session, reprise, approbations, throttling 50 ms
    diff.ts markdown.ts    diff de lignes, Markdown sûr (AST rendu en éléments React)
    highlight.ts           highlight.js paresseux
    format.ts i18n.ts prefs.ts types.ts
  components/              ui.tsx (primitives), Splitter, charts (SVG), DiffView, Markdown, overlays (palette, toasts, sélecteur de chemin), brand
  shell/AppShell.tsx       barre de titre, rail, sidebar, inspecteur, panneau bas, barre d’état, raccourcis
  features/
    home/ agent/ sessions/ projects/ code/ git/ models/ providers/ tools/ memory/ performance/ settings/ terminal/
  e2e/run-e2e.mjs          campagne E2E (playwright-core + Chrome/Edge installé)
```

Chaque vue est un module chargé paresseusement (`React.lazy`). Bloc le plus lourd : CodeMirror (≈840 Ko non compressé, 294 Ko gzip), chargé seulement à l’ouverture de la vue Code.

## 3. État

- `store.ts` : santé, paramètres, statut llama-server, métriques système, fournisseurs, sessions, tâches, toasts, panneaux. Les paramètres ne sont mis à jour qu’après réponse du serveur.
- `agentRuns.ts` : une exécution live par session. Les événements sont appliqués dans des tableaux mutables et notifiés au plus toutes les 50 ms (immédiatement pour les événements structurels) : le streaming ne provoque pas plus de ~20 rendus par seconde.
- `prefs.ts` (localStorage protégé par try/catch) : tailles de panneaux, disposition, dernier thème appliqué, brouillons. Jamais de secret.

## 4. Flux SSE de l’agent

1. `POST /api/agent/run` `{ sessionId?, goal, mode, selection }` : le serveur crée la session si besoin, ouvre un tour, lance la tâche **indépendamment de la connexion** (TaskHub), répond par `event: meta {taskId, sessionId, turnId}` puis `id: n` + `data: AgentEvent`, et `data: [DONE]`.
2. Coupure : le client réessaie `GET /api/agent/attach?taskId&from=n+1` (backoff jusqu’à 8 s, 6 tentatives). Les événements sont tamponnés côté serveur (20 000 max) ; une tâche terminée reste rattachable 10 minutes.
3. Rechargement de page : `GET /api/sessions/:id` renvoie `running` ; le client se rattache depuis l’index 0.
4. Approbations : l’événement `approval_request {callId, toolName, params, category}` suspend l’outil ; `POST /api/agent/approve {approvalId, approved}` le débloque ; délai `agent.approvalTimeoutSec` puis refus automatique ; `approval_result` trace la décision.
5. Annulation : `POST /api/agent/cancel {taskId}` déclenche l’AbortSignal ; le fournisseur produit un `usage` partiel.

Événements ajoutés au contrat (additifs) : `approval_request`, `approval_result`, `progress` (liveness pendant la génération d’arguments d’outil) ; `usage.telemetry` (enregistrement complet).

## 5. Contrats REST ajoutés

| Domaine | Routes |
| :--- | :--- |
| Diagnostic | `GET /api/doctor[?refresh=1]`, `GET /api/system/metrics` |
| Paramètres | `GET/PUT /api/settings` (422 + `details[{path,message}]`), `POST /api/settings/reset {section}` |
| Projets | `POST /api/workspace/open`, `GET /api/fs/browse?path&ext`, `POST /api/dialog/folder`, `POST /api/dialog/file {filter}` |
| Fichiers | `GET /api/files/tree?path`, `GET /api/files/read?path`, `PUT /api/files/write {path, content, expectedModifiedAt}` (409 en cas de conflit), `GET /api/files/search?q&names`, `POST /api/open-in-editor {path}` |
| Checkpoints | `GET /api/checkpoints`, `POST /api/checkpoints/:id/rollback`, `DELETE /api/checkpoints/:id` |
| Terminal | `GET /api/terminal/shells`, `POST /api/terminal/run` (SSE `start/stdout/stderr/exit/error`), `POST /api/terminal/cancel {runId}` |
| Git | `GET /api/git/{status,diff,log,branches}`, `POST /api/git/{stage,unstage,discard,commit}` |
| Fournisseurs | `GET /api/providers`, `POST /api/providers` (personnalisé), `DELETE /api/providers/:id`, `PUT/DELETE /api/providers/:id/key`, `GET /api/providers/keys`, `POST /api/providers/test`, `GET /api/providers/:id/models` |
| Modèles | `GET /api/models/catalog`, `GET/POST/DELETE /api/models/library`, `POST /api/models/scan`, `GET /api/models/server/{status,logs,props,binaries}`, `POST /api/models/server/{start,stop}` (409 `INSUFFICIENT_MEMORY`) |
| Inférence | `POST /api/inference/test` (SSE), `POST /api/inference/cancel` |
| Mesures | `GET/DELETE /api/telemetry/runs`, `POST /api/bench/run`, `GET /api/bench/results`, `DELETE /api/bench/results/:id` |
| Sessions | `GET/POST /api/sessions`, `GET/PATCH/DELETE /api/sessions/:id`, `POST /api/sessions/:id/duplicate` |
| Agent | `POST /api/agent/run`, `GET /api/agent/attach`, `GET /api/agent/active`, `POST /api/agent/cancel`, `POST /api/agent/approve` |
| Données | `GET /api/audit`, `GET /api/data/inventory`, `DELETE /api/data/:kind` |

Toutes les routes historiques sont conservées (même chemin, même forme de réponse).

## 6. Sécurité

- Garde : `Host` doit être `127.0.0.1|localhost|[::1]:port` ; un en-tête `Origin` étranger est refusé (403). Pas de CORS générique ; origines de développement Vite autorisées explicitement.
- Corps JSON limités à 6 Mo. Chemins confinés au projet (`resolveSafePath`). Commandes Git via `execFile` sans shell.
- Clés : coffre DPAPI (`secrets.vault.json`), texte clair uniquement en mémoire du processus ; l’API ne renvoie qu’un indice masqué.
- Permissions appliquées par le backend pour chaque outil et chaque action d’interface équivalente (écriture, terminal, Git, réseau) ; journal `audit.jsonl`.
- CSP de l’interface : `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`.

## 7. Stockage

| Fichier | Contenu |
| :--- | :--- |
| `settings.json` | Paramètres validés (écriture atomique) |
| `secrets.vault.json` | Clés chiffrées DPAPI + indice masqué |
| `sessions/<id>.json` | Session, tours, événements compactés (jetons fusionnés), télémétrie |
| `telemetry.json` | Mesures (rétention configurable) |
| `benchmarks.json` | Résultats de benchmark |
| `checkpoints.json` | Points de restauration (200 derniers) |
| `audit.jsonl` | Journal d’audit en ajout seul |

## 8. Performances visées (i5-6500, 16 Go)

- Polling : santé et sessions 15 s, tâches 4 s, métriques 3 s, llama-server 2 s uniquement pendant un chargement ; tout est suspendu onglet masqué.
- Terminal et journaux virtualisés (hauteur de ligne fixe) : 3000 lignes reçues, 28 nœuds dans le DOM (mesure E2E).
- Pas d’animation permanente hors marque en veille (CSS transform, 6 s) ; `prefers-reduced-motion` respecté.
