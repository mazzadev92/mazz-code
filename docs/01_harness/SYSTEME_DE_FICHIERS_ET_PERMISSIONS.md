# 01 — Harness : Système de fichiers et permissions

## 1. Confinement au projet (Sandbox d'espace de travail)

Par défaut, l'agent opère dans une prison logique définie par la racine du projet (`projectRoot`) :
- Tout chemin relatif est résolu par rapport à `projectRoot`.
- Tout chemin absolu est vérifié pour s'assurer qu'il est un descendant strict de `projectRoot` ou de l'un des `extraRoots` explicitement déclarés par l'utilisateur dans les réglages de la session.
- Les tentatives de franchissement (`../..`, liens symboliques pointant vers des dossiers système) sont détectées et bloquées immédiatement avec une erreur `SecurityBlock`.

## 2. Écritures atomiques et résistance aux arrêts brutaux

Pour éviter la corruption de données en cas de coupure de courant, de plantage ou de fermeture forcée de l'application :
1. Les fichiers modifiés sont écrits dans un fichier temporaire adjacent (`<nom>.tmp`).
2. Les données sont purgées sur le disque (`fsync`).
3. Le fichier temporaire remplace le fichier cible par une opération atomique de renommage (`os.replace` / `fs.rename`).
4. Aucun fichier à moitié écrit ou tronqué ne peut résulter d'une interruption inopinée.

