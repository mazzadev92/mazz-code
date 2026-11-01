# Optimisations de l’agent sur CPU (feuille de route, idées 1 à 6)

Machine : Intel Core i5-6500 (4 cœurs, AVX2, FMA), 16 Go, llama.cpp b1-7775ffb (runtime fourni par MUCE 0.1.0). Mesures réelles, reproductibles avec `node scripts/measure-agent-cache.mjs` (résultat brut : `docs/agent-cache-measurements.json`).

## 1. Prompt d’outils réduit et préfixe stable

- **Schémas compacts** (`packages/agent/src/tool-profile.ts`, paramètre Agents > Définitions d’outils) : descriptions courtes, descriptions de paramètres conservées seulement si le nom est ambigu. Noms, types, énumérations et champs requis inchangés.
- **Préfixe stable** : le prompt système est identique pour toutes les tâches ; le mode et le nom du projet passent dans le message utilisateur (`formatUserMessage`). L’historique rejoue ces messages à l’octet près, pour que le cache KV corresponde.
- Le chemin absolu du projet n’est plus envoyé au modèle (il incitait Qwen3 0.6B à produire des chemins absolus).

| Mesure (Qwen3 0.6B, contexte 4096) | Avant | Après |
| :--- | :--- | :--- |
| Jetons du préfixe système + 8 outils | 1 073 | 788 (-27 %) |
| Prefill du préfixe à froid | 6 037 ms | 3 544 ms |
| Nouvelle tâche d’une autre session (préfixe en cache) | recalcul complet | 17 à 20 jetons, 249 à 257 ms |

## 2. Cache KV par session sur disque

`packages/core/src/kv-cache.ts`. llama-server est lancé avec `--parallel 1 --slot-save-path <données>/kv-cache --cache-ram 1024`. Avant une tâche de la session S : le cache du propriétaire actuel du slot est enregistré, celui de S restauré s’il existe. Fichiers liés au modèle et au contexte (jamais restaurés dans un autre modèle), quota disque avec suppression des plus anciens (4 Go par défaut), enregistrement à l’arrêt du serveur. L’étape apparaît dans la conversation (« Cache KV : ... restauré : N jetons en X ms »).

| Situation (session A d’environ 1 450 jetons) | Prefill |
| :--- | :--- |
| Première tâche, à froid | 9 129 ms |
| Retour sur A après une tâche dans B | 616 ms (restauration 106 ms, 69 jetons recalculés) |
| Après redémarrage de llama-server | 698 ms (restauration 109 ms, 65 jetons recalculés) |
| Même cas sans cache disque (référence) | 9 759 ms |

Constat : sans ce mécanisme, le cache RAM de llama.cpp ne conservait pas la session A après une requête d’une autre session (0 jeton repris).

`--cache-ram` est fixé à 1 024 Mo (llama.cpp réserve jusqu’à 8 192 Mo par défaut, excessif sur 16 Go).

## 3. Profil matériel et auto-réglage

- `GET /api/system/hardware` : cœurs physiques et cache L3 (WMI), AVX2/FMA (commande `hardware` de MUCE), RAM, GPU ; recommandations argumentées (threads = cœurs physiques, 1 slot, cache RAM = RAM/16, contexte 4096 sous 30 Go).
- `POST /api/models/autotune` : `llama-bench` (à côté de llama-server) mesure pp et tg pour plusieurs nombres de threads ; recommandation = meilleur tg, pp en départage à 3 %. Application en un clic.

Mesure Qwen3 1.7B Q4_K_M (27 s) :

| Threads | pp (tok/s) | tg (tok/s) |
| :--- | :--- | :--- |
| 2 | 54,7 | 12,1 |
| 3 | 78,1 | 13,7 |
| 4 | 65,7 | 12,3 |

Sur ce poste, 3 threads battent 4 pour ce modèle : c’est précisément ce que la règle « un thread par cœur » ne pouvait pas prévoir.

## 4. Routage des tâches auxiliaires

Paramètres > IA > Modèle des tâches auxiliaires (par défaut : modèle local chargé). Utilisé par « Proposer un message » dans Git (`POST /api/git/suggest-message`, diff indexé tronqué à 6 000 caractères). Le mode local strict et la permission réseau s’appliquent. Le titre des sessions reste dérivé de la demande (aucun appel modèle supplémentaire).

## 5. Décodage spéculatif

Option de lancement « Modèle brouillon » (même vocabulaire vérifié par le serveur, `--model-draft`, `--spec-draft-n-max`), inclus dans la clé de méthodologie des benchmarks. Mesure Qwen3 1.7B + brouillon Qwen3 0.6B, 96 jetons, température 0, 3 threads :

| Configuration | tg (tok/s), 3 essais |
| :--- | :--- |
| Sans brouillon | 12,0 / 12,1 / 8,9 |
| Brouillon, 4 jetons | 7,5 / 11,6 / 10,4 |
| Brouillon, 8 jetons | 11,1 / 10,1 / 9,1 |

Aucun gain sur ce CPU (les deux modèles se partagent les 4 cœurs). L’option reste désactivée par défaut et l’interface l’indique.

## 6. Appels d’outils fiables

- **Grammaire** : llama.cpp avec `--jinja` contraint déjà les appels d’outils à un JSON conforme au schéma. Essai d’un motif interdisant `:` dans les chemins : la contrainte est appliquée, mais Qwen3 0.6B écrit alors `C\Users\...`, chemin relatif absurde. Motif non retenu.
- **Validation stricte** (`packages/tools/src/validate.ts`) avant toute approbation : champs requis, types, énumérations, paramètres inconnus, JSON illisible ; messages correctifs destinés au modèle.
- **Normalisation** : un chemin absolu situé dans le projet est converti en chemin relatif ; hors du projet, l’outil refuse avec un message qui indique la forme attendue.

## 7. Garde-fou découvert pendant les mesures

llama.cpp a renvoyé `prompt_ms = 40 621 731` (11 heures) après une éviction de cache. Les timings du runtime ne sont désormais acceptés que s’ils tiennent dans la durée mesurée par le Studio (+20 % + 500 ms) ; sinon ils sont ignorés et une note l’indique (test `providers.test.ts`).
