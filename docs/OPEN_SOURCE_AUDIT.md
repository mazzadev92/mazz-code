# OPEN SOURCE AUDIT — MAZZ ÆNGENIUM AGENT STUDIO

Audit réalisé le **2026-10-21** conformément à la section 2 du cahier des charges `PROMPT_ANTIGRAVITY_MAZZ_AGENT_STUDIO.md`.

---

## 1. Fondations Principales

### 1.1 DeepSeek Harness (`dsh`) / Cordis Meta-framework
- **Dépôt officiel** : [https://github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- **Version inspectée / épinglée** : `@deepseek-ai/dsh` v0.2.1-rc.2 / `@deepseek-ai/cordis` ~4.0.5
- **Licence** : Apache-2.0 / MIT
- **Composants adoptés & réutilisés** :
  - Architecture d'orchestration "Everything is a plugin" basée sur Cordis (`Context`, `Service`, injection de dépendances).
  - Registry des outils avec validation de schémas.
  - Cycle de session et propagation des événements typés (`stream`, `tool_call`, `diff`, `status`).
  - Système de permissions et garde-fous de workspace.
- **Raison de l'adoption** : Fournit une isolation propre sans couplage monolithique ; permet d'ajouter nos plugins MAZZ (gestionnaire GGUF, connecteurs Cloud, bridge Hermes) sans forker de code opaque.
- **Incompatibilités identifiées** : Certains sous-plugins natifs requièrent un environnement POSIX ou bash persistant. Adaptation nécessaire pour Windows x64 natif avec PowerShell / ConPTY.
- **Risque & Coût d'intégration** : Modéré. Encapsulation dans `integrations/cordis` et `packages/core`.
- **Tests** : Tests unitaires de cycle de vie et tests d'injection de services.

---

### 1.2 Hermes Agent — Nous Research
- **Dépôt officiel** : [https://github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- **Licence** : MIT
- **Composants adoptés & réutilisés** :
  - Système de mémoire procédurale et dynamique (Skills réutilisables).
  - Spécification des schémas d'outils et concepts de délégation sous-agent.
  - Client API OpenAI-compatible pour exposition d'Hermes comme service isolé.
- **Stratégie d'intégration** : **Bridge externe isolé** (`packages/hermes-bridge`). Aucun couplage intempestif des runtimes Python et Node.js. Hermes est invoqué via sous-processus borné avec budget strict et workspace délimité.
- **Raison de l'adoption** : Enrichit MAZZ avec la capacité d'auto-amélioration et de compétences sans mettre en péril la boucle d'agent principale.
- **Risque** : Conflit de décision ou double boucle d'exécution si exécuté en concurrence. Résolu par la règle d'or architecturale : **Un seul chef d'orchestre actif (Cordis)**.

---

### 1.3 llama.cpp / llama-server
- **Dépôt officiel** : [https://github.com/ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp)
- **Licence** : MIT
- **Composants adoptés & réutilisés** :
  - Runtime GGUF haute performance sur CPU Windows (AVX2/FMA sur Intel Core i5-6500).
  - Serveur HTTP local compatible API `/v1/chat/completions` et tool calling.
  - Parsing rapide des headers GGUF sans chargement complet des tenseurs en RAM.
- **Raison de l'adoption** : Indépendance totale vis-à-vis du cloud ; fonctionne en CPU-only sur la machine cible (16 Go DDR4, i5-6500).
- **Incompatibilités** : Les modèles 7B+ en FP16 dépassent les 16 Go de RAM de la machine hôte ; priorité aux quantifications Q4_K_M / Q3_K_S et aux petits modèles (1B–3.8B, ex. Qwen2.5-Coder, SmolLM2, Llama-3.2-3B).

---

## 2. Outils Système & Connecteurs

### 2.1 Compilateur C/C++ Hôte (TDM-GCC 64)
- **Emplacement détecté sur le système** : `C:\TDM-GCC-64\bin\gcc.exe`
- **Statut** : Opérationnel. Utilisé par l'outil `compiler.gcc` pour les scénarios de compilation C/C++ native sous Windows.

### 2.2 Shell & Terminal Windows (PowerShell / cmd)
- **Emplacement détecté** : `powershell.exe`
- **Composant** : Outil de terminal natif avec streaming stdout/stderr, limitation de timeout et codes de retour.

### 2.3 SQLite & FTS5
- **Licence** : Public Domain
- **Raison** : Stockage local sans daemon de la mémoire projet, des sessions d'agent, des checkpoints de fichiers et de l'index textuel rapide sans imposer une base vectorielle lourde.

### 2.4 Model Context Protocol (MCP)
- **Licence** : MIT
- **Raison** : Protocole standardisé de connexion aux outils et serveurs locaux ou distants.

---

## 3. Matrice de Compatibilité et Décisions

| Composant | Statut dans MAZZ | Mode d'intégration | Risque |
| :--- | :--- | :--- | :--- |
| **Cordis Core** | Adopté comme socle | Package `packages/core` + plugin tree | Faible |
| **Hermes Agent** | Module complémentaire optionnel | Bridge IPC / HTTP isolé (`packages/hermes-bridge`) | Faible (isolé) |
| **llama.cpp** | Moteur local primaire | Processus supervisé + parseur GGUF | Faible |
| **APIs Cloud** | Support multi-providers natif | Adaptateurs directs sans fuite de secrets | Faible |
| **MAZZ UI** | Bioforge Leaf & Blueprint | React + TypeScript + Tailwind v4 + tokens MAZZ | Faible |
