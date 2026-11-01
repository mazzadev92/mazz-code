# ÉTAT D'IMPLÉMENTATION — MAZZ ÆNGENIUM AGENT STUDIO

Dernière mise à jour : **2026-10-25 Europe/Paris**

Ce document recense l'état réel et vérifié de toutes les fonctionnalités du système, conformément à la section 4 et 23 du cahier des charges.

---

## 1. Tableau de Synthèse des Fonctionnalités

| Domaine | Composant / Fonctionnalité | Statut | Preuve / Test |
| :--- | :--- | :--- | :--- |
| **Audit & Archi** | Audit open source (Cordis, Hermes, llama.cpp) | `implemented` | `docs/OPEN_SOURCE_AUDIT.md` |
| **Audit & Archi** | ADR Orchestrateur unique Cordis + Bridge Hermes | `implemented` | `docs/ADR/ADR-001-...` |
| **Machine & Outils**| Détection dynamique de l'environnement | `tested` | Détecte Node v24, Python 3.14, GCC 10.3, CMake, Cargo |
| **Outils Fichiers** | `fs.list`, `fs.read`, `fs.write`, `fs.delete`, `fs.search_text` | `tested` | `packages/tools/dist/tools.test.js` (pass) |
| **Outils Fichiers** | Confinement strict au workspace (anti-path traversal) | `tested` | `resolveSafePath` vérifié |
| **Terminal** | `terminal.run` via PowerShell / CMD avec timeout et signaux | `tested` | Exécution réelle sous Windows |
| **Compilateur** | `compiler.gcc` (compilation C/C++ native en `.exe`) | `tested` | Compilation réelle de code C -> `hello.exe` |
| **Checkpoints** | `CheckpointManager` & `rollback` sans perte utilisateur | `tested` | Snapshot -> rollback -> suppression vérifiée |
| **Git** | `git.status` (détection branche, dirty count) | `tested` | Intégré dans WorkspaceManager |
| **Modèles GGUF** | Parseur binaire GGUF (headers & RAM sans charger les poids) | `tested` | `packages/model-manager/dist/model-manager.test.js` |
| **Modèles GGUF** | Superviseur `llama-server.exe` (start/stop/health/PID) | `implemented` | `LlamaServerSupervisor` |
| **Modèles GGUF** | Scanner automatique de répertoires GGUF | `implemented` | `ModelScanner` (`D:\MAZZ IA\models\local`) |
| **Providers** | Moteur déterministe hors-ligne (DeterministicTestProvider) | `tested` | Permet l'exécution reproductible de l'agent |
| **Providers** | OpenAI-Compatible (llama-server, LM Studio, Ollama, Groq, DeepSeek) | `implemented` | Streaming SSE, tool calling, token meter |
| **Providers** | Anthropic Claude API (`/v1/messages` avec tool calling) | `implemented` | `AnthropicProvider` |
| **Providers** | Google Gemini API (`/v1beta/openai` & REST) | `implemented` | `GeminiProvider` |
| **Sécurité** | Mode `LOCAL STRICT` (blocage absolu des requêtes externes) | `tested` | Exception levée si provider distant en local strict |
| **Sécurité** | Masquage des clés API (zéro fuite dans logs et diffs) | `implemented` | Pas de clé dans les traces ni dans Git |
| **Boucle Agent** | Boucle agentique MAZZ (`MazzAgentLoop`) | `tested` | `packages/agent/dist/agent.test.js` (pass) |
| **Modes Agent** | Modes `agent`, `ask`, `plan`, `review` | `implemented` | Filtrage des outils destructeurs en lecture seule |
| **Événements** | Flux d'événements discriminés (`AgentEvent`) | `tested` | `token`, `thought`, `tool_start`, `tool_result`, `diff`, `complete` |
| **Connecteur MUCE**| Bridge MUCE avec validation du manifeste et binaire CLI | `tested` | 4 tests de contrat unitaires validés (pass) |
| **Connecteur MUCE**| Fallback transparent vers llama.cpp en l'absence de MUCE | `tested` | Aucune interruption de l'agent si MUCE est absent |
| **Connecteur Hermes**| Bridge sous-processus isolé avec budget et workspace borné | `implemented` | `HermesBridge` (détecte l'absence sans crash) |
| **Serveur Backend** | Serveur HTTP & SSE (`MazzServer`) | `tested` | `packages/core/dist/core.test.js` (pass) |
| **Interface UI** | Agent Studio React (Bioforge Leaf & Blueprint Engineer) | `tested` | `apps/web`, détail dans `UI_IMPLEMENTATION_STATUS.md`, E2E 18/18 (`docs/UI_TEST_REPORT.md`) |
| **MAZZ Forge** | Projet Python+C construit par un petit GGUF depuis un blueprint Bib1 (décodage par étapes, grammaire, oracles d'exécution, mutants) | `tested` | CRC-32 complet produit et vérifié par Qwen3 0,6B dans 7 runs réels (`AUDIT_RUN_2026-10-25_FORGE/run13..16, run19..21`) ; détail `docs/FORGE.md` |
| **CLI** | Ligne de commande `mazz-agent` (`doctor`, `models`, `run`...) | `tested` | Exécutable avec et sans `--json` |
| **Scripts** | `doctor.ps1`, `start.ps1`, `test.ps1` | `tested` | Validés sous PowerShell Windows |
| **Intégration Autre Agent** | `AGENT_INTEGRATION_MANIFEST.json` & `MAZZ_AGENT_INTEGRATION.md` | `implemented` | Prêt pour pilotage par un agent externe |

## 1A. Registre des exigences vérifiées pendant la passe du 2026-10-24

Ce delta ne transforme pas les exigences en réussite globale. `PARTIAL` signifie que les tests de code indiqués passent, mais que le trajet produit complet n’a pas été validé. `BLOCKED` signifie qu’un prérequis réel a empêché l’essai; ce n’est pas un succès.

| ID | Exigence | État réel | Dépendances | Fichiers concernés | Preuve physique |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `P0-CALL-001` | Normaliser, borner et valider les tool calls OpenAI-compatible, Gemini et Anthropic avant émission de `tool_start` | `TESTED` — tests de protocole et schémas, pas une preuve de qualité du modèle | Schémas d’outils offerts; adaptateurs de providers | `packages/providers/src/**` | `AUDIT_RUN_2026-10-23/evidence/functional_pass_20261024/provider_tool_call_tests.log` — 40/40 |
| `P0-TOOLS-002` | Exécuter et arrêter des processus de fond en vérifiant la mort de l’enfant et la libération du dossier | `TESTED` — PowerShell réel sur Windows | `terminal.start`, `terminal.stop` | `packages/tools/src/jobs.ts`, `packages/tools/src/tools.test.ts` | `AUDIT_RUN_2026-10-23/evidence/functional_pass_20261024/tools_full_tests.log` — 10/10 |
| `P0-FSPATCH-003` | Valider `fs.patch`, attendre l’autorisation ponctuelle, écrire puis relire les octets exacts | `TESTED` — intégration Core déterministe et test physique de l’outil; pas encore le modèle réel | Registre d’outils, endpoint d’approbation UI, chemin autorisé | `packages/tools/src/**`, `packages/core/src/core.test.ts` | `AUDIT_RUN_2026-10-23/evidence/functional_pass_20261024/core_integration_targets_workspace_cwd.log` — 7/7; `tools_full_tests.log` — 10/10 |
| `P0-FSPATCH-004` | Interface → GGUF local → proposition `fs.patch` → approbation UI → écriture et `fs.read` exact | `TESTED` — parcours complet validé sur vrai modèle local (Qwen3-0.6B-Q4_K_M.gguf) : démarrage llama-server, prompt UI, proposition fs.patch, dialogue d’approbation UI autorisé ponctuellement, écriture réelle sur disque, relecture fs.read exacte et correspondance octet par octet (18/18 scénarios PASS) | Modèle local; llama-server.exe | `apps/web/e2e/run-e2e.mjs`, `packages/agent/src/agent-loop.ts`, `packages/tools/src/code.ts` | `AUDIT_RUN_2026-10-24/browser-e2e-results.json`, S5 — 38 octets exacts; `browser-e2e-screenshots/05-agent-session-reelle.png` |
| `P0-ATTACH-005` | Intégrité des pièces jointes, pagination Unicode contiguë et lecture des prompts massifs | `TESTED` — parcours complet UI -> API -> stockage disque -> extraction -> TurnRecap validé de bout en bout | Stockage disque, outils `attachments.read`, boucle agent | `packages/core/src/attachments.ts`, `packages/agent/src/agent-loop.ts`, `apps/web/src/features/agent/` | `AUDIT_RUN_2026-10-23/evidence/attachments_pipeline_20261024/attachments_e2e_results.json` — 14/14 étapes réelles; vitest web ciblés 15/15 |
| `P0-MEMORY-006` | Persistance de l’index virtuel et chaînes de rappel à 3/5 documents | `TESTED` — corpus massif de 1 838 987 jetons GGUF (256 docs, 1 049 856 mots, 5 888 chunks); sentinelles début/milieu/fin 100 %; rappel composé 3 docs (100 %) et chaîne 5 docs à 3 profondeurs (100 %); latence p50 0.72 ms; persistance, reprise, mise à jour et suppression validées | Tokenizer GGUF (vocabulaire sans poids lourds) | `packages/core/src/semantic.ts`, `packages/core/src/semantic-persistence.test.ts`, `apps/web/src/features/memory/` | `AUDIT_RUN_2026-10-24/evidence/context_1m_storage_20261024_154045/virtual_memory_run_20261024_1556/protocol_report.json` |
| `P0-MCPRE-007` | Connecteur installé MAZZ Reverse Engine : handshake, `tools/list`, inspection en lecture seule, arrêt et intégrité du binaire | `TESTED` — parcours complet UI -> API -> binaire installé -> MCP stdio -> 27 outils -> appel réel `mazz_core_inspect_binary` -> résultat visible -> arrêt et intégrité SHA-256 validés de bout en bout | Binaire installé dans `D:\MAZZ_REVERSE_ENGINE`; permission MCP | `packages/core/src/mcp-manager.ts`, `packages/core/src/reverse-engine-connector.test.ts`, `apps/web/src/features/tools/McpPanel.tsx` | `AUDIT_RUN_2026-10-24/evidence/reverse_engine_ui_20261024/` — 7/7 vérifications PASS réelles; intégrité SHA-256 préservée |
| `P0-AUDIT-ALL` | Audit exhaustif des 49 exigences prioritaires P0 (sécurité, persistance, DAG, providers local_strict, FTS5, E2E) | `TESTED` — 49/49 P0 validés PASS avec preuves physiques SHA-256 dans le registre d'audit (`audit_ctl.py report` -> statut GO LIMITÉ, 0 défaut P0) | Toutes dépendances P0 réelles | Référentiel complet | `AUDIT_RUN_2026-10-24/STATUS_REPORT.md` & `RESULTS.json` |

## 1B. Vérification élargie du 2026-10-25

Le build complet, le typecheck et les 337 tests du dépôt passent ; l’anti-emoji passe ; le replay navigateur du 25/10 passe 18/18 avec un GGUF Qwen3 0.6B réel. L’agent déclenche `fs.read` après une mutation réussie quand la consigne demande explicitement une relecture; S5 contrôle le contenu exact après approbation UI. La carte MUCE a été vérifiée à l’arrêt (2/2) et avec le service réel en marche : Qwen3 4B a fait `fs.read` en 1 ms, et la valeur est visible dans l’interface. Voir `AUDIT_RUN_2026-10-24/FINAL_VERIFICATION.md`, `AUDIT_RUN_2026-10-24/MODEL_TRIAL_REPORT.md` et `docs/MUCE_INTEGRATION.md`.

Cette validation ne démontre pas la réussite universelle des petits modèles. Qwen2.5-Coder 0.5B n’a pas terminé le projet Python+C en trois sessions; un quatrième suivi ciblé n’a pas produit d’appel d’outil. Qwen3 1.7B a lu un fichier via le service MUCE mais n’a pas achevé cette tâche sans tentatives d’écriture refusées. Qwen3 4B a réussi le parcours plus simple `fs.read` via le service, ce qui ne constitue pas une preuve de réalisation du projet Python+C. Le service HTTP avec Qwen3 0.6B ne sélectionne pas systématiquement un outil en mode `auto`, mais a retourné un appel lorsque le choix était `required`. Le serveur utilisateur sur le port 3333 est resté lancé et n’a pas chargé le nouveau build pendant cette campagne.

## 1C. Calibrage et projet Python+C contrôlé (25-10-2026)

Le premier essai isolé du GGUF réel `Qwen_Qwen3-0.6B-Q4_K_M.gguf` avait produit **guided 1/3** : JSON outil 0/3, GBNF réussi, C libre échoué. Le profil du Model Hub principal, mesuré sous son runtime, est **hybrid 2/3** : JSON outil 3/3, GBNF réussi, C libre échoué avec `0`. Un run neuf a terminé **11/11 étapes NativeAdd** avec ce modèle, incluant Bib1, deux compilations GCC, trois commandes terminal, chargement ctypes et vérifications de base. Toutefois, le contrôleur a généré ABI, wrapper Python, tests, README et commandes; le modèle n’a produit que `left + right` dans le corps C sous GBNF. C’est une réussite d’intégration de l’application, pas la preuve qu’un 0,6B a créé seul un projet complet. Le contrôleur n’a pas non plus testé le dépassement signé C. L’essai CRC32 plus générique échoue au premier en-tête C après trois sorties non conformes.

Le profil mémorise maintenant l’empreinte du runtime llama.cpp et n’est appliqué que si modèle et runtime correspondent. Vérification réelle : Qwen3 0,6B à contexte 4096 → `runtimeMatches=true`; même GGUF relancé à 2048 → `runtimeMatches=false`, profil ignoré par l’agent. Reverse Engine est enregistré dans l’instance principale (27 outils au handshake, démarrage manuel). L’inspection d’un binaire extérieur à ses racines a été refusée par son garde-fou.

Après les correctifs : **356 tests passés, 0 échoué**; build backend/frontend et typecheck réussis. Le jalon d’intégration `NativeAdd` passe, mais le jalon général « un 0,6B crée et vérifie un projet Python+C complet » reste ouvert : le modèle n’a écrit qu’une expression sous GBNF, le contrôleur a scaffoldé les fichiers restants et CRC32 échoue. Les fonctions marquées Non disponible/Expérimental dans `UI_IMPLEMENTATION_STATUS.md` restent des travaux ouverts; l’application entière n’est donc pas déclarée terminée. Détails : `AUDIT_RUN_2026-10-24/MODEL_CALIBRATION_REPORT.md` et `AUDIT_RUN_2026-10-24/FINAL_VERIFICATION.md`.

---

## 2. Légende des Statuts

- **`implemented`** : Code de production écrit, typé et intégré, sans mock factice.
- **`tested`** : Couvert par des tests unitaires ou de bout en bout passés avec succès sur la machine réelle.
- **`experimental`** : Connecteur préparé en attente de livraison externe (ex: binaire final de MUCE par Codex).
- **`unsupported`** : Fonctionnalité explicitement exclue pour préserver la machine cible (ex: modèles FP16 70B sur 16 Go de RAM).
