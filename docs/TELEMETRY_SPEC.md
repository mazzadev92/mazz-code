# Spécification de la télémétrie d’inférence

Code de référence : `packages/shared/src/telemetry.ts` (formules pures, partagées backend et interface), `packages/providers/src/telemetry-recorder.ts` (enregistrement par appel), tests `packages/shared/src/telemetry.test.ts` et `packages/providers/src/providers.test.ts`.

## 1. Principe

Chaque appel de modèle produit un enregistrement `InferenceTelemetry` porté par l’événement `usage`. Chaque grandeur est accompagnée de sa **source** :

| Source | Signification |
| :--- | :--- |
| `runtime_timings` | Compteurs et durées mesurés par llama.cpp (`timings` du dernier fragment SSE ou de `/completion`) |
| `provider_usage` | Jetons déclarés par un fournisseur distant (`usage`) |
| `client_estimate` | Calcul côté Studio à partir de l’horloge et des fragments reçus |
| `synthetic` | Moteur de test déterministe : aucune mesure |
| `unavailable` | Grandeur non mesurable : affichée « N/D », jamais 0 |

Priorité : `runtime_timings` > `provider_usage` > `client_estimate`.

## 2. Définitions

- **tg_tok_s (génération)** : jetons de sortie par seconde de décodage. Source runtime : `predicted_per_second` de llama.cpp, qui divise par les pas de décodage réellement chronométrés (le premier jeton est échantillonné à la fin du prefill). Repli si absent : `predicted_n / (predicted_ms / 1000)`.
- **pp_tok_s (prompt)** : jetons d’entrée traités par seconde de prefill : `prompt_per_second` (repli `prompt_n / (prompt_ms / 1000)`). Les jetons servis par le cache de prompt (`cache_n`) ne sont pas recomptés : un second appel dans la même session peut n’avoir que quelques dizaines de jetons « nouveaux ».
- **TTFT** : `firstTokenAt - startedAt`, mesuré par le Studio, de l’envoi de la requête au premier fragment de sortie (texte, raisonnement ou appel d’outil).
- **Durée totale (e2e)** : `endedAt - startedAt`.
- **Estimation client** (API ou serveur sans `timings`) : `(n - 1) / (lastTokenAt - firstTokenAt)` où `n` est le nombre de jetons déclarés par le fournisseur ; elle inclut le réseau et porte la mention « estimation ».
- **Sans aucun compteur** : le débit est calculé en *fragments* par seconde, `tokenSource = unavailable`, avec une note explicite (un fragment peut contenir plusieurs jetons).
- **Débit live** : fenêtre glissante (`performance.rollingWindowSec`, 3 s par défaut) sur les horodatages serveur des fragments : `(k - 1) / (t_dernier - t_premier)` sur les `k` fragments de la fenêtre. Libellé « live, estimation ». Pendant la génération d’un appel d’outil, des événements `progress` (au plus toutes les 300 ms) alimentent la même fenêtre. À la fin de l’appel, la valeur runtime remplace l’estimation.
- **pp pour une API** : jamais calculé (non observable de l’extérieur).
- **Embeddings** : `embedding_input_tok_s` n’est pas mesuré dans cette version ; aucune valeur n’est affichée.

## 3. Mémoire

| Grandeur | Source | Libellé |
| :--- | :--- | :--- |
| RAM système totale / disponible | `os.totalmem()` / `os.freemem()` (GlobalMemoryStatusEx) | « RAM système » |
| Mémoire du processus llama-server | `tasklist /FI "PID eq n"` (working set) | « mesurée (working set) » |
| Serveur Studio | `process.memoryUsage().rss` | « Serveur Studio (RSS) » |
| Estimation avant chargement | poids (taille du fichier) + cache KV f16 `2 x couches x têtes_kv x (dim_k + dim_v) x 2 octets x contexte` + 300 Mo | « estimation (calculée depuis l’en-tête, non mesurée) » |
| GPU | `Win32_VideoController` (nom, pilote) | aucune jauge : télémétrie GPU non disponible |

Échantillonnage système : à la demande, mis en cache 1 s côté serveur, interrogé toutes les `performance.metricsIntervalSec` secondes (3 s par défaut) et suspendu lorsque l’onglet est masqué.

## 4. Benchmarks

`POST /api/bench/run` (llama-server prêt, aucune tâche agent en cours) :
- prompt construit à la longueur demandée et vérifiée avec `/tokenize` du modèle chargé ;
- `/completion` avec `cache_prompt: false`, `temperature: 0`, `seed: 42`, `ignore_eos: true` (exactement N jetons générés) ;
- 1 à 5 répétitions, moyennes de pp et tg ;
- clé de méthodologie `modèle | ctx | threads | batch | pp | tg` : l’interface ne compare que des résultats de clé identique ;
- working set de llama-server mesuré après la série.

## 5. Isolation des mesures

- Une mesure est liée à son `taskId`, sa `sessionId`, son fournisseur et son modèle ; la configuration runtime (contexte, threads, batch, quantification) est jointe pour llama.cpp.
- Après une reconnexion SSE, le client rejoue les événements depuis l’index reçu : aucune mesure n’est dupliquée ni mélangée.
- Une génération interrompue produit un enregistrement `partial: true`, `stopReason: aborted` ; elle reste visible avec le badge « partiel ».

## 6. Contrôle de cohérence

Les timings du runtime ne sont acceptés que si `prompt_ms + predicted_ms` reste inférieur à 1,2 fois la durée mesurée par le Studio plus 500 ms. Sinon ils sont ignorés et une note l’indique (cas réel observé : `prompt_ms = 40 621 731` après éviction du cache). Les jetons repris du cache (`cache_n`) sont affichés à côté des jetons d’entrée.

## 7. Limites connues

- Le débit live dépend de la granularité du flux du serveur (llama.cpp émet un fragment par jeton ; d’autres serveurs peuvent regrouper).
- `ttftMs` inclut la mise en file éventuelle côté serveur.
- Le working set Windows ne compte pas la mémoire partagée de façon exclusive ; il peut différer de la mémoire « privée ».
- Les mesures de benchmark sont sensibles à la charge CPU concurrente ; l’interface bloque le benchmark pendant une tâche agent mais pas les autres applications.

## 8. Valeurs mesurées pendant la recette (i5-6500, 16 Go)

| Modèle | Contexte | pp (tok/s) | tg (tok/s) | Source |
| :--- | :--- | :--- | :--- | :--- |
| Qwen3 0.6B Q4_K_M | 4096 | 155,7 (20 jetons) | 21,3 (7 jetons) | timings llama.cpp, test direct |
| Qwen3 0.6B Q4_K_M | 4096 | 222,9 (moyenne) | 23,7 (moyenne) | benchmark pp133 / tg32, 2 répétitions |
| Qwen3 1.7B Q4_K_M | 8192 | 58,3 | 5,3 | timings llama.cpp, tâche agent avec 3 appels d’outils |
