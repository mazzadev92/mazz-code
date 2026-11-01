# Plan du harness MAZZ (orchestrateur unique, agents combinés)

Principe retenu : **un seul orchestrateur** (la boucle MAZZ, architecture Cordis : services, événements, outils remplaçables) ; les autres agents interviennent comme **spécialistes** avec un périmètre, des outils et un budget limités. Pas de boucles autonomes concurrentes sur la même tâche.

Contrainte matérielle (i5-6500, 16 Go, petits GGUF) : rien ne tourne en permanence. Outils = bibliothèques chargées dans le processus ou exécutables lancés à la demande ; serveurs MCP démarrés seulement quand une tâche en a besoin. Le modèle ne reçoit que les outils pertinents pour la tâche.

Hors périmètre de ce plan, sur demande : CAO, CAD, électronique, Blender, Godot, KiCad, FreeCAD (MCP dédiés plus tard).

## Tri de la liste proposée

| Élément | Décision | Raison |
| :--- | :--- | :--- |
| ripgrep | **Intégré (phase 1)** | Recherche texte rapide et bornée, binaire embarqué |
| ast-grep (Tree-sitter) | **Intégré (phase 1)** | Plan des fichiers, recherche structurelle C, C++, Python, Rust, TS/JS sans compilation |
| Édition par blocs (technique Aider / Codex) | **Intégré (phase 1)** : `fs.patch` | Modifier sans réécrire le fichier, diffs petits, moins de jetons |
| Carte du dépôt (technique Aider / Repomix) | **Intégré (phase 1)** : `code.map` | Vue compacte des symboles sous budget de jetons |
| MCP Python/TS SDK, client | **Intégré (phase 1)** | Gestionnaire de serveurs MCP : configuration, démarrage à la demande, outils, permissions |
| Catalogue de capacités | **Intégré (phase 1)** | Chaque outil déclare catégorie, mots-clés, coût ; sélection par tâche |
| Sous-agents (OpenHands, Hermes) | **Intégré (phase 1)** : `agent.delegate` | Spécialistes explorateur, relecteur, testeur avec outils restreints |
| Git worktrees, checkpoints | Phase 2 | Checkpoints déjà présents ; worktree par session ensuite |
| Playwright MCP, Chrome DevTools MCP, GitHub MCP | Phase 2, via le client MCP | Aucun code spécifique : configuration de serveurs |
| FastMCP, MCP Inspector | Phase 2 (outils développeur) | Création et diagnostic de MCP maison |
| pywinauto / FlaUI | Phase 3, en MCP | Contrôle Windows à la demande |
| sqlite-vec + embeddings | Phase 2 | Mémoire et recherche sémantique locales légères |
| Hermes Agent | Pont existant ; exposé comme spécialiste quand installé | Compétences et délégation |
| OpenCode, Aider, Codex CLI, Gemini CLI, Qwen Code, Cline, Goose | Techniques reprises, pas de code embarqué | Évite plusieurs boucles concurrentes |
| DeepSeek Harness / Cordis | Architecture de référence (ADR-001) | Orchestrateur unique |
| LangGraph, CrewAI, Agent Framework, Mastra | Non intégrés | Recouvrent l’orchestrateur ; Python lourd |
| LiteLLM | Non intégré pour l’instant | Le registre de fournisseurs couvre le besoin |
| Superpowers, Spec Kit | Phase 2 : skills (`SKILL.md`) chargées à la demande | Méthodes de travail |
| Langfuse, Phoenix, OpenTelemetry | Phase 3 (export des traces existantes) | La télémétrie locale existe déjà |
| Promptfoo, SWE-bench | Phase 2 : banc d’évaluation local de l’agent | Mesurer les progrès |
| Docker, E2B, Daytona, Firecracker | Non | Trop lourd sur ce poste ; worktrees d’abord |
| Reverse engineering (Ghidra, capa, LIEF...) | Plus tard en MCP | Spécialiste dédié |
| CAO, électronique, jeux | Exclu ici | MCP dédiés ultérieurs |

## Phase 1 (ce lot)

1. Catalogue de capacités et sélection d’outils par tâche.
2. Outils de code : `code.search` (ripgrep), `code.outline` et `code.map` (ast-grep), `fs.patch`.
3. Client MCP (stdio et HTTP) avec gestion dans l’interface.
4. Sous-agents spécialisés via `agent.delegate`.
5. Tests réels (modèle GGUF local), documentation.

## Accès au PC et autorisations (aligné sur Claude Code)

Le contrôle est fait par le Studio avant chaque outil, quel que soit le modèle (local ou API).

- Paramètres, Accès au PC : mode `project` (projet uniquement), `ask` (défaut : un chemin hors du projet déclenche une demande), `full` (tout le PC sans demande).
- Dossiers de confiance (`access.extraRoots`) : accessibles sans demande dans toutes les sessions ; une réponse « Toujours » les complète.
- Dossiers protégés : données du Studio (coffre des clés), `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker` du profil, plus `access.protectedRoots`. Refusés dans tous les modes.
- Session : dossiers ajoutés (équivalent de `/add-dir`, persistés dans la session) et mode d’autorisation `default`, `acceptEdits` (écriture et suppression sans demande), `bypass` (aucune demande). Une permission réglée sur « Refuser » l’emporte toujours.
- Approbations : « Autoriser une fois », « Pour cette session » (catégorie ou dossier), « Toujours » (permission sur « Autoriser » ou dossier de confiance), « Refuser ». Chaque décision est journalisée avec sa portée.
- `terminal.run` accepte `cwd`, soumis aux mêmes règles d’accès.
- Fournisseurs distants : une confirmation par fournisseur, au moment où il est choisi (`ai.remoteAcknowledged`).

## Pièces jointes, skills et connecteurs

- Pièces jointes : bouton trombone, glisser-déposer et collage dans le compositeur (50 Mo par fichier, 20 par message). Le texte extrait (texte, code, PDF, DOCX) est joint à la demande dans le budget `agent.attachmentBudgetChars` ; la suite reste lisible par `attachments.read`. Images et binaires : métadonnées et note explicite.
- Skills : dossiers contenant un `SKILL.md` (front matter `name`, `description`). Sources, dans l’ordre : dossier `skills` du Studio, `.mazz/skills` du projet, `.claude/skills` du projet et `~/.claude/skills` (option `skills.includeClaude`), dossiers de `skills.folders`. Seuls noms et descriptions sont gardés en mémoire.
  - `/nom demande` charge le skill dans la demande (12 000 caractères, suite par `skills.load`).
  - Sinon, avec `skills.autoSuggest`, les 3 skills les plus proches de la demande sont proposés en quelques lignes et `skills.load` est offert.
  - `skills.search` reste disponible via le catalogue d’outils.
- Connecteurs : serveurs MCP avec jeton. Le jeton est chiffré dans le coffre (entrée `mcp:<id>`), jamais écrit dans les paramètres ni renvoyé. HTTP : en-tête `secretName` (Authorization par défaut, préfixe Bearer ajouté) ; stdio : variable d’environnement `secretName`. Modèles : GitHub (HTTP) et connecteur HTTP générique.

## Vision

- Les images jointes (PNG, JPEG, GIF, WebP, 20 Mo maximum, 5 par demande) sont envoyées avec le message de l’utilisateur : parties `image_url` (data URL) pour les API compatibles OpenAI, dont llama.cpp et Gemini ; blocs `image` base64 pour Anthropic. Elles ne sont pas rejouées dans l’historique ni transmises aux spécialistes.
- Support : llama.cpp le déclare dans `/props` (`modalities.vision`) quand un projecteur est chargé (`--mmproj`) ; pour les API, les familles documentées comme multimodales sont reconnues par leur nom (`likelyVisionModel`). Sinon l’image est décrite par son nom et une étape « vision » indique pourquoi elle n’a pas été transmise.
- Model Hub : choix du projecteur (`general.architecture = clip`) au lancement ; un `mmproj*.gguf` situé dans le dossier du modèle est proposé par défaut.

Mesure réelle (i5-6500, 4 threads, SmolVLM2-256M-Video-Instruct Q8_0 + mmproj Q8_0, ggml-org, 279 Mo dans D:\TESSERA\Mgguf\SmolVLM2) : `/props` renvoie `modalities.vision = true` ; texte « MAZZ 42 » lu exactement (1 013 jetons de prompt, 24 s de bout en bout via l’agent, 33,5 tok/s en génération mesurés par le runtime) ; rectangle bleu reconnu depuis l’interface (51 tok/s, 25,8 s). Le cache KV par session fonctionne avec les images (sauvegarde 1 021 jetons en 80 ms).

Restent à faire : connecteurs OAuth (connexion par navigateur).
