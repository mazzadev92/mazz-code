# POLITIQUE DE CONFIDENTIALITÉ
## MAZZ ÆNGENIUM AGENT STUDIO

**Date de mise à jour :** 11 novembre 2026  
**Éditeur :** Eren Tipirdamaz (Mazz ÆNGENIUM)  

---

### 1. PRINCIPE CARDINAL : ZÉRO TÉLÉMÉTRIE, ZÉRO COLLECTE
L'application **MAZZ ÆNGENIUM Agent Studio** est conçue selon le principe de la stricte souveraineté locale des données :
- **Aucune télémétrie** : Aucun identifiant d'appareil, aucune statistique d'usage, aucun journal d'activité n'est envoyé à l'éditeur.
- **Aucun compte éditeur** : Vous n'avez pas besoin de créer de compte auprès de MAZZ pour utiliser l'application.
- **Aucun tracking** : L'interface ne comporte aucun traceur, pixel publicitaire ou script analytique tiers.

---

### 2. STOCKAGE STRICTEMENT LOCAL SUR VOTRE MACHINE
Toutes vos données résident exclusivement sur votre ordinateur dans votre profil utilisateur Windows (`%USERPROFILE%\.mazz`) ou dans le dossier local `./data` (en mode portable `portable.flag`) :
- **Clés API et Jetons** : Chiffrés au repos à l'aide de l'infrastructure cryptographique du système d'exploitation (**Windows DPAPI**). Elles sont indéchiffrables en dehors de votre session Windows.
- **Sessions, Prompts et Code** : Stockés dans votre base de données locale SQLite WAL (`tasks.db`).
- **Modèles de langage (GGUF)** : Stockés dans le répertoire de votre choix sur vos disques locaux.

Vous pouvez supprimer l'intégralité de ces données à tout moment depuis **Paramètres > Données > Purger** ou en désinstallant l'application.

---

### 3. SERVICES DISTANTS ET TIERS CHOISIS PAR L'UTILISATEUR
Lorsque vous activez volontairement un service d'inférence distant (Hugging Face, Kaggle, Modal, Groq, NVIDIA NIM, etc.) :
- Seuls les messages, prompts ou fichiers nécessaires à la requête d'inférence sont transmis directement entre votre ordinateur et le serveur du prestataire choisi.
- Ces transmissions sont régies par la politique de confidentialité de chaque fournisseur respectif. L'éditeur de MAZZ n'intercepte, ne relaie et ne stocke aucune de ces transmissions.

---

### 4. EXPOSITION RÉSEAU ET TUNNEL CLOUDFLARE
Par défaut, l'application écoute exclusivement sur les interfaces locales (`127.0.0.1` et `localhost`).
Si vous activez explicitement le drapeau `--tunnel` (via `cloudflared`), vous exposez volontairement votre passerelle d'inférence à internet : celle-ci reste alors protégée par votre jeton maître `X-Mazz-Key` généré localement.

---

### 5. PROTECTION DES MINEURS
L'application s'adresse aux personnes âgées de 15 ans et plus. L'utilisation par un mineur de 13 à 14 ans requiert la supervision et le consentement parental.
