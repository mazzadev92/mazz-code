# 04 — Passerelle : Émulation Anthropic et streaming SSE

## 1. Contrat de l'endpoint `/v1/messages`

La passerelle implémente une émulation stricte du protocole Messages d'Anthropic. Tout outil ou SDK conçu pour Claude peut pointer vers `http://127.0.0.1:7070/v1` et fonctionner sans modification :
- Support du streaming via flux SSE (*Server-Sent Events*).
- Conversion bidirectionnelle des structures de requêtes :
  - `system` (texte ou tableau de blocs) est extrait et converti pour les moteurs compatibles OpenAI.
  - `tools` et `tool_choice` sont traduits vers les formats d'appel de fonction compatibles `llama-server`.
  - Les réponses amont sont réécrites au format `message_start`, `content_block_start`, `content_block_delta`, `message_delta` et `message_stop`.

## 2. Déconnexion propre et libération des slots

Dans les environnements locaux où un seul créneau d'inférence est disponible :
- Si l'utilisateur clique sur « Annuler » ou ferme la fenêtre, la connexion HTTP vers la passerelle est coupée.
- Le générateur asynchrone détecte la déconnexion du client via un handler d'interruption et ferme immédiatement la connexion amont vers `llama-server`.
- Le slot de calcul local est libéré sans délai, évitant de bloquer la passerelle en état occupé (*LocalBusy*).

