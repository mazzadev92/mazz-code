# Guide Grand Public : Choix des Modeles et Calcul GPU Gratuit

Ce guide explique simplement comment choisir et faire tourner les modeles d'intelligence artificielle de MAZZ Code selon la puissance de votre ordinateur ou grace aux serveurs GPU gratuits dans le cloud, sans depenser un seul centime.

---

## 1. Comment fonctionne l'execution d'un modele ?

Un modele d'IA fonctionne comme un cerveau numerique charge dans la memoire vive (RAM) de votre machine ou sur une carte graphique (VRAM) :
- **Sur votre ordinateur (En Local)** : Le modele tourne directement sur votre processeur (CPU) et votre memoire vive (RAM). Tout reste chez vous, hors ligne, mais les tres gros modeles demandent beaucoup de memoire.
- **Sur un serveur cloud gratuit (Calcul GPU)** : MAZZ Code prete temporairement un ordinateur distant tres puissant equipe d'une carte graphique dediee (GPU). Le calcul se fait a distance via une passerelle securisee, puis le serveur s'eteint automatiquement des que vous avez termine.

---

## 2. Le Calibrage des modeles souverains MAZZ

Vos modeles ont des gabarits tres differents, concus pour repondre a chaque besoin :

| Modele | Poids (.gguf) | Usage principal | En Local (Votre PC) | Sur Kaggle (T4 x2 gratuit) | Sur Google Colab / Modal |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Draft-0.8B** | ~0,8 Go | Brouillon ultra-rapide, petits PC | Des 8 Go de RAM (Immediat) | Compatible (Rapide) | Compatible |
| **Base-4B** | ~2,7 Go | Polyvalent : redaction, code simple | Des 16 Go de RAM (Fluide) | Compatible (Rapide) | Compatible |
| **TitanCoder-32B** | ~19,8 Go | Raisonnement code et chirurgie logicielle | Station 32 a 64 Go de RAM | Limite stricte du disque (~20 Go) | Recommande (50 a 100 Go de disque) |
| **Coder-32B** | ~19,8 Go | Refactoring et appels d'outils | Station 32 a 64 Go de RAM | Limite stricte du disque (~20 Go) | Recommande (50 a 100 Go de disque) |
| **Titan-32B-CoT** | ~19,8 Go | Reflexion scientifique profonde | Station 32 a 64 Go de RAM | Limite stricte du disque (~20 Go) | Recommande (50 a 100 Go de disque) |
| **ApexCoder-70B** | ~42,5 Go | Sommet de la flotte : audits massifs | Inaccessible sur PC standard | Incompatible (Depasse les 20 Go) | Recommande (Colab ou Modal requis) |
| **Vision-Flux** | ~6,8 Go | Generation d'images photorealistes | Page Calcul GPU requise | Compatible | Compatible |
| **Motion-Wan** | ~1,5 Go | Generation de clips video cinematiques | Page Calcul GPU requise | Compatible | Compatible |

---

## 3. Les Fournisseurs Cloud Gratuits : Avec ou Sans Carte Bancaire

### Option A : 100 % Gratuits SANS Carte Bancaire (Recommande pour les Ados et Debutants)

1. **Kaggle (Recommande par defaut)** :
   - **Avantage** : Aucune carte bancaire demandee. Inscription 100 % gratuite.
   - **Puissance** : Carte graphique NVIDIA T4 double (environ 30 heures gratuites par semaine).
   - **Condition obligatoire** : Vous devez valider votre numero de telephone portable par SMS dans votre profil Kaggle (`Settings > Phone Verification`). Sans ce SMS de securite, Kaggle bloque l'acces au GPU et a Internet.
   - **Limite technique** : Le disque dur ephemere de Kaggle est limite a environ 20 Go. Les modeles jusqu'a 19,8 Go (TitanCoder-32B) fonctionnent, mais l'ApexCoder-70B (~42,5 Go) ne peut pas y etre installe.

2. **Google Colab** :
   - **Avantage** : Aucune carte bancaire avec un simple compte Google.
   - **Puissance** : GPU T4 gratuit selon disponibilite ou unites Colab Pro.
   - **Espace disque** : 50 a 100 Go de disque. TitanCoder-32B et ApexCoder-70B y fonctionnent sans contrainte de stockage.

---

### Option B : Avec Carte Bancaire pour Verification d'Identite

3. **Modal** :
   - **Avantage** : Offre 30 dollars par mois de calcul offert (plan Starter), demarrage a la seconde sur des GPU ultra-rapides (L40S / A100).
   - **Attention** : Modal exige un numero de carte bancaire a l'inscription pour verifier que vous etes une personne reelle (lutte contre les robots et les abus).
   - **Securite budgetaire** : Dans la console Modal (`Settings > Usage`), fixez imperativement la limite de depense a 0 $ pour que le service se coupe des que le credit gratuit est consomme, sans jamais prelever votre carte.

---

## 4. Resume pour Bien Demarrer

- **Vous avez un PC portable ou de bureau classique (8 a 16 Go de RAM)** :
  Utilisez en local les modeles **Draft-0.8B** ou **Base-4B**. Ils demarrent en quelques secondes sans rien configurer.
- **Vous voulez utiliser la puissance d'un modele 32B ou 70B sans carte bancaire** :
  1. Creez un compte sur `kaggle.com` et validez votre numero de telephone par SMS.
  2. Telechargez votre fichier `kaggle.json` depuis vos parametres Kaggle (`Settings > API > Create New Token`).
  3. Collez ce fichier dans l'assistant MAZZ ou dans la page Calcul GPU.
  4. Pour l'ApexCoder-70B (42,5 Go), utilisez Google Colab ou Modal car sa taille depasse les 20 Go de Kaggle.
