# Rapport de vérification du Studio

Date de campagne : 25/10/2026. Machine : Windows 11 Pro, Intel Core i5-6500 (4 threads), 16 Go de RAM, Intel HD 530, Node 24.19, Chrome installé et piloté par `playwright-core`. La campagne tourne sur un serveur isolé au port 3350 ; le Studio utilisateur PID 7224 sur 3333 reste lancé.

Les termes **backend** et **modèle réel** distinguent les appels au vrai `MazzServer` des appels effectués avec un GGUF chargé via `llama-server`. Le moteur déterministe sert uniquement aux scénarios de structure, jamais comme preuve de génération ou de vitesse.

## Résultats des vérifications

| Vérification | Résultat |
| :--- | :--- |
| `npm run build` | Réussi ; paquets et interface de production compilés (2 056 modules web) |
| `npm run typecheck` | Réussi ; paquets et interface sans erreur TypeScript |
| `npm test` | 334 tests réussis, 0 échec (8 paquets + Vitest web) |
| `npm run lint:emoji` | Réussi ; aucune emoji dans le code et les libellés contrôlés |
| Campagne navigateur | **18/18 scénarios réussis** |
| Essai du modèle Qwen2.5-Coder 0.5B pour un projet complet | Échec après 3 essais ; détails et traces dans `AUDIT_RUN_2026-10-24/MODEL_TRIAL_REPORT.md` |

## Campagne navigateur

Le JSON détaillé est `AUDIT_RUN_2026-10-24/browser-e2e-results.json`; les captures sont sous `AUDIT_RUN_2026-10-24/browser-e2e-screenshots/`.

| ID | Parcours | Résultat observé |
| :--- | :--- | :--- |
| S1 | Démarrage et endpoints | `/api/health` répond, Studio 1.1.1, workspace isolé |
| S2 | Navigation et disposition | 13 vues, raccourcis clavier et persistance après rechargement |
| S2b | Thèmes | Bioforge/Blueprint, clair/sombre et paramètres persistés |
| S3 | Sessions | Création, renommage, archivage et reprise après rechargement |
| S4a | Model Hub invalide | Fichier absent, signature invalide et GGUF vocabulaire seul refusés en 422 |
| S4 | GGUF réel | Qwen3 0.6B chargé avec le runtime llama.cpp ; serveur prêt en 2 066 ms, puis arrêt propre |
| S5 | Outils avec vrai modèle | `fs.patch` approuvé une fois dans l’UI, modification réelle, puis `fs.read` exact ; contenu disque identique (38 octets) |
| S6 | Télémétrie | tg 17,91 tok/s pour 72 jetons générés ; pp 181,7 tok/s pour 225 jetons d’entrée ; TTFT 1 447 ms sur cet appel |
| S6b | Benchmark à protocole fixe | pp moyen 253,4 tok/s, tg moyen 53,51 tok/s ; Qwen3 0.6B Q4_K_M, contexte 4096, 4 threads, batch 512, pp 133 / tg 32, sans modèle brouillon |
| S7 | Clés API | Ajout, test d’une clé invalide, retrait ; le secret n’apparaît ni dans le DOM, ni dans les réponses, ni dans localStorage |
| S8 | Code et terminal | GCC réel compile avec code 0 ; le retour arrière supprime le fichier créé |
| S9 | Erreurs et accès | Origine étrangère 403, route inconnue 404, dossier invalide 400, déconnexion affichée |
| S10 | Chaînes d’interface | Contrôle anti-emoji réussi |
| S11 | Volume UI | 3 000 lignes en 2 058 ms, 28 lignes conservées dans le DOM par virtualisation, tas JS 15 Mo, 40 sessions listées |
| S12 | Responsive | 4 tailles testées de 1366×768 à 1920×1200, aucun débordement horizontal |
| S13 | Reprise du flux | Rechargement pendant une génération réelle ; tâche poursuivie côté serveur et flux repris |
| S14 | Erreurs JavaScript | Aucune erreur JS non gérée ; une erreur réseau attendue par S9 |

Les mesures S6 et S6b sont propres à cette machine, à ce modèle, à cette configuration et à cette campagne. Elles ne prouvent pas un débit général pour d’autres modèles ou prompts.

## Défauts trouvés et corrigés pendant cette passe

| Défaut | Correction et preuve |
| :--- | :--- |
| Le GGUF local proposait `/patch-target.txt` alors que la demande visait `patch-target.txt` dans le workspace | Normalisation restreinte au cas où retirer un seul slash redonne exactement la cible relative explicitement demandée. Unité ciblée et campagne S5 réelle passées. |
| Après le patch, le modèle 0.6B terminait sans appeler la relecture explicitement demandée ; le contrôle `REREAD_MISSING` bloquait alors la tâche | La boucle ajoute un appel réel `fs.read` après une mutation réussie uniquement quand l’utilisateur demande explicitement la relecture. La réponse, les octets, l’approbation UI et les événements `fs.patch`/`fs.read` ont été vérifiés dans S5. |
| Les libellés de fonctionnalités revendiquaient des preuves antérieures plus larges que la nouvelle campagne | `UI_IMPLEMENTATION_STATUS.md` et ce rapport distinguent désormais les preuves réelles, les tests structurels et les fonctionnalités encore non disponibles. |

## Limites et état de livraison

- L’essai avec Qwen2.5-Coder 0.5B montre que le découpeur produit une file de 12 étapes, mais ne rend pas tous les petits modèles capables de suivre leur étape. Le modèle a ciblé un mauvais fichier puis envoyé à Bib1 des chemins non autorisés ; les deux garde-fous ont bloqué les effets. L’application ne doit donc pas être annoncée comme parfaitement fiable avec n’importe quel modèle ou toute langue.
- La traduction complète est partielle : français, anglais pour la navigation et actions communes, quelques chemins de décomposition espagnols testés. Les langues non testées ne sont pas certifiées.
- Les fonctionnalités signalées **Non disponible** dans `UI_IMPLEMENTATION_STATUS.md` restent hors du trajet testé : wrapper desktop Tauri/Electron, PTY interactif, sélection de hunks et commentaires Git, worktrees/cloud, OAuth, métriques GPU fiables, débit d’embeddings et mémoire étendue AirLLM.
- Aucun compte API valide n’a été fourni ; S7 vérifie le secret et l’échec contrôlé, pas une génération distante réussie.
- L’audit d’accessibilité reste structurel (rôles, focus, clavier). Aucun lecteur d’écran n’a été essayé sur toutes les vues.
- Le serveur existant PID 7224 n’a pas été redémarré afin de préserver la session utilisateur. Le build et l’E2E isolé valident les sources et paquets actuels ; ce processus Node lancé depuis `apps/cli/dist/index.js` devra charger le build courant lors de son prochain redémarrage normal.
- Le dépôt Git n’a encore aucun commit et tous les fichiers du projet sont non suivis. Il n’existe donc pas de base sûre pour attribuer les changements historiques à Antigravity ou reconstituer un diff propre.

## Replay de confirmation du 25/10/2026

Après les derniers changements d'intégration et le rebuild de production, `apps/web/e2e/run-e2e.mjs` a été rejoué dans un serveur isolé sur 3350, avec le modèle réel Qwen3 0.6B et un port de modèle distinct 18103. Résultat : 18/18 scénarios, aucun ignoré ni bloqué, zéro erreur JavaScript. Le rapport exact est `AUDIT_RUN_2026-10-24/browser-e2e-results-20261025.json`; captures : `AUDIT_RUN_2026-10-24/browser-e2e-screenshots-20261025/`.

S5 a de nouveau exécuté l'approbation `fs.patch`, relu avec `fs.read` et confirmé les 38 octets attendus. S13 a rechargé la page pendant une génération réelle, puis repris le flux jusqu'à la fin. Ce replay ne transforme pas le test de patch en preuve de fiabilité universelle des modèles; l'essai de Qwen2.5-Coder 0.5B sur le projet Python+C reste documenté séparément.

