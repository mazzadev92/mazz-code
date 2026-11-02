# État d’implémentation de l’interface

Mise à jour : 25/10/2026. Légende : **Implémenté** (code de production), **Connecté** (branché à une API réelle), **Testé** (test automatisé ou E2E passé ; « réel » = avec llama-server et un GGUF réel), **Expérimental**, **Non disponible** (affiché comme tel dans l’interface). Le bilan, les limites et l’essai du modèle local sont détaillés dans `AUDIT_RUN_2026-10-24/FINAL_VERIFICATION.md` et `AUDIT_RUN_2026-10-24/MODEL_TRIAL_REPORT.md`.

| Domaine | Fonction | Statut | Preuve |
| :--- | :--- | :--- | :--- |
| Shell | Barre de titre (projet, branche, moteur, tâches, dispositions) | Implémenté, connecté, testé | E2E S1, S2 |
| Shell | Rail, sidebar, inspecteur, panneau bas, barre d’état | Implémenté, connecté, testé | E2E S2, S12 |
| Shell | Panneaux redimensionnables, double clic, persistance | Implémenté, testé | E2E S2 |
| Shell | Dispositions Focus / Coding / Review / Monitor | Implémenté | manuel |
| Shell | Palette Ctrl+K, raccourcis Alt+1..8, Ctrl+B/J/I | Implémenté, testé | E2E S2 |
| Thèmes | Bioforge Leaf et Blueprint Engineer, sombre et clair | Implémenté, testé | E2E S2b |
| Agent | Mode Forge, tableau Forge en direct (unités, candidats, rejets réels, fichiers écrits), préréglage Forge du Model Hub | Implémenté, testé (vitest) ; parcours réel par l'API serveur | `forge-board.test.tsx`, `ForgePreset.test.tsx` |
| Agent | Fluidité (2026-10-26) : échanges terminés mémoïsés (plus de rendu à chaque fragment), Markdown en flux qui ne réanalyse que le dernier bloc, `content-visibility` hors écran ; ligne d'état vivante (temps écoulé, jetons mesurés, débit estimé), Échap arrête la tâche, messages mis en file pendant l'exécution (rendus au compositeur si la tâche est arrêtée), appels d'outils consécutifs regroupés avec résumé, résultat d'une ligne sur chaque appel, « Réflexion · durée », liste de tâches affichée une seule fois | Implémenté, testé (vitest), vérifié dans le navigateur avec le moteur de test (`scripts/ui-demo-server.mjs`) | `turn-fluidity.test.tsx` |
| Agent | Mode Plan validé puis exécuté (« Exécuter ce plan » bascule en Agent) ; revue d'une écriture de fichier bloc par bloc dans la carte d'approbation (seuls les blocs gardés sont écrits, côté serveur `content` accepté pour `fs.write` uniquement) ; sous-agents (`agent.delegate`) dans leur propre carte avec action en cours, outils et synthèse ; sessions en arrière-plan : « Attend votre accord » et point de résultat non consulté dans la barre latérale ; fin de tâche onglet masqué : titre de l'onglet et notification si déjà autorisée ; diffs repliés au-delà de 3 fichiers ; apparition animée des cartes (respecte le mouvement réduit) | Implémenté, testé (vitest, test agent), vérifié dans le navigateur (revue partielle : fichier réel contrôlé) ; le modèle ne sait pas qu'un bloc a été écarté, sauf s'il relit le fichier | `turn-fluidity.test.tsx`, `agent-loop.test.ts` |
| Thèmes | Contraste élevé, densité, zoom, taille du code, animations | Implémenté | manuel |
| i18n | Français complet, anglais pour la navigation et les actions communes | Partiel | `lib/i18n.ts` |
| Accueil | Diagnostic réel, actions rapides, reprise, activité | Implémenté, connecté, testé | E2E S1 |
| Accueil | Assistant de première configuration (4 étapes) | Implémenté, connecté | manuel |
| Agent | Streaming, Markdown sûr, coloration, blocs de code (copier, enregistrer) | Implémenté, testé réel | tests web et providers ; S5 avec Qwen3 0.6B dans la campagne réelle du 25/10 |
| Agent | Appels d’outils, diffs, checkpoints, restauration | Implémenté, testé réel | tests agent/core ; S5 valide approbation UI, patch, fs.read exact et octets disque |
| Agent | Approbations contextualisées, délai, audit | Implémenté, testé réel | manuel, tests core |
| Agent | Annulation, télémétrie partielle | Implémenté, testé réel | tests providers, manuel |
| Agent | Reprise après rechargement ou coupure SSE | Implémenté, testé réel | E2E S13 |
| Agent | Modes Ask / Plan / Agent / Review (filtrage backend) | Implémenté, testé | tests agent |
| Agent | Mentions @fichier, modèles de demande, historique, brouillons | Implémenté | manuel |
| Agent | Éditer et relancer, relancer, copier, export MD/JSON | Implémenté | manuel |
| Agent | Pièces jointes, glisser-déposer, collage et extraction texte | Implémenté, testé | tests core et web ; `attachments.read` vérifie les pages contiguës et leur intégrité |
| Agent | Mode Auto et sous-agents spécialistes | Implémenté, testé | modes Agent/Auto et `agent.delegate` ; tests agent et core |
| Sessions | Persistance, recherche, filtres, renommage, épinglage, duplication, archivage, suppression | Implémenté, testé | E2E S3 |
| Sessions | Tâches concurrentes avec limite, une tâche par session | Implémenté, testé | tests core |
| Projets | Ouverture (navigateur intégré, dialogue Windows), récents | Implémenté, connecté | E2E |
| Projets | Worktrees Git, exécution cloud | Non disponible | affiché |
| Code | Explorateur paresseux, recherche, badges Git, menu contextuel | Implémenté, testé | E2E S8 |
| Code | Éditeur CodeMirror (onglets, Ctrl+S, recherche, comparaison, conflits) | Implémenté, testé | E2E S8 |
| Code | Index lexical/sémantique, mises à jour incrémentales et analyse d’impact | Implémenté, connecté, testé | `/api/semantic`, `code.index`, tests core/tools ; recherche lexicale reste disponible sans modèle d’embeddings |
| Code | Ouvrir dans VS Code | Implémenté | requiert `code` dans le PATH |
| Code | Navigation symbolique, minimap | Non disponible | |
| Terminal | Exécution streamée, annulation, codes retour, onglets, export | Implémenté, testé | E2E S8, S11, tests core |
| Terminal | PTY interactif | Non disponible | affiché dans le terminal |
| Git | Statut, diff unifié et côte à côte, indexation, annulation, commit, historique | Implémenté, connecté | manuel |
| Git | Sélection de hunks, commentaires | Non disponible | |
| Modèles | Bibliothèque, scan, métadonnées exactes (paramètres, KV) | Implémenté, testé réel | tests model-manager, E2E S4 |
| Modèles | Estimation RAM et blocage mémoire insuffisante | Implémenté, testé | E2E S4 |
| Modèles | Démarrage / arrêt llama-server, journal, capacités runtime | Implémenté, testé réel | E2E S4, S4b |
| Modèles | Calibrage du GGUF actif; appel JSON répété 3 fois, GBNF, continuation C; profil persistant avec résumé et aperçu borné | Implémenté, UI réelle vérifiée sur Qwen3 0,6B (Hybride 2/3; tool call 3/3; continuation C observée `0`) | `AUDIT_RUN_2026-10-24/MODEL_CALIBRATION_REPORT.md`; E2E NativeAdd historique sous Guided |
| Modèles | Test d’inférence avec tg, pp, TTFT | Implémenté, testé réel | manuel |
| Fournisseurs | Coffre DPAPI, ajout, test, retrait, personnalisés | Implémenté, testé | E2E S7, tests core |
| Fournisseurs | Mode local strict appliqué par le backend | Implémenté, testé | tests providers d’origine |
| Fournisseurs | Coût estimé | Non disponible | tarifs non vérifiés : volontairement absent |
| Télémétrie | tg / pp / TTFT par source, live glissant, partiel | Implémenté, testé réel | E2E S6, tests shared |
| Télémétrie | RAM système, working set llama-server, CPU | Implémenté, testé réel | E2E S4 |
| Télémétrie | Débit d’embeddings | Non disponible | |
| Télémétrie | GPU (charge, VRAM) | Non disponible | aucune source fiable |
| Performance | Temps réel, historique, export JSON/CSV, benchmarks | Implémenté, testé réel | E2E S6, S6b |
| Performance | Schémas d’outils compacts, préfixe système stable | Implémenté, mesuré réel | docs/PERF_OPTIMISATIONS.md |
| Performance | Cache KV par session sur disque (slots llama.cpp) | Implémenté, testé, mesuré réel | tests core, E2E S4, scripts/measure-agent-cache.mjs |
| Performance | Profil matériel, auto-réglage des threads (llama-bench) | Implémenté, mesuré réel | docs/PERF_OPTIMISATIONS.md |
| Performance | Décodage spéculatif (modèle brouillon) | Expérimental | aucun gain mesuré sur CPU 4 cœurs |
| Agent | Validation stricte et normalisation des arguments d’outils | Implémenté, testé | tests tools |
| Git | Message de commit proposé par le modèle auxiliaire | Implémenté | Paramètres, IA |
| MUCE | Cycle d’états, manifeste réel v1, commandes hardware / backends / benchmark | Implémenté, testé | tests muce-bridge, manuel |
| MUCE | Profil runtime (ngram-mod, poll, priorité, reasoning off, cache KV configurable) | Implémenté, testé | `docs/MUCE_INTEGRATION.md` contient des mesures par modèle et tâche ; aucun gain universel n’est garanti |
| MUCE | Service MUCE 8098 : démarrage, fournisseur local, batch/cache KV/reasoning transmis, télémétrie mémoire et latence d'outil réel affichée, arrêt propre | Implémenté, testé réel | `docs/MUCE_INTEGRATION.md`; HTTP officiel et trajet agent Studio → MUCE vérifiés avec limites propres à chaque modèle |
| MUCE | Analyseur de modèle (muce_analyze.py) au chargement | Implémenté, testé réel | manuel |
| MUCE | Extended Memory Engine (AirLLM) | Non disponible | plan seulement côté MUCE ; llama.cpp lit en mmap au-delà de la RAM |
| Outils | Outils internes avec permission et politique | Implémenté, connecté | manuel |
| Outils | Pont Hermes (détection, délégation) | Expérimental | adaptateur préliminaire |
| Outils | Serveurs MCP (stdio, HTTP) | Implémenté, testé | tests core |
| Outils | Skills au format SKILL.md (Studio, .mazz/skills du projet, skills Claude Code, dossiers ajoutés) ; outils skills.search et skills.load ; suggestion automatique ; /nom-du-skill dans le compositeur ; création et lecture dans l’interface | Implémenté, testé | tests core (skills) |
| Outils | Connecteurs MCP avec jeton (en-tête HTTP ou variable d’environnement), jeton chiffré dans le coffre DPAPI | Implémenté, testé | tests core (connecteurs) |
| Agent | Vision : images jointes transmises aux modèles multimodaux (OpenAI et compatibles, Anthropic, Gemini, llama.cpp avec projecteur mmproj) ; raison affichée quand elles ne le sont pas | Implémenté, testé réel | SmolVLM2 256M Q8_0 + mmproj : « MAZZ 42 » lu, rectangle bleu reconnu via l’interface ; tests providers, core, model-manager |
| Modèles | Choix du projecteur multimodal (mmproj) au lancement, proposé s’il est à côté du modèle, compté dans l’estimation RAM | Implémenté | manuel |
| Outils | Connecteurs OAuth (connexion par navigateur), plugins Cordis / DeepSeek Harness | Non disponible | jeton personnel en attendant |
| Agent | Pièces jointes dans le compositeur : bouton, glisser-déposer, collage ; texte, code, PDF, DOCX extraits ; images et binaires en métadonnées ; affichées sur les messages | Implémenté, testé | tests core (pièces jointes), manuel |
| Permissions | Écriture, suppression, commandes, Git, réseau ; audit | Implémenté, testé | tests core, tests agent |
| Accès au PC | Modes projet / sur demande / complet ; dossiers de confiance ; dossiers protégés (données du Studio, .ssh, .gnupg, .aws, .azure, .kube, .docker, liste utilisateur) ; même contrôle pour modèles locaux et API | Implémenté, testé | tests tools (accès), E2E |
| Accès au PC | Demande d’accès hors projet : une fois, pour la session (dossier ajouté à la session), toujours (dossier de confiance) | Implémenté | manuel |
| Autorisations | Portées « une fois », « pour la session », « toujours » sur toutes les approbations ; « Refuser » l’emporte toujours | Implémenté | manuel |
| Sessions | Mode d’autorisation par session (Standard, Accepter les modifications, Sans confirmation) et dossiers de session | Implémenté | manuel |
| Fournisseurs | Confirmation d’un fournisseur distant une seule fois, au choix du modèle ; révocable | Implémenté | manuel |
| Télémétrie | Débit client non affiché si la fenêtre de réception est inférieure à 250 ms (rafales des API rapides) | Implémenté, testé | tests shared, providers |
| Mémoire | Inventaire réel des données et effacement par catégorie | Implémenté, connecté | manuel |
| Mémoire | Index lexical/sémantique des dossiers configurés | Implémenté, connecté, testé | `SemanticIndexCard`, `/api/semantic/*`, tests de recherche et persistance ; embeddings facultatifs, mode lexical explicite disponible |
| Paramètres | 11 catégories, recherche, validation serveur, reset par section | Implémenté, testé | E2E S2b, tests core |
| Sécurité | Garde d’origine et d’hôte, CSP, confinement des chemins | Implémenté, testé | tests core, E2E S9 |
| Qualité | Zéro emoji | Testé | `npm run lint:emoji` |
| Desktop | Application empaquetée (Desktop App Shell) | Implémenté, connecté | apps/desktop, LANCER_MAZZ_STUDIO.bat |
