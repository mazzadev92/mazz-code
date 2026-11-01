# GUIDE D'INTÉGRATION — MAZZ ÆNGENIUM AGENT STUDIO

Ce guide est destiné à tout agent autonome, script ou développeur recevant le dossier `MAZZ_AGENT_STUDIO` et souhaitant l'utiliser, le piloter ou l'étendre sans intervention manuelle.

---

## 1. Découverte Automatique

Le point d'entrée pour la découverte des capacités est le fichier :
👉 **`AGENT_INTEGRATION_MANIFEST.json`**

Pour les noms et schémas disponibles dans l'instance en cours, la source de vérité est `GET /api/tools` (champ `tools`). Le manifeste distingue les outils du registre `@mazz/tools`, les outils toujours ajoutés par le serveur, les outils Bib1 conditionnels et les outils MCP dynamiques. Les outils `mcp.<serverId>.<toolName>` n'apparaissent dans la réponse qu'après le démarrage du serveur MCP qui les expose; ils sont retirés à son arrêt. `code.search`, `code.outline`, `code.map`, `fs.patch`, `attachments.read`, `skills.search` et `skills.load` sont des outils du registre runtime, pas des noms supposés à partir d'un guide.

Les routes d'intégration des pièces jointes, skills et serveurs MCP sont listées dans `api.endpoints`. Les routes MCP déclarées sont vérifiées contre les routes inscrites par le serveur et le registre d'outils par le test contractuel ciblé :

```powershell
npm --workspace packages/core run build
node --test packages/core/dist/agent-integration-manifest.test.js
```

Pour obtenir un rapport complet sur la machine hôte :
```powershell
node apps/cli/dist/index.js doctor --json
```

---

## 2. Utilisation via CLI

### 2.1 Lister les Outils et Modèles
```powershell
# Liste des outils du registre de base @mazz/tools (sans connecteurs du serveur actif)
node apps/cli/dist/index.js tools --json

# Liste des modèles disponibles (locaux & distants)
node apps/cli/dist/index.js models list --json
```

### 2.2 Exécuter une Tâche de Programmation
```powershell
# Runtime GGUF réellement démarré et projet autorisé
node apps/cli/dist/index.js run --prompt "Crée main.c, compile avec GCC et teste l'exécutable" --workspace "D:\Mazz Code\test-projet" --provider llama-local --base-url http://127.0.0.1:8080/v1 --model local --json

# Exécution avec llama.cpp local
node apps/cli/dist/index.js run --prompt "Refactorise le module" --provider llama-local --model qwen2.5-coder-1.5b --json
```

---

## 3. Utilisation via l'API Locale HTTP & SSE

### 3.1 Démarrer le Serveur
```powershell
node apps/cli/dist/index.js start --port 3333
```
Le serveur expose :
- L'interface web studio sur : `http://127.0.0.1:3333`
- L'API REST & SSE sur : `http://127.0.0.1:3333/api/*`

### 3.2 Lancer une Tâche en Streaming (Server-Sent Events)
Envoyer un `POST` vers `http://127.0.0.1:3333/api/agent/run` avec le corps :
```json
{
  "taskId": "task_custom_101",
  "goal": "Vérifie les fichiers du projet",
  "workspaceRoot": "D:\\Mazz Code",
  "mode": "agent",
  "selection": {
    "providerId": "llama-local",
    "modelId": "local",
    "executionMode": "local_strict",
    "allowedWorkspaceRoots": ["D:\\Mazz Code"]
  }
}
```

Le flux renvoie des événements au format SSE :
```text
data: {"type":"status","stage":"thinking","message":"..."}
data: {"type":"thought","delta":"..."}
data: {"type":"tool_start","toolName":"fs.write","params":{...}}
data: {"type":"tool_result","toolName":"fs.write","success":true,"durationMs":12}
data: {"type":"diff","filePath":"main.c","patch":"..."}
data: {"type":"token","delta":"..."}
data: {"type":"complete","success":true,"durationMs":150}
data: [DONE]
```

---

## 4. Intégration de MUCE

Le pont `packages/muce-bridge` est prêt et n'attend que l'emplacement du dossier MUCE :
1. Renseigner le chemin du dossier MUCE via la variable d'environnement :
   ```powershell
   $env:MAZZ_MUCE_HOME = "D:\chemin\vers\MUCE"
   ```
2. Ou via l'API : `POST /api/muce/configure` avec `{"path": "D:\\chemin\\vers\\MUCE"}`.
3. Le pont inspecte `INTEGRATION_MANIFEST.json`. La présence du manifeste et du CLI ne démontre pas un gain d'accélération.
4. Le runtime réellement sélectionné et son état sont consultables dans `/api/models/server/status`. Une erreur de chargement reste une erreur; aucun résultat de modèle n'est simulé.

## 5. SDK et preuves

Les clients Python standard-library et JavaScript sont dans `integrations/sdk/` avec leurs exemples. Ils utilisent les sessions, le vrai flux SSE et l'annulation du serveur. Aucune clé ni dépendance cloud n'est requise pour llama.cpp local.

`run --base-url` accepte uniquement le loopback en LOCAL STRICT. `--no-knowledge --tools none` lance une conversation sans documents ni outils, avec une génération réelle. `--max-output-tokens` réserve explicitement le budget de sortie. Un échec agent donne un code de sortie non nul.

Les preuves datées de cette machine sont conservées séparément dans `D:\Mazz Code\AUDIT_RUN_2026-10-23`. Les tests unitaires historiques comportant des doubles ne valent pas validation fonctionnelle. Le fichier `RELEASE_DECISION.md` de cet audit reste la décision globale; la présence du SDK ou d'un ZIP ne certifie pas tous les composants.
