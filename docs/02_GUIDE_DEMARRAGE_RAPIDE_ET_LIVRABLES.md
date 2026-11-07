# 02 — Guide de démarrage rapide et livrables

## 1. Les deux formes de distribution livrées

Le projet génère deux livrables distincts répondant à des cas d'usage précis :

### 1.1 Version publique d'installation (`Mazz-Code-1.2.0-Setup.exe`)
- **Emplacement** : `D:\Mazz Code\build\desktop\output\Mazz-Code-1.2.0-Setup.exe`.
- **Nature** : Installeur standard Windows NSIS autonome.
- **Destinataire** : Tout utilisateur public ou développeur tiers.
- **Politique de confidentialité** : Vierge de toute donnée personnelle, compte, clé API ou configuration privée.
- **Contenu embarqué** :
  - Runtime Node.js 24.22.2 (64 bits).
  - Runtime Python 3.12.10 embarqué avec dépendances pré-compilées en bytecode `.pyc` sans code source clair.
  - Binaire serveur `llama-server.exe` (build b12128).
  - Binaire Zero-Trust `cloudflared.exe`.
  - Bundle Studio minifié et compilé dans une archive `app.asar`.

### 1.2 Version portable privée (`Mazz Code Portable`)
- **Emplacement** : `D:\Mazz Code\Mazz Code AE\Mazz Code Portable\`.
- **Nature** : Répertoire complet autonome, exécutable directement depuis un disque local ou une clé USB sans aucune installation.
- **Destinataire** : Le propriétaire du projet (Mazz / utilisateur).
- **Contenu personnalisé** :
  - `portable.flag` : force l'application à écrire toutes ses données dans le sous-dossier `data\` du répertoire au lieu de `%APPDATA%`.
  - `data/modal.toml` : profil Modal Labs configuré pour le compte `mazzadev92`.
  - `data/kaggle.json` : profil et jeton API Kaggle pour le compte `utilisateur`.
  - `data/portable.env` : configuration du dépôt privé Hugging Face (`votre-repo/mazz-models`).
  - `models/` : dossier réservé aux fichiers de modèles `.gguf`. Aucun modèle lourd n'est pré-embarqué de force ; l'utilisateur y dépose librement les modèles de son choix.

## 2. Procédure de premier lancement

### En version portable :
1. Ouvrez le dossier `Mazz Code Portable`.
2. Double-cliquez sur `Mazz Code.exe` (ou utilisez le lanceur scripté `Lancer MAZZ.cmd` depuis la racine de `Mazz Code AE`).
3. L'application initialise en moins de deux secondes :
   - Le serveur Node.js sur le port 3333.
   - La passerelle Python sur le port 7070.
   - Le scan automatique des ports locaux pour détecter Ollama (11434), LM Studio (1234) ou vLLM (8000).
4. Déposez vos fichiers de modèles `.gguf` dans le dossier `models/`. Rendez-vous dans la section **Modèles** de l'interface pour les activer d'un clic.

### En version installeur :
1. Exécutez `Mazz-Code-1.2.0-Setup.exe`.
2. Suivez l'assistant d'installation Windows.
3. Au premier lancement, l'écran d'accueil vous propose un diagnostic matériel complet et la saisie optionnelle de vos clés de fournisseurs.

## 3. Matrice de commande et raccourcis

| Raccourci | Action | Contexte |
| :--- | :--- | :--- |
| `Ctrl + K` | Palette de commandes globale | Partout |
| `Ctrl + Entrée` | Soumettre l'instruction à l'agent | Zone de saisie |
| `Échap` | Annuler la tâche en cours ou fermer la modale | Partout |
| `Ctrl + S` | Enregistrer le fichier en cours d'édition | Vue Code |
| `Ctrl + Shift + F` | Recherche textuelle dans tout le projet | Vue Code / Explorateur |

