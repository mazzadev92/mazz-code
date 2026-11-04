# Audit avant refonte de l’interface

Date : 22/10/2026. Périmètre : `D:\Mazz Code\MAZZ_AGENT_STUDIO` tel que trouvé avant travaux, plus les ressources de direction artistique `D:\Mazz Laef` et `D:\TESSERA\Frontend`.

## 1. Architecture trouvée

| Élément | Constat |
| :--- | :--- |
| Workspace | npm workspaces (`packages/*`, `apps/*`), TypeScript 5.9, modules ES, Node 24 |
| Paquets | `shared`, `tools`, `providers`, `model-manager`, `agent`, `core`, `hermes-bridge` (+ dossiers vides `memory`, `context-engine`, `security`, `telemetry`) |
| Applications | `apps/cli` (CLI `mazz-agent`), `apps/web/public/index.html` (interface unique de 800 lignes, HTML + JS inline), `apps/desktop` vide |
| Build | `npm run --workspaces build` dans l’ordre alphabétique : fonctionnait seulement parce que les `dist/` existaient déjà (`agent` compilé avant `shared`) |
| Tests | `node --test` par paquet, 8 paquets, tous verts au départ |
| Serveur | `MazzServer` HTTP + SSE sur 127.0.0.1:3333, 16 routes |

## 2. Endpoints existants (avant)

`GET /api/health`, `GET /api/workspace/status`, `POST /api/workspace/open`, `GET /api/tools`, `GET /api/models`, `POST /api/models/import`, `GET|POST /api/models/server/{status,start,stop}`, `GET /api/hermes/status`, `POST /api/hermes/delegate`, `GET /api/providers`, `POST /api/providers/test`, `POST /api/agent/run` (SSE), `POST /api/agent/cancel`. Contrat d’événements `AgentEvent` : `token`, `thought`, `status`, `tool_start`, `tool_result`, `diff`, `checkpoint`, `rollback`, `usage`, `error`, `complete`.

## 3. Défauts relevés

### Sécurité
- **CORS `*` sur un serveur qui exécute des commandes** : n’importe quelle page web visitée pouvait appeler `127.0.0.1:3333/api/agent/run` et faire exécuter du PowerShell. Aucune vérification d’hôte (rebinding DNS).
- Clé Gemini passée dans l’URL (`?key=`), donc exposable dans des journaux.
- Aucune saisie de clé réellement câblée : `saveApiKeys()` appelé par l’interface n’existait pas.

### Backend
- `server.ts` utilisait `__dirname` et `compiler.ts` utilisait `require()` dans des modules ES : erreurs masquées par des `catch` (repli silencieux, détection des chemins de secours de GCC jamais exécutée).
- La boucle agent ignorait les événements `diff` émis par `fs.write` et ne créait jamais de checkpoint (l’identifiant était calculé puis inutilisé).
- Messages d’outils renvoyés au modèle sans `tool_calls` sur le message assistant : refusé par les API OpenAI/Anthropic. Noms d’outils avec point (`fs.write`) : invalides pour OpenAI, Anthropic et Gemini.
- `complete.success` toujours `true`, y compris après une erreur fatale ou la limite d’itérations.
- Parseur GGUF limité aux 256 premiers Ko : les métadonnées situées après le vocabulaire (150 000 jetons pour Qwen) étaient perdues ; contexte par défaut inventé à 4096 ; estimation RAM fixe (512 Mo par 4k jetons).
- Superviseur llama-server : timeout de santé de 10 s puis « succès » même si le modèle chargeait encore ; aucun état intermédiaire.

### Télémétrie
- `tokensPerSecond` = nombre de fragments SSE / durée totale incluant la latence du premier jeton : ni des jetons, ni un débit de génération.
- Les `timings` de llama.cpp (prefill et décodage séparés) n’étaient pas lus.
- Le moteur déterministe publiait des valeurs inventées (`42` jetons, `120 tok/s`).

### Interface
- Emojis dans la navigation et les badges (U+1F4AC, U+1F9E0, U+2699, U+2714, etc.).
- Terminal factice : la commande saisie était envoyée comme prompt au moteur de test.
- Bouton « Charger » des modèles sans action ; liste de modèles en dur ; sélecteur de modèle qui routait tout autre choix vers `llama-local`.
- Pas de sessions persistantes, pas de paramètres, pas d’explorateur, pas de diff, pas de gestion des erreurs réseau.

## 4. Ressources de direction artistique

| Source | Éléments réutilisés |
| :--- | :--- |
| `D:\Mazz Laef\docs\DIRECTION_ARTISTIQUE_OFFICIELLE.md`, `MOTION_LANGUAGE.md`, `TESSERA_STATES.md` | Palette (Obsidienne, Forest, Eucalyptus, Sage, Champagne, Cuivre pour les erreurs), courbes d’animation nommées, états de présence (veille, réflexion, outil, erreur) |
| `D:\Mazz Laef\Planche de marque Bioforge Leaf.png` | Emblème, tuile d’application, typographies Sora / JetBrains Mono |
| `D:\TESSERA\Frontend` (React 19, Tailwind 4, Lucide) | Jetons Obsidienne / Ivoire, liseré champagne de navigation, verre fumé du composer, tuiles d’icônes de modules, palette de commandes |

## 5. Matrice état avant / état cible

| Domaine | Avant | Cible | Backend disponible | Priorité |
| :--- | :--- | :--- | :--- | :--- |
| Sécurité locale | CORS `*` | Origine et hôte vérifiés | à ajouter | P0 |
| Shell, navigation | 6 onglets | Rail, sidebar, inspecteur, panneau bas, barre d’état, palette | n/a | P0 |
| Chat agent | Texte brut | Markdown sûr, outils, diffs, approbations, reprise | partiel (SSE) | P0 |
| Sessions | aucune | Persistance, recherche, archivage, reprise | à ajouter | P0 |
| Model Hub | tableau statique | Bibliothèque, lancement, RAM, capacités, test | partiel (superviseur) | P0 |
| Télémétrie | fragments/s | tg, pp, TTFT par source | à corriger | P0 |
| Fournisseurs | champs non câblés | Coffre de clés chiffré, test, personnalisés | à ajouter | P0 |
| Paramètres | aucun | 11 catégories persistantes validées | à ajouter | P0 |
| Permissions | implicites | Centre de permissions et audit | partiel (`requestApproval`) | P0 |
| Terminal | factice | Exécution réelle streamée, annulation | à ajouter | P1 |
| Explorateur, éditeur | aucun | Arborescence paresseuse, CodeMirror | à ajouter | P1 |
| Git | statut seul | Diff, indexation, commit, historique | à ajouter | P1 |
| Performance | aucun | Temps réel, historique, benchmarks, export | à ajouter | P1 |
| MCP, Skills | absent | État explicite « Non disponible » | absent | P2 |
| Mémoire sémantique | absente | État explicite, inventaire réel des données | absent | P2 |
