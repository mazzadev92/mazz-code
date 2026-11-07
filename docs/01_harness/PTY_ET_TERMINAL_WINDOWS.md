# 01 — Harness : PTY et Terminal sous Windows

## 1. Contexte et problématique ConPTY

Sous Windows, l'exécution d'un terminal interactif au sein d'une application Electron ou web nécessite une couche d'émulation de pseudo-terminal (PTY) compatible avec les flux ANSI/VT100 et les particularités de PowerShell et CMD.

MAZZ Code s'appuie sur le sous-système Windows ConPTY via `@mazz/tools` et `xterm.js` :
- Création de sessions interactives avec dimensionnement adaptatif (`resize` colonnes/lignes).
- Transmission fluide des frappes de clavier et des signaux de contrôle (`Ctrl+C`, `Ctrl+D`).
- Capture des flux de sortie standard (`stdout`) et d'erreur (`stderr`) avec décodage UTF-8 natif.

## 2. Confinement par Windows Job Object

Pour éviter que des processus fils (compilations, serveurs locaux de développement, scripts Python) continuent de tourner en tâche de fond après l'annulation d'une tâche ou la fermeture de l'application :
1. Chaque commande lancée via `terminal.run` ou `terminal.start` est assignée à un **Job Object Windows** (`CreateJobObjectW`).
2. Le drapeau `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` est appliqué systématiquement.
3. À la fermeture du handle parent, Windows termine instantanément l'arborescence complète des processus associés.

## 3. Sécurité de l'environnement d'exécution

Avant l'exécution de toute commande :
- Les variables d'environnement contenant des jetons d'authentification (`HF_TOKEN`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `KAGGLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MAZZ_CONTROL_KEY`) sont retirées de la copie d'environnement injectée au processus enfant.
- Le répertoire de travail (`cwd`) est validé pour s'assurer qu'il réside bien au sein du projet courant ou d'un chemin autorisé par l'utilisateur.

