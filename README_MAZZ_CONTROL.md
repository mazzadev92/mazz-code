# MAZZ CONTROL :: Passerelle Universelle et Supervision GPU

Système de pilotage local et distant pour les modèles Mazz Technos, compatible OpenAI API (`/v1/chat/completions` et `/v1/models`).

---

## 1. Principes Fondamentaux

1. **Une Seule URL pour Toutes Vos Applications :**
   - **Tableau de Bord Web :** [http://127.0.0.1:7070](http://127.0.0.1:7070)
   - **Endpoint d'Inférence OpenAI :** `http://127.0.0.1:7070/v1`
   - Dans Mazz Code ou tout agent IA, configurez un fournisseur OpenAI pointant sur cette adresse. Vous n'aurez plus jamais à changer d'adresse.

2. **Accès Local Strict aux Outils :**
   - Que le modèle tourne sur votre CPU local (i5-6500) ou sur un GPU Kaggle (Tesla T4 16 Go), **les outils du harnais s'exécutent TOUJOURS chez vous en local**.
   - Le modèle distant ne reçoit que le texte et émet des structures JSON d'appels d'outils (`tool_calls`).
   - Votre machine locale lit les fichiers, désassemble, compile et renvoie la réponse au modèle. Vos disques et outils restent sécurisés en local.

3. **Auto-Stop Réglable contre l'Épuisement du Quota :**
   - Kaggle fournit 30 heures de GPU par semaine (remise à zéro le samedi à 00:00 UTC).
   - Avant de lancer une session GPU, choisissez la durée d'inactivité maximale (15 min, 30 min, 60 min).
   - Si aucune requête n'arrive pendant ce délai, le serveur distant s'éteint automatiquement et coupe le compteur.
   - Dès la coupure, la passerelle locale bascule automatiquement sur votre modèle local en moins de 90 secondes sans faire planter votre application.

4. **Stockage et Sauvegarde des Modèles (Hugging Face) :**
   - Vos modèles sont sauvegardés dans votre dépôt privé : `https://huggingface.co/mazz92/mazz-models`.
   - Le jeton est stocké de manière chiffrée/sécurisée dans `%USERPROFILE%\.mazz\env`. Aucun secret n'est écrit dans le code.

---

## 2. Démarrage Rapide

Pour lancer le serveur et ouvrir l'interface :
```powershell
& "d:\Mazz Code\mazz_control\start_mazz_control.bat"
```
Puis ouvrez votre navigateur sur : [http://127.0.0.1:7070](http://127.0.0.1:7070)

---

## 3. Configuration dans Mazz Code (Fournisseur OpenAI)

| Paramètre | Valeur à renseigner |
| :--- | :--- |
| **Type de fournisseur** | `OpenAI Compatible` |
| **Base URL** | `http://127.0.0.1:7070/v1` |
| **Clé API** | `mazz-local` (n'importe quelle valeur non vide) |
| **Modèles détectés** | `Mazz-Technos-Code-3B.IQ4_XS`, `Mazz-Technos-Chat-2B`, `Mazz-Technos-Base-4B` |
