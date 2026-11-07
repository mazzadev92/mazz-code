# 05 — Registre technique et dépendances

## 1. Runtimes embarqués et versions

MAZZ Code est totalement autonome et embarque ses propres moteurs d'exécution sans exiger de prérequis sur la machine cible :

| Composant | Version | Rôle & Description | Emplacement embarqué |
| :--- | :--- | :--- | :--- |
| **Node.js** | `24.22.2` (x64) | Moteur d'exécution pour le serveur Studio et les packages TypeScript | `resources/node/node.exe` |
| **Python** | `3.12.10` (embed amd64) | Moteur pour la passerelle FastAPI `mazz_control` et l'orchestration GPU | `resources/python/python.exe` |
| **Electron** | `45.2.3` | Conteneur d'application bureau Windows | Exécutable principal `Mazz Code.exe` |
| **llama.cpp** | Build `b12128` | Serveur d'inférence haute performance en C++ (AVX2 / Vulkan / CPU) | `resources/llama/llama-server.exe` |
| **Cloudflare** | Zero-Trust Quick Tunnel | Outil de tunneling sécurisé sortant TLS sans configuration NAT | `resources/cloudflared/cloudflared.exe` |

## 2. Piles technologiques logicielles

### Front-End (Web & Desktop UI)
- **Framework** : React 19 avec architecture par composants fonctionnels et hooks stricts.
- **Bundler & Outillage** : Vite 6, Rollup avec stratégie de fractionnement dynamique des chunks de syntaxe (CodeMirror).
- **Styles** : Tailwind CSS avec variables CSS natives (`--mazz-*`) pour les thèmes Bioforge Leaf, Blueprint Engineer et Claude Desktop.
- **Éditeur de code** : CodeMirror 6 scindé en modules dynamiques à la demande (`@codemirror/lang-*`, `@lezer/*`), réduisant le poids du bundle principal de 50% (397 Ko).
- **Rendu graphique & Terminal** : Three.js (visualisation 3D), xterm.js (émulation de terminal ANSI avec support Windows ConPTY).

### Back-End & Passerelle
- **Framework API** : FastAPI 0.115+, Uvicorn avec boucle asyncio optimisée.
- **Protocole d'inférence** : Compatibilité Anthropic Messages `/v1/messages` (SSE streaming) et OpenAI Chat Completions.
- **Persistance des données** : SQLite avec mode WAL (`PRAGMA journal_mode=WAL`), transactions ACID et écritures atomiques (fichiers `.tmp` puis renommage).

## 3. Allocation des ports réseau

| Port | Service | Hôte | Authentification |
| :--- | :--- | :--- | :--- |
| **3333** | MAZZ Agent Studio (Serveur Node.js / UI) | `127.0.0.1` | Local seulement |
| **7070** | MAZZ Control Gateway (Passerelle FastAPI) | `127.0.0.1` | Clé secrète `X-Mazz-Key` (`control.key`) |
| **8080** | llama-server local (Modèle principal) | `127.0.0.1` | Clé partagée `llama.key` |
| **8081** | llama-server local (Modèle draft rapide 0.6B) | `127.0.0.1` | Clé partagée `llama.key` |
| **11434** | Ollama (Détection LAN automatique) | `127.0.0.1` | Optionnelle selon configuration |
| **1234** | LM Studio (Détection LAN automatique) | `127.0.0.1` | Optionnelle selon configuration |

