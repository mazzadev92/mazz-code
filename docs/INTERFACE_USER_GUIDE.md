# Guide d’utilisation du Studio

## Démarrer

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

Le script installe les dépendances et compile si nécessaire, démarre le serveur sur `http://127.0.0.1:3333` et ouvre le navigateur dès qu’il répond. `Ctrl+C` arrête le serveur et llama-server proprement.

## Premier lancement

L’accueil affiche l’assistant de configuration (facultatif, « Passer » à tout moment) :
1. **Mode de calcul** : Local strict (aucune requête externe), Hybride, ou API.
2. **Moteur local** : choisissez l’exécutable `llama-server.exe` détecté (PATH, paramètres, dossier MUCE) ou parcourez le disque.
3. **Premier modèle** : ajoutez un `.gguf` existant ; seuls ses en-têtes sont lus, le fichier n’est ni copié ni déplacé.
4. **Terminer** : chargez le modèle dans le Model Hub ou ajoutez une clé API.

Le panneau « État du système » signale ce qui bloque (aucun modèle, llama-server absent, pas de clé, mémoire insuffisante) avec un bouton « Résoudre ».

## Disposition

- **Rail gauche** : pages principales (survol = nom et raccourci).
- **Barre latérale** : sessions (vues Agent, Accueil, Sessions) ou explorateur de fichiers (vues Code, Git).
- **Inspecteur droit** : activité des outils, fichiers modifiés, mesures, contexte et points de restauration de la session active.
- **Panneau bas** : terminal, journal llama-server, journal d’audit.
- **Barre d’état** : backend, état de l’agent, moteur, débit live ou dernière mesure, RAM, CPU, MUCE, mode d’exécution et permissions. Chaque zone est cliquable.
- **Dispositions** (barre de titre) : Focus, Coding, Review, Monitor. Glissez les séparateurs pour redimensionner ; double clic pour revenir à la taille par défaut. Les tailles sont mémorisées.

## Travailler avec l’agent

1. Choisissez le **mode** : Ask (questions, lecture seule), Plan (plan d’action), Agent (lecture, écriture, terminal, compilation selon vos permissions), Review (revue en lecture seule).
2. Choisissez le **modèle** : badge Local (calcul sur la machine), API (distant) ou Test (moteur déterministe, aucune mesure).
3. Écrivez la demande. `@` cite un fichier du projet, l’icône livre propose des modèles de demande, flèche haut rappelle les demandes précédentes. `Entrée` envoie, `Maj+Entrée` va à la ligne.
4. Pendant l’exécution : étapes, appels d’outils (déplier pour voir arguments, stdout, stderr), diffs, demandes d’autorisation (« Autoriser une fois » ou « Refuser »). « Arrêter » interrompt la tâche.
5. Après : « Restaurer » sur le point de restauration remet les fichiers dans l’état d’avant la tâche. Les actions de message permettent de copier la réponse, modifier et relancer la demande.

Une tâche continue côté serveur si la page est rechargée ou la connexion coupée ; la conversation reprend là où elle en était.

Avec un modèle Qwen3, ajoutez `/no_think` à la demande pour désactiver le raisonnement long (plus rapide sur CPU).

## Sessions et projets

- **Projets** : ouvrez un dossier (navigateur intégré ou dialogue Windows). Chaque session garde le dossier de sa création.
- **Sessions** : recherche, filtres (état, projet, moteur), renommage (double clic sur le titre), épinglage, duplication, archivage, export Markdown ou JSON, suppression avec confirmation. La page Sessions liste aussi les tâches en cours et permet de les arrêter.

## Code, terminal et Git

- **Code** : arborescence chargée dossier par dossier (les dossiers lourds comme `node_modules` restent repliés), recherche de fichiers, onglets, `Ctrl+S` pour enregistrer (point de restauration quotidien créé automatiquement, conflit signalé si le fichier a changé sur le disque), « Comparer » pour voir le diff avant enregistrement, « Ouvrir dans VS Code ».
- **Terminal** (`Ctrl+J`) : PowerShell 5.1, PowerShell 7 ou cmd. Chaque commande est un processus non interactif : sortie en direct, code retour, durée, `Ctrl+C` pour annuler, plusieurs onglets, export.
- **Git** : modifications indexées et non indexées, diff unifié ou côte à côte, indexer, retirer, annuler (avec confirmation), commit, historique.

## Modèles locaux

Page **Modèles** : ajoutez un fichier ou scannez un dossier. Pour chaque modèle : architecture, nombre exact de paramètres, quantification, contexte d’entraînement, estimation RAM. « Charger » ouvre les réglages (contexte, threads, appel d’outils `--jinja`, réglages avancés) avec l’estimation mémoire comparée à la mémoire disponible ; le démarrage est bloqué si la mémoire manque (« Forcer » possible). Une fois chargé : mémoire réellement mesurée, temps de chargement, capacités exposées par le runtime, **Test d’inférence** avec tg, pp et TTFT mesurés.

## Fournisseurs API

Page **Fournisseurs** : saisissez une clé (elle n’est jamais réaffichée, seul un indice comme `gsk_••••abcd` l’est), testez la connexion, retirez-la. Ajoutez un point de terminaison compatible OpenAI (vLLM, LocalAI...). En mode Local strict, l’exécution distante reste bloquée par le serveur. En mode Hybride, une confirmation est demandée avant chaque envoi vers une API (désactivable).

## Performance

- **Temps réel** : débit live, RAM, CPU, mémoire de llama-server.
- **Historique** : toutes les mesures avec leur source, graphique tg/pp, export JSON ou CSV.
- **Benchmarks** : protocole fixe (prompt mesuré, cache désactivé, N jetons exacts) ; comparaison uniquement à méthodologie identique.
- **Diagnostic des sources** : définition de chaque grandeur.

## Permissions

Paramètres, Permissions : pour l’écriture, la suppression, les commandes, Git et les fournisseurs distants, choisissez Demander, Autoriser dans le projet ou Refuser. Le serveur applique ces règles quel que soit le mode. Toutes les décisions sont dans le journal d’audit (panneau bas).

## Raccourcis

| Raccourci | Action |
| :--- | :--- |
| `Ctrl+K` | Palette de commandes |
| `Ctrl+Maj+N` | Nouvelle session |
| `Ctrl+B` / `Ctrl+J` / `Ctrl+I` | Barre latérale / panneau bas / inspecteur |
| `Ctrl+,` | Paramètres |
| `Alt+1` à `Alt+8` | Accueil, Agent, Sessions, Projets, Code, Git, Modèles, Performance |
| `Ctrl+S`, `Ctrl+F` | Enregistrer, rechercher (éditeur) |
| `Ctrl+C` | Annuler la commande du terminal |

## Données

Toutes les données sont locales : `%APPDATA%\MAZZ_AGENT_STUDIO`. La page **Mémoire** liste ce qui est enregistré (sessions, mesures, benchmarks, points de restauration, audit, paramètres, clés chiffrées) avec la taille et un bouton d’effacement par catégorie.
