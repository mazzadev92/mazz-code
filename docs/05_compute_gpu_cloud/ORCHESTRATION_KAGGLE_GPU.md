# 05 — Calcul GPU : Orchestration Kaggle GPU

## 1. Principe de déploiement d'un kernel serveur

Kaggle met à disposition 30 heures par semaine de GPU NVIDIA T4 (16 Go VRAM) gratuitement. MAZZ Code exploite cette ressource de manière entièrement automatisée :
1. **Génération du script d'amorçage (`serverscript.py`)** : Le script prépare l'environnement sur le kernel Kaggle, télécharge le modèle requis depuis Hugging Face (`votre-repo/mazz-models`) ou le hub public, démarre une instance de `llama-server` compilée pour GPU (CUDA 12), et établit un tunnel Cloudflare éphémère.
2. **Push via le CLI Kaggle** : La passerelle crée un dossier temporaire contenant `server.py` et `kernel-metadata.json`, puis appelle `kaggle kernels push`.
3. **Annonce sécurisée** : Une fois le tunnel actif, le serveur distant écrit un fichier d'annonce signé par HMAC-SHA256 dans le dépôt Hugging Face de synchronisation. La passerelle locale lit l'annonce et enregistre le nouveau backend distant.

## 2. Arrêt automatique et bouton de libération immédiate

- **Garde-fou d'inactivité** : Le serveur Kaggle s'éteint automatiquement s'il ne reçoit aucune requête d'inférence pendant 10 minutes, ou après 60 minutes de temps d'exécution total.
- **Libération immédiate** : Dans l'onglet **Calcul GPU** de l'interface, un bouton « Libérer le GPU » permet d'appeler `POST /compute/providers/kaggle/stop`, coupant instantanément le kernel pour préserver le quota de la semaine.

