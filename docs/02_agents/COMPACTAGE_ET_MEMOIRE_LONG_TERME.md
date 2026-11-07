# 02 — Agents : Compactage et mémoire long terme

## 1. Problématique du débordement de contexte

Au fil d'une session de développement comportant de nombreux tours, la taille totale des échanges peut dépasser la fenêtre de contexte maximale allouée au modèle (souvent 8k à 32k jetons sur les modèles locaux).

Pour éviter l'épuisement de la mémoire ou la dégradation des capacités de raisonnement :
- Une session est automatiquement compactée dès qu'elle franchit le seuil configuré (`compactAfterTurns`, par défaut 12 tours non résumés).
- Un modèle de résumé (ou le modèle actif) extrait les faits essentiels, les fichiers créés ou modifiés, les décisions d'architecture prises et les tâches restant à accomplir.
- Les anciens tours sont archivés et remplacés dans l'historique prompté par un bloc `<context_summary>`, libérant jusqu'à 80% de la fenêtre active.

## 2. Persistance du cache KV par session

Pour accélérer la réactivité lors de la reprise d'une conversation existante :
- Le cache KV (*Key-Value Cache*) généré par `llama-server` pour le préfixe de la session est sauvegardé sur disque sous forme de snapshot binaire (`.kv`).
- Lors du tour suivant, le cache est rechargé en mémoire sans recalculer l'intégralité du prompt (mesure réelle : 13,9 s de pré-remplissage ramenés à 0,37 s pour 1 516 jetons).

