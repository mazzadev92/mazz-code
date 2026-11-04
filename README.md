# MAZZ ÆNGENIUM — Agent Studio

> **Environnement de développement et d'ingénierie logicielle agentique autonome pour Windows.**  
> Boucle agentique TypeScript MazzAgentLoop, runtime GGUF local via llama.cpp, pont Hermes détecté selon leur disponibilité. L'inspiration DeepSeek/Cordis ne signifie pas que ce framework externe est chargé.

---

## 1. Vue d'Ensemble

**MAZZ ÆNGENIUM — Agent Studio** propose une interface et des outils d'ingénierie logicielle pilotables par l'utilisateur ou un agent. Les fonctions disponibles et leurs limites doivent être vérifiées sur le runtime sélectionné :
- **Fichiers & Projets** : inspection, lecture, écriture atomique, calcul de diffs unifiés et restauration par checkpoints.
- **Compilateur Natif C/C++** : détection et utilisation de GCC (`C:\TDM-GCC-64\bin\gcc.exe`) pour compiler et tester du code natif sous Windows.
- **Terminal Windows** : exécution sécurisée de scripts PowerShell et CMD avec timeout, capture stdout/stderr et signaux d'annulation.
- **Gestionnaire GGUF** : analyse rapide des fichiers modèles quantifiés (architecture, quantisation, contexte, estimation de la mémoire vive) sans charger les poids en RAM, et supervision de `llama-server.exe`.
- **Calibrage local** : trois sondes du GGUF chargé déterminent un profil autonome, hybride ou guidé; profils persistants et appliqués à la sélection des outils. Aucun réentraînement des poids.
- **Connecteurs Multi-Fournisseurs** : support local strict (offline), llama.cpp, LM Studio, Ollama, ainsi que les APIs distantes (Google Gemini, Groq, DeepSeek, Anthropic Claude, OpenAI).
- **Pont Hermes Agent** : intégration dans un sous-processus isolé pour compétences complémentaires sans boucles de récursion.

Les SDK Python/JavaScript sont dans `integrations/sdk/`. La distribution locale se construit avec `scripts/package.ps1`; Node.js, Python/Bib1 et le runtime GGUF restent des prérequis externes. Aucun modèle supplémentaire n'est installé par le packaging.

Audit réel du 23 octobre 2026 : `D:\Mazz Code\AUDIT_RUN_2026-10-23\RELEASE_DECISION.md`. Les preuves GUI, compilation C, tokenizers GGUF et sécurité sont datées dans ce dossier. **L'audit global est encore ouvert** : un test local réussi ne valide pas toutes les capacités annoncées.

Le calibrage et le test réel Qwen3 0,6B Python+C sont détaillés dans `AUDIT_RUN_2026-10-24/MODEL_CALIBRATION_REPORT.md`; le bilan backend/frontend et ses fonctions encore non disponibles sont dans `AUDIT_RUN_2026-10-24/FINAL_VERIFICATION.md` et `UI_IMPLEMENTATION_STATUS.md`.

---

## 2. Démarrage Rapide

### 2.1 Diagnostic de l'Environnement (Doctor)
Vérifiez immédiatement les compilateurs et outils installés sur votre PC :
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\doctor.ps1
```

### 2.2 Lancer l'Application Studio (Web & API)
Démarre le serveur local et ouvre l'interface utilisateur dans votre navigateur :
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```
L'interface est accessible sur : **`http://127.0.0.1:3333`**.

### 2.3 Compiler et tester
```powershell
npm install
npm run build        # paquets (ordre des dépendances), CLI, interface React
npm run typecheck
npm test             # tests des paquets + tests de l'interface
npm run lint:emoji   # aucun emoji dans le code et l'interface
npm run test:e2e     # campagne E2E dans Chrome/Edge installé (modèle réel si disponible)
npm run dev:web      # interface en développement sur 127.0.0.1:5173 (proxy /api vers 3333)
```
`scripts\test.ps1` reste disponible pour les seuls tests des paquets.

### 2.4 Documentation de l'interface
- `docs/INTERFACE_USER_GUIDE.md` : guide d'utilisation et raccourcis
- `docs/UI_ARCHITECTURE.md` : architecture, contrats REST/SSE, sécurité, stockage
- `docs/DESIGN_SYSTEM.md` : jetons, thèmes Bioforge Leaf et Blueprint Engineer, composants
- `docs/TELEMETRY_SPEC.md` : définitions de tg, pp, TTFT, sources et limites
- `docs/UI_TEST_REPORT.md` et `docs/e2e-results.json` : preuves de tests, captures dans `docs/screenshots/`
- `UI_IMPLEMENTATION_STATUS.md` : implémenté, connecté, testé, expérimental ou non disponible
- `docs/UI_REDESIGN_AUDIT.md` : audit avant refonte

---

## 3. Utilisation de la Ligne de Commande (CLI)

```powershell
# Afficher l'aide
node apps/cli/dist/index.js --help

# Diagnostiquer la machine
node apps/cli/dist/index.js doctor

# Lister les outils machine disponibles
node apps/cli/dist/index.js tools

# Lister les modèles disponibles
node apps/cli/dist/index.js models list

# Exécuter une tâche de programmation réelle de bout en bout
node apps/cli/dist/index.js run --prompt "Crée main.c, compile-le avec GCC et vérifie son exécution"
```

---

## 4. Structure du Projet

```text
MAZZ_AGENT_STUDIO/
├── README.md                          # Présentation et guide de démarrage
├── IMPLEMENTATION_STATUS.md           # Tableau d'état réel des fonctionnalités
├── AGENT_INTEGRATION_MANIFEST.json    # Manifeste machine pour les autres agents
├── MAZZ_AGENT_INTEGRATION.md          # Manuel d'intégration externe
├── apps/
│   ├── cli/                           # CLI exécutable mazz-agent
│   └── web/                           # Interface React (Vite, Tailwind, CodeMirror), servie par le core
├── packages/
│   ├── shared/                        # Types, contrats et événements discriminés
│   ├── tools/                         # Outils réels (fs, terminal, compiler, git, checkpoints)
│   ├── providers/                     # Moteur déterministe, llama.cpp, Gemini, Claude, Groq...
│   ├── model-manager/                 # Parseur de headers GGUF, RAM estimate, llama-server
│   ├── agent/                         # Boucle d'exécution agentique (Ask, Plan, Agent, Review)
│   ├── core/                          # Serveur HTTP/SSE, sessions, paramètres, coffre de clés, terminal, Git
│   └── hermes-bridge/                 # Pont isolé vers Hermes Agent
├── scripts/
│   ├── doctor.ps1                     # Script de diagnostic Windows
│   ├── start.ps1                      # Lanceur de l'application
│   └── test.ps1                       # Exécuteur des tests unitaires
└── docs/
    ├── OPEN_SOURCE_AUDIT.md           # Audit open source approfondi
    └── ADR/                           # Décisions d'architecture
```

---

## 5. Spécifications Matérielles Cibles

- **Machine hôte testée** : Windows 11 Professionnel x64, Intel Core i5-6500 (4 cœurs, 4 threads @ 3.20 GHz), 16 Go DDR4, iGPU Intel HD Graphics 530.
- **Ressources contrôlées** : Tous les outils et parseurs respectent le plafond de RAM disponible en évitant les surcharges mémoires intempestives.
