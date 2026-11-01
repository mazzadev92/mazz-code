# Propositions d’évolution — MAZZ Code / Agent Studio

Classées par impact pour un usage quotidien sur i5-6500 / 16 Go, puis pour faire de MAZZ Code un produit d’entreprise. Chaque idée indique ce qu’elle demande côté backend (B) et interface (F).

## 1. Priorité haute : rendre l’agent nettement plus efficace sur CPU

Statut au 22/10/2026 : idées 1 à 6 réalisées et mesurées, voir `docs/PERF_OPTIMISATIONS.md` (le décodage spéculatif est disponible mais sans gain mesuré sur i5-6500 ; la grammaire de chemins a été écartée au profit d’une validation stricte).

1. **Réduction du prompt d’outils** (B) : sur CPU, les ~1 200 jetons de définitions d’outils coûtent 8 à 20 s de prefill à chaque étape. Proposer des schémas compacts, un sous-ensemble d’outils par mode, et réutiliser le cache de prompt de llama.cpp en gardant le préfixe système stable (déjà partiellement observé : 56 jetons recalculés au 2e appel).
2. **Slots et cache KV persistants par session** (B) : `--slot-save-path` de llama.cpp pour sauvegarder et restaurer le cache d’une session ; reprise instantanée d’une longue conversation.
3. **Profils matériels automatiques** (B+F) : détecter cœurs physiques, AVX2, RAM libre et proposer threads / batch / contexte optimaux ; un mini-benchmark de 20 s choisit le meilleur réglage (même méthodologie que la page Benchmarks).
4. **Routage local intelligent** (B+F) : petit modèle (0.6B) pour les tâches simples (résumé, nommage de session, messages de commit), modèle plus grand pour le code ; règles visibles dans Fournisseurs.
5. **Décodage spéculatif** (B) : llama.cpp accepte un modèle brouillon (`-md`) ; Qwen3 0.6B comme brouillon de Qwen3 4B peut augmenter tg ; mesure avant/après dans Benchmarks.
6. **Grammaire JSON pour les appels d’outils** (B) : contraindre la sortie des petits modèles (GBNF) pour éliminer les chemins absolus ou arguments invalides observés avec 0.6B.

## 2. Agent et outils

7. **Outils d’édition ciblée** : `fs.patch` (remplacement par recherche/remplacement ou diff unifié) au lieu de réécrire le fichier complet ; diffs plus petits et moins de jetons.
8. **Outil `code.search` avec ripgrep** embarqué : recherche rapide et bornée dans les gros dépôts.
9. **Client MCP réel** (B+F) : lancement des serveurs stdio/HTTP, liste des outils, permissions identiques aux outils internes ; la section MCP de l’interface est déjà prête à afficher l’état.
10. **Mode Plan exécutable** : le plan produit en mode Plan devient une liste d’étapes cochables, exécutées une par une en mode Agent avec checkpoint par étape.
11. **Sous-agents bornés** : délégation d’une sous-tâche (tests, revue) à une seconde boucle avec budget de jetons et de temps, affichée comme une carte imbriquée.
12. **Worktrees Git par session** : chaque session agent dans son propre worktree, fusion explicite à la fin ; supprime les conflits entre tâches concurrentes.
13. **Exécution des tests ciblés** : détection du framework (node:test, vitest, pytest, ctest) et relance des tests impactés par les fichiers modifiés, résultats dans un onglet « Tests » du panneau bas.
14. **Hooks de projet** : commandes avant/après tâche (formatage, lint, build) configurables par projet, avec résultats dans l’activité.

## 3. Mémoire et contexte

15. **Index sémantique local du code** : embeddings via llama-server `--embeddings` (petit modèle bge/nomic), index HNSW sur disque, outil `code.semantic_search` ; mesure réelle du débit d’embeddings (comble le N/D actuel).
16. **Compression de contexte** : résumé automatique des anciens tours quand la fenêtre dépasse 70 %, visible et réversible dans l’inspecteur.
17. **Fichier de règles projet** (`MAZZ.md`) injecté dans le prompt système, éditable depuis Projets.
18. **Mémoire de projet explicite** : faits validés par l’utilisateur (« ce projet compile avec CMake »), jamais extraits silencieusement.

## 4. Interface et expérience

19. **Application desktop** (Tauri, ~10 Mo) : fenêtre native, barre de titre Windows, icône de la planche Bioforge, démarrage automatique du serveur, notifications système ; l’interface web actuelle reste utilisable telle quelle.
20. **Présence Tessera animée** : intégrer le `TesseraPresenceController` de Mazz Laef (SVG, états thinking / tool / memory / error) dans la barre de titre et le composer, piloté par les vrais événements de la boucle. Coût : SVG + CSS, compatible HD 530.
21. **Écran de démarrage « germination »** : graine, pousse, feuille (Mazz Laef `Germinate`, 900 ms, désactivé si animations réduites).
22. **Vue « Mission control »** : toutes les sessions actives en grille avec débit, étape et approbations en attente.
23. **Revue de modifications** : écran dédié listant tous les diffs d’une tâche, avec acceptation ou rejet par fichier, puis commit pré-rempli.
24. **Terminal PTY** via ConPTY (`node-pty`) : shells interactifs réels, en plus du mode commande actuel.
25. **Graphe de tâche** : chronologie horizontale des étapes (appel modèle, outils, approbations) avec durées, pour comprendre où part le temps.
26. **Thème « Atelier Champagne »** (clair chaud pour impression et présentations) et export PDF d’une session.
27. **Traduction anglaise complète** et choix de langue des réponses de l’agent.

## 5. Entreprise MAZZ

28. **Profils et espaces d’équipe** : paramètres partagés par projet (fichier `.mazz/settings.json` versionné), clés restant personnelles (DPAPI).
29. **Journal d’audit exportable et signé** : export JSONL avec empreinte SHA-256 pour la traçabilité des actions de l’agent.
30. **Politiques administrateur** : verrouillage du mode local strict, liste blanche de commandes, interdiction de certains fournisseurs.
31. **Catalogue interne de modèles** : manifeste des GGUF validés par l’entreprise (hash, licence, benchmarks de référence sur le matériel cible).
32. **Rapports de performance comparatifs** : export d’un rapport HTML aux couleurs MAZZ (benchmarks à méthodologie identique, machine, versions).
33. **Intégration TESSERA** : TESSERA comme fournisseur (API locale) et partage de la mémoire de connaissances entre les deux produits.
34. **Intégration MUCE** : dès que le manifeste déclare la génération GGUF, activer le comparatif automatique llama.cpp / MUCE à paramètres identiques (l’interface affiche déjà le cycle d’états).
35. **Mises à jour signées** : canal de mise à jour local (fichier ou dépôt interne) sans service cloud obligatoire.

## 6. Qualité et sécurité

36. **Sandbox des commandes** : exécution dans un Windows Job Object (limites CPU/RAM, arrêt de l’arbre de processus) pour les commandes lancées par l’agent.
37. **Liste blanche de commandes par projet** avec approbation « toujours pour ce projet » mémorisée.
38. **Audit d’accessibilité outillé** (axe-core dans la campagne E2E) et test avec NVDA.
39. **Tests de charge longue durée** : session de 200 tours, mesure mémoire du navigateur et du serveur.
40. **Signature des checkpoints** et stockage des contenus volumineux hors JSON (fichiers dédupliqués par hash).
