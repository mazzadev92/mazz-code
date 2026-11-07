# 01 — Harness : Garde-fous et moteur d'édition de code

## 1. Moteur d'édition chirurgicale (`fs.patch`)

L'agent manipule le code source via un moteur d'édition déterministe qui rejette toute hallucination de contexte :
- **Recherche exacte du bloc cible (`Target`)** : Le remplacement n'est appliqué que si la chaîne cible correspond exactement au texte existant (espaces, retours à la ligne CRLF/LF).
- **Vérification d'occurrence unique** : Si un bloc cible apparaît plusieurs fois de manière ambiguë sans contexte suffisant pour le discriminer, le moteur refuse l'édition et signale l'ambiguïté au modèle.
- **Remplacement atomique** : Les modifications sont calculées en mémoire, validées par un diff unifié, puis écrites atomiquement sur le disque.

## 2. Sauvegardes de sécurité et retour en arrière (Checkpoints & Rollback)

Chaque modification appliquée par l'agent génère un point de restauration :
- Avant d'écrire sur le disque, l'état précédent du fichier est archivé dans le cache de session.
- L'utilisateur dispose à tout moment d'un bouton « Annuler » dans l'interface pour restaurer l'état exact antérieur au tour de l'agent.
- En cas d'échec de compilation ou d'erreur signalée par les tests, l'agent peut lui-même déclencher un rollback pour revenir à une version saine avant de retenter une approche différente.

