# Cahier des charges : parité MAZZ Agent Studio / Claude Code

Version 1, 22/10/2026.

**Objectif.** Le Studio doit offrir tout ce que fait Claude Code (desktop et CLI), côté moteur comme côté interface. Une seule différence : le moteur se choisit, soit un modèle local (llama.cpp avec le profil MUCE, ou le service MUCE), soit une API (Anthropic, OpenAI, Groq, Gemini, OpenAI-compatible). L'interface suit la direction artistique MAZZ : Bioforge Leaf et Blueprint Engineer, zéro emoji, français.

**Règles inchangées.**
- Aucune métrique inventée.
- Une fonction absente est marquée « Non disponible ».
- Les clés restent dans le coffre.
- Les permissions sont appliquées par le backend.

**Légende** : Fait, Partiel, À faire. La phase indique l'ordre de réalisation : P1 en cours, P2 ensuite, P3 plus tard.

---

## 1. Moteur et modèles

| Fonction (Claude Code) | Équivalent Studio | État | Phase |
|---|---|---|---|
| Choix du modèle par session | Sélecteur local / API, mémorisé par session | Fait | |
| Changement de modèle en cours de session | Sélecteur dans le compositeur | Fait | |
| Effort ou raisonnement réglable | `--reasoning off/auto/on` en local ; paramètre de raisonnement des API | Partiel | P2 |
| Mode rapide | Profil MUCE (spéculation n-gram, polling, priorité) | Fait (local) | |
| Modèle auxiliaire pour les tâches secondaires | Paramètres > IA > modèle auxiliaire | Fait | |
| Cache de prompt | Préfixe stable, cache KV par session sur disque | Fait (local) | |
| Fenêtre de contexte longue | Jusqu'à 256k en local, cache KV q8_0 | Fait | |
| Résumé automatique des longues conversations | Résumé des anciens échanges au-delà d'un seuil (modèle auxiliaire ou modèle de la session), et `/compact` | Fait | |
| Images (vision) | Pièces jointes envoyées aux modèles multimodaux | Fait | |
| Suivi du coût et de l'usage | Jetons par échange et par session ; coût seulement si le tarif est vérifié | Partiel | P2 |

## 2. Outils de l'agent

| Outil Claude Code | Équivalent Studio | État | Phase |
|---|---|---|---|
| Read | `fs.read` | Fait | |
| Write | `fs.write` (point de restauration) | Fait | |
| Edit | `fs.patch` (remplacement de blocs exacts) | Fait | |
| Glob | `fs.list` et `code.map` | Fait | |
| Grep | `code.search` (ripgrep) | Fait | |
| Bash / PowerShell | `terminal.run` (PowerShell ou cmd, cwd) | Fait | |
| Commandes en arrière-plan, arrêt, lecture de sortie | `terminal.start`, `terminal.read`, `terminal.stop` (arbre de processus arrêté, sortie bornée) | Fait | |
| WebSearch | `web.search` (DuckDuckGo sans clé, SearXNG, Brave avec clé) | Fait (vérifié avec Qwen3 4B) | |
| WebFetch | `web.fetch` (page convertie en texte ; adresses locales et privées refusées) | Fait | |
| Liste de tâches (TodoWrite / plan) | `plan.update`, liste affichée sous la conversation | Fait | |
| AskUserQuestion | `user.ask` : question à choix, en attente de la réponse | Fait | |
| Sous-agents | `agent.delegate` (explorateur, relecteur, testeur) | Fait | |
| Sous-agents définis par l'utilisateur | Fichiers `.mazz/agents/*.md` et `.claude/agents/*.md` (outils Claude Code traduits) | Fait | |
| Skills | `skills.search`, `skills.load`, `/nom` | Fait | |
| MCP | Client stdio et HTTP, jetons dans le coffre | Fait | |
| Connecteurs OAuth | Connexion par le navigateur | À faire | P3 |
| NotebookEdit | Édition de cellules `.ipynb` | À faire | P3 |
| LSP (diagnostics, définitions) | `code.outline` et `code.map` (ast-grep) ; diagnostics de compilation | Partiel | P3 |
| Tâches planifiées et boucles | Tâches récurrentes par session | À faire | P3 |
| Navigateur piloté | MCP Playwright (modèle prêt) | Partiel | P2 |

## 3. Contexte et mémoire

| Fonction | Équivalent Studio | État | Phase |
|---|---|---|---|
| CLAUDE.md du projet | Lecture de `MAZZ.md`, `AGENTS.md`, `CLAUDE.md`, `.mazz/MAZZ.md` du projet | Fait | |
| Instructions globales de l'utilisateur | `MAZZ.md` du dossier de données du Studio | Fait | |
| Mémoire persistante entre sessions | `memory.save`, `memory.search`, `memory.read` ; index donné à chaque tâche ; page Mémoire et données | Fait | |
| Mémoire sémantique (index de dossiers) | `index.search` : index d'embeddings local (embeddinggemma-300M, multilingue) de dossiers choisis, incrémental, reprise après arrêt, priorité basse | Fait | |
| Mentions `@fichier` | Autocomplétion dans le compositeur | Fait | |
| Pièces jointes | Tout type ; texte extrait (PDF, DOCX, code) | Fait | |

## 4. Sécurité et autorisations

| Fonction | Équivalent Studio | État | Phase |
|---|---|---|---|
| Modes de permission (default, acceptEdits, bypass, plan) | Standard, Accepter les modifications, Sans confirmation ; mode Plan | Fait | |
| Réponses une fois / session / toujours | Cartes d'approbation | Fait | |
| Dossiers de confiance, /add-dir | Accès au PC, dossiers de session | Fait | |
| Règles allow/deny par commande ou motif | Règles par outil et motif (ex. `terminal.run : git *`) ; « Toujours » sur une commande crée la règle de sa famille | Fait | |
| Dossiers protégés | Coffre, .ssh, .aws, etc. | Fait | |
| Journal d'audit | Journal des décisions | Fait | |
| Hooks (avant/après outil, fin de tour) | Scripts déclarés dans les Paramètres | À faire | P3 |

## 5. Code, Git et vérification

| Fonction | Équivalent Studio | État | Phase |
|---|---|---|---|
| Diff des modifications | Vue Diff par échange | Fait | |
| Retour arrière (rewind / checkpoints) | Points de restauration par tâche | Fait | |
| Git : statut, indexation, commit | Vue Git, message proposé | Fait | |
| Branches, push, pull request | Changement et création de branche, pull en avance rapide, push (upstream au premier push, jamais forcé), pull request via `gh` | Fait | |
| Worktrees isolés | Sessions dans un worktree Git | À faire | P3 |
| Revue de code (/review), revue de sécurité | Mode Review et spécialiste relecteur | Partiel | P2 |
| Compilation et tests | `compiler.gcc`, `terminal.run`, spécialiste testeur | Fait | |

## 6. Interface (userland)

| Élément Claude Code desktop | Équivalent Studio | État | Phase |
|---|---|---|---|
| Barre latérale des sessions (épingler, archiver, renommer, dupliquer) | Sessions | Fait | |
| Flux de la conversation avec appels d'outils repliables | TurnView | Fait | |
| Liste de tâches affichée pendant le travail | Liste de tâches sous la conversation et pendant le travail | Fait | |
| Questions à choix (cartes) | Carte de question avec options et réponse libre | Fait | |
| Encadré de fin de tour (résumé + boutons d'action) | Bilan construit à partir des faits (fichiers +/-, commandes, échecs) ; Continuer / Corriger les échecs, Revoir dans Git, Annuler les modifications | Fait | |
| Chapitres et table des matières | Chapitres de session | À faire | P3 |
| Panneau fichiers et éditeur | Vue Code (CodeMirror) | Fait | |
| Panneau terminal | Panneau du bas | Fait | |
| Terminal interactif (PTY) | Onglet « Interactif » : ConPTY (node-pty) et xterm.js, plusieurs terminaux, rejoué après rechargement | Fait | |
| Panneau navigateur / aperçu | Aperçu d'un serveur local dans l'application | À faire | P3 |
| Palette de commandes et raccourcis | Ctrl+K, raccourcis | Fait | |
| Commandes slash | `/compact`, `/clear`, skills, commandes personnalisées `.mazz/commands` et `.claude/commands` ($ARGUMENTS) | Fait | |
| Notifications de fin de tâche | Notifications internes | Fait | |
| Télémétrie de l'inférence | Vitesse mesurée, cache, spéculation, mémoire | Fait (plus détaillée) | |
| Export de session (Markdown, JSON) | Menu de session | Fait | |
| Thèmes | Bioforge Leaf, Blueprint Engineer, clair et sombre | Fait | |

## 7. Moteur local MUCE

| Fonction | État |
|---|---|
| Profil d'accélération appliqué à llama-server | Fait (mesuré : x2 à x3 en réécriture de code) |
| Service MUCE 8098 : démarrage, télémétrie, arrêt | Fait |
| Analyseur de modèle | Fait |
| Index n-gram construit sur le projet (`--lookup-cache-static`) | Mesuré : plus lent au 1er passage, non retenu (docs/MUCE_INTEGRATION.md) |
| Têtes EAGLE3 / MTP | À faire (P3), demande un modèle compatible |
| Runtime ik_llama.cpp (MoE sur CPU) | Mesuré sur modèles denses : pas de gain (1.7B : 10,0 contre 17,3 tok/s), non intégré ; à réévaluer avec un MoE |

---

## Phase 1 (terminée le 22/10/2026)

1. `web.search` et `web.fetch`, avec la permission « web ».
2. Instructions de projet et instructions globales.
3. `plan.update` (liste de tâches) et `user.ask` (questions à choix), avec leurs cartes dans l'interface.
4. Résumé automatique et manuel des longues conversations (`/compact`).

Critère de fin : chaque fonction est testée (tests unitaires ou de bout en bout), passe la vérification anti-emoji et est documentée dans `UI_IMPLEMENTATION_STATUS.md`.

Vérification de la phase 1 :
- tests : 17 core (outils web, résumé), 5 agent (`plan.update`, `user.ask`, instructions de projet), campagne E2E 18/18 ;
- agent réel : Qwen3 4B en mode Ask appelle `web.search` et résume les résultats en 69 s.

## Phase 2 (terminée le 22/10/2026, sauf MUCE et mémoire sémantique)

Vérification : tests core 22 (règles, mémoire, extensions, Git avec dépôt distant, tâches de fond), E2E 18/18 ; terminal interactif vérifié avec `Read-Host` et dans l'interface.

## Reste de la phase 2

Réglage du raisonnement des API, suivi de l'usage par session. L'index sémantique, le cache n-gram du projet et ik_llama.cpp sont traités (voir ci-dessus et docs/MUCE_INTEGRATION.md).

## Bibliothèques de connaissances (Bib1)

- Moteur MAZZ Universal Knowledge (`D:\Mazz Code\Bib1`, construit par Codex) démarré automatiquement par le Studio sur le port 8095 (son port par défaut, 8098, est celui du service MUCE).
- Recherche automatique avant chaque demande (`knowledge.autoContext`) : les passages cités sont joints à la question pour tout modèle, local ou API, présent ou futur, sans appel d'outil. Outil `knowledge.search` toujours proposé. Skill `/vault-search` : bibliothèques Bib1, ou vault donné par son chemin dans le message.
- `D:\Ressources Repo` copié dans `Bib1\Ressources Repo`.
- Vérifié : Qwen3 0.6B en local reçoit le passage « Addition de fractions » et répond avec la bonne règle ; il cite mal sa source.
