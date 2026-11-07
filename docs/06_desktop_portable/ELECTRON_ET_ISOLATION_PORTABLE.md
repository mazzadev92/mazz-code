# 06 — Desktop & Portable : Electron et isolation portable

## 1. Confinement et drapeau `portable.flag`

Lorsqu'un fichier `portable.flag` est détecté à la racine du dossier de l'application (ou à côté de `Mazz Code.exe`) :
- **Profil Chromium redirigé** : Electron stocke son cache de rendu, ses données locales et ses paramètres dans `data/electron/` au lieu du dossier utilisateur Windows `%APPDATA%/Mazz Code`.
- **Données Studio confinées** : Le serveur `@mazz/core` et la passerelle `mazz_control` redirigent `MAZZ_HOME` et `MAZZ_DATA_DIR` vers le sous-dossier `data/` local.
- **Zéro trace sur la machine hôte** : L'application peut être déplacée sur une clé USB et utilisée sur n'importe quel PC Windows 10/11 sans laisser de résidus dans la base de registre ou dans le profil utilisateur local.

## 2. Cycle de vie et gestion des processus

Le script principal Electron (`main.mjs`) supervise l'arborescence des processus :
1. Au lancement, vérification de la disponibilité des ports 3333 et 7070.
2. Démarrage du sous-processus Node.js (`resources/node/node.exe`) exécutant le backend Studio.
3. Démarrage de la passerelle Python (`resources/python/python.exe`) exécutant le bytecode compilé `gateway/app.pyc`.
4. Ouverture de la fenêtre principale une fois le signal de santé émis.
5. À la fermeture de la fenêtre, émission d'un signal `SIGINT` ordonné, attente de la libération des ressources et fermeture forcée des processus orphelins éventuels.

