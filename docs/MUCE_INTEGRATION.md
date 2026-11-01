# Intégration MUCE (accélération des modèles locaux)

Date : 2026-10-22. Machine : Intel Core i5-6500 (4 cœurs, AVX2/FMA), 16 Go DDR4, sans GPU dédié.
MUCE 0.3.5 (`D:\MAZZ GPU ACX`, manifeste schema 3).

## Ce que fait réellement MUCE pour la génération

Le service MUCE (`server/muce_service.py`) est un pont Python devant le même `llama-server` que celui du Studio (llama.cpp 0.7.0-dev, commit 7775ffb). Les noyaux de calcul restent ceux de llama.cpp (`muce_llm_kernel_replacement` est déclaré non pris en charge dans le manifeste). L'accélération vient des options du runtime :

- décodage spéculatif sans modèle brouillon, `--spec-type ngram-mod` : propose les suites déjà vues dans le contexte et les vérifie en un seul passage ;
- `--poll 100` : les threads restent en attente active entre deux étapes ;
- `--prio 2` : priorité haute ;
- `--reasoning off` : pas de phase de réflexion pour les modèles hybrides (Qwen3).

## Deux façons de l'utiliser dans le Studio

1. **Studio + profil MUCE (par défaut).** Le Studio lance `llama-server` avec les options ci-dessus (Paramètres, Accélération MUCE). Il garde ce que le pont Python ne fournit pas : le cache KV par session sur disque, la vision (`--mmproj`), un contexte jusqu'à 256k, le cache KV quantifié (q8_0, q4_0) pour les longs prompts et l'absence de limite de 1 Mo par requête.
2. **Service MUCE (8098).** Le Studio démarre `server/muce_service.py` (Model Hub, moteur « Service MUCE »), l'enregistre comme fournisseur local `muce-service` et l'arrête proprement avec le jeton de contrôle (`/muce/v1/shutdown`), à la demande ou à la fermeture du Studio. Un service déjà lancé hors du Studio est détecté au démarrage et proposé comme fournisseur, mais il n'est jamais arrêté par le Studio. La page MUCE affiche `/muce/v1/telemetry` toutes les 3 s.

L'analyseur MUCE (`scripts/muce_analyze.py`) est disponible dans la fenêtre de chargement : architecture, quantification, mémoire requise (cache KV f16 et q8_0) et moteur recommandé. Les débits « attendus » qu'il calcule sont des projections : le Studio ne les affiche pas.

## Mesures réelles

Script : `scripts/measure-muce-acceleration.mjs`. Résultats bruts : `docs/muce/*.json`. Débit de génération selon llama.cpp (`timings.predicted_per_second`), température 0, contexte 4096, 4 threads. Deux passages par cas : au 2e passage, la table n-gram contient déjà la sortie du 1er.

### Qwen3 1.7B Q4_K_M

| Tâche | Sans accélération | MUCE n-max 48 | MUCE n-max 16 (retenu) |
|---|---|---|---|
| Texte libre (345 jetons) | 9,6 / 10,9 | 11,5 / 12,9 | 11,6 / 15,3 |
| Réécriture d'un fichier TS (700 jetons) | 8,5 / 9,5 | 9,9 / 31,3 | 10,0 / 28,3 |
| JSON généré (618 jetons) | 11,4 / 9,1 | 11,0 / 9,7 | 12,5 / 12,2 |

Le traitement du prompt passe d'environ 85 à 100 tok/s (attente active et priorité).

### Qwen3 0.6B Q4_K_M, réécriture de code

| | Sans accélération | MUCE n-max 48 |
|---|---|---|
| 1er passage | 16,2 tok/s, 43,3 s | 35,7 tok/s, 22,4 s (522/576 propositions acceptées) |
| 2e passage | 17,9 tok/s, 39,5 s | 50,5 tok/s, 15,7 s (599/672) |
| Prompt | 197–202 tok/s | 242 tok/s |

### Conclusion

- Le gain est réel et sans perte observée quand la réponse reprend du contexte (réécriture de fichiers, patchs, citations) : x2 à x3. Il reste faible (+10 à +40 %) sur du texte libre.
- Le chiffre de « 85+ tok/s » n'a pas été observé sur cette machine. Le maximum mesuré est 50,5 tok/s (0.6B) et 31,3 tok/s (1.7B), sur du code déjà produit.
- `n-max 16` a été retenu : il est aussi rapide que 48 sur le code et évite le ralentissement quand peu de propositions sont acceptées (JSON : 12,2 au lieu de 9,7).
- Dans l'agent, les appels d'outils profitent de la spéculation : jusqu'à 26,9 tok/s mesuré avec 44/48 propositions acceptées. Une longue réponse avec peu de reprises est restée à 5,2 tok/s (21 % acceptées, contexte de 1 770 jetons, n-max 48 à ce moment-là).

## Service MUCE : vérification réelle

- Démarrage via le Studio : 22,5 s avec Qwen3 0.6B (pont et chargement du modèle).
- Requête de l'agent via le fournisseur `muce-service` : réponse correcte, 25,8 tok/s mesurés par le runtime. La même valeur est rapportée par `/muce/v1/telemetry`.
- Arrêt par `/muce/v1/shutdown` : service arrêté, port libéré.

## Corrections apportées à MUCE

Fichiers de sauvegarde : `server/muce_service.py.bak-20261022` et `INTEGRATION_MANIFEST.json.bak-20261022`.

- **Valeurs inventées supprimées.** Avant toute mesure, la télémétrie renvoyait des constantes : 11,45 tok/s, 185 tok/s, 78,5 ms, 12,5 ms et 20 Mo de cache KV. Elle renvoie maintenant `null`.
- **Débit de génération.** Il était calculé en fragments SSE par seconde, alors que le manifeste précise qu'un fragment n'est pas un jeton. Il est maintenant lu dans les `timings` du runtime : débit de génération, débit du prompt, jetons repris du cache et propositions spéculatives.
- **Débits estimés supprimés.** En mode non streamé, les débits étaient estimés avec des proportions fixes (25 % / 75 % de la durée). Ils sont désormais remplacés par les `timings` du runtime.
- **Moteur affiché.** `active_backend` valait « llama-avx2+muce_cpux » alors que le plugin cpux n'intervient pas dans la génération. Il vaut maintenant « llama-server (llama.cpp CPU AVX2) ».
- **Limites relevées** pour les longs prompts et les images : corps de requête de 1 Mo à 32 Mo, sortie maximale de 2 048 à 8 192 jetons (manifeste mis à jour).

Pendant ce travail, d'autres fichiers MUCE ont été modifiés par ailleurs : `radix_cache`, `code_trie` et `sparse_engine`, ajoutés au pont à 14:49–14:54. Mes corrections sont restées en place. Ces ajouts n'ont pas été évalués ici.

## Non réalisé

- **Bascule automatique vers l'« Extended Memory Engine » (AirLLM).** `python/muce/extended_memory.py` calcule un plan et des projections, mais n'exécute pas de modèle. Un modèle plus grand que la RAM reste chargé par llama.cpp en mmap (lecture depuis le disque, très lent), et l'analyseur l'indique.
- **Lancement par `LANCER_MUCE.bat`.** Ce script ouvre l'interface graphique `MUCE.exe`, pas le service HTTP. Le Studio lance donc `server/muce_service.py` directement.
- **Réglage Qwen3 en mode service.** Le Studio transmet `--reasoning`; pour les requêtes OpenAI-compatibles qui ne fournissent pas déjà `chat_template_kwargs.enable_thinking`, le pont fixe cette valeur d'après le réglage MUCE. Une valeur explicite envoyée par le client reste prioritaire.

## Vérification des ajouts « Paroxysm » d'Antigravity (22/10/2026, après-midi)

- `tests/test_paroxysm_engines.py` et `tests/test_ecosystem_and_analyzer.py` : 12 tests réussis.
- Service MUCE modifié (RadixTreeCache) : démarrage, requête de l'agent par `muce-service`, télémétrie et arrêt vérifiés via le Studio (24,2 tok/s sur 0.6B).
- **RadixTreeCache.** Il suit les préfixes côté Python. Avec une conversation de 1 939 jetons répétée, le temps avant le premier mot passe de 10,9 s à 0,93 s. Ce gain vient du cache de prompt de llama.cpp (`cache_n` 1922), pas du module Python. Les « moins de 10 ms » annoncés n'ont pas été observés.
- **`code_trie.py`.** Les 372 tok/s sont une projection : 18 tok/s fixés multipliés par un gain simulé sur des mots. Le module n'est utilisé ni par le pont ni par llama-server.
- **`sparse_engine.py`.** Le gain x3 compare deux boucles Python vides.
- **`heterogeneous_pipeline.py`.** Calcul matriciel sur l'iGPU, sans lien avec la génération.
- **`scripts/muce_supercharge.py`.** Il lance `llama-cli` avec les mêmes options que le profil du Studio. Avec 0.6B et le prompt CRUD : 32 tok/s sans spéculation, 28 à 30 tok/s avec. Le même jour, ce build (390c307) mesure 34,0 tok/s en génération et 170 tok/s en prompt avec `llama-bench`, contre 34,2 et 246 pour le runtime du Studio. Aucun intérêt à en changer.
- **Mesures réelles d'Antigravity** (`research/speculative_extreme/speculative_paroxysm_results.json`) : 9 à 12,5 tok/s sur 1.7B. Son profil « paroxysm » (n-max 64) n'est pas plus rapide que le standard. Le modèle brouillon ralentit la génération.
- **Studio.** La page MUCE affiche ces modules avec leur statut vérifié. La carte du service affiche les jetons réellement repris par llama.cpp. Le profil retenu reste ngram-mod avec n-max 16.

## Phase 2 : cache n-gram du projet et ik_llama.cpp (22/10/2026, soir)

### Cache n-gram statique construit sur le projet

`llama-lookup-create` (compilé depuis `third_party/llama.cpp` de MUCE, même commit 7775ffb que le runtime) a construit `studio-qwen3.lcs` à partir de 1 Mo de code TypeScript du Studio en 22 s. Mesures sur Qwen3 1.7B, avec `--spec-type ngram-cache --lookup-cache-static`, polling et priorité identiques dans les trois cas (`docs/muce/ngram_cache_projet.json`).

| Tâche | Sans spéculation | ngram-mod (n-max 16) | Cache n-gram du projet |
|---|---|---|---|
| Classe TypeScript dans le style du projet, 1er / 2e passage | 13,7 / 14,0 tok/s | 13,2 / 13,7 | 11,3 / 15,7 |
| Texte libre, 1er / 2e passage | 15,7 / 15,1 | 14,4 / 17,7 | 10,8 / 22,0 |

Au premier passage, le cache statique ralentit la génération (20 % de propositions acceptées). Le gain du second passage vient du cache dynamique que le serveur remplit pendant la session. Conclusion : non activé par défaut. Le profil reste `ngram-mod` avec n-max 16.

### ik_llama.cpp

Compilé depuis les sources (commit c12b5ac, `D:\Mazz Code\_build\ik_llama.cpp`, AVX2 natif). Mesures llama-bench à paramètres identiques, 4 threads, pp512 / tg128, 3 répétitions (`docs/muce/ik_llama_vs_mainline.txt`).

| Modèle | Runtime MUCE (llama.cpp 7775ffb) | ik_llama.cpp | ik_llama.cpp `-rtr 1` |
|---|---|---|---|
| Qwen3 1.7B Q4_K_M, génération | 17,3 tok/s | 10,0 | 13,1 |
| Qwen3 4B Q4_K_M, génération | 6,9 tok/s | 6,7 | 5,2 |

Les mesures de prompt varient trop (écart type jusqu'à ±23) pour être comparées. Pour des modèles denses en Q4_K_M sur ce processeur, ik_llama.cpp n'apporte rien : il n'est pas intégré. Ses atouts annoncés portent sur les modèles MoE et ses propres quantifications (IQ_K), à réévaluer avec un modèle MoE comme gpt-oss-20b.

## Vérification d'intégration du 25/10/2026

Ces essais isolés complètent les mesures plus anciennes ci-dessus; ils n'en changent pas la méthodologie.

- **ABI C native v1.** `AUDIT_RUN_2026-10-24/verify-muce-native-abi.py` a chargé `muce_llm.dll` par le wrapper Python officiel de MUCE et généré une réponse avec Qwen3 0.6B. Le contrat v1 et le callback ont fonctionné (`finish_reason=EOS`). L'essai a retourné 84 appels du callback, `prompt_ms=119.25`, `generation_ms=1782.12`, `first_token_ms=120.16`, `model_buffer_bytes=478268416` et `kv_buffer_bytes=117440512`. Ces durées appartiennent à cet appel ABI précis; elles ne sont ni un benchmark llama.cpp contrôlé ni une comparaison de débit.
- **Chemin agent réel Studio → Service MUCE → llama-server → interface.** Avec Qwen3 4B Q4_K_M, le Studio a possédé et arrêté le service isolé. L'agent a exécuté `fs.read` en 1 ms et renvoyé exactement le marqueur attendu; `complete.success=true`. La carte MUCE ouverte pendant que le service tournait a affiché `1 ms`, le libellé source `Studio → MUCE` et l'indication de dernière exécution. Configuration observée : contexte 8192, batch 256, cache KV `q4_0`, ngram-mod. Preuve : `AUDIT_RUN_2026-10-24/muce-service-studio-e2e-2026-10-24T22-57-48-205Z.json`.
- **Qualité dépendante du modèle.** Qwen3 1.7B a exécuté une lecture réelle mais a ensuite demandé plusieurs confirmations et tenté deux écritures non autorisées; le fichier est resté intact et la tâche a atteint sa limite d'itérations. Qwen3 0.6B n'a pas produit de parcours agent complet dans les tentatives consignées. Le smoke HTTP officiel avec 0.6B a validé le flux SSE et le contrat outils, mais le premier choix `auto` n'a produit aucun appel de fonction; une seconde requête `required` en a produit un. Les rapports détaillent chaque essai : `MODEL_TRIAL_REPORT.md` et `AUDIT_RUN_2026-10-24/muce-official-service-live-20261025.json`.
- **Réglages transmis.** Le service lancé par le Studio reçoit maintenant `--batch` et `--cache-type`; une valeur batch supérieure à 2048 est refusée avant lancement. Le réglage de raisonnement est appliqué au template Qwen3 comme décrit ci-dessus.
- **Télémétrie mémoire et outils.** Le service expose le working set observé du processus modèle et la capacité du buffer KV trouvée dans le journal du runtime. `kv_cache_measurement_scope` précise que cette capacité réservée n'est pas l'occupation active par les jetons. La carte MUCE du Studio affiche la dernière latence d'un outil réellement exécuté; les opérations d'orchestration et l'attente d'une réponse humaine ne remplacent pas cette mesure. Les retours sont limités à une destination loopback.
- Smoke HTTP officiel : `AUDIT_RUN_2026-10-24/muce-official-service-live-20261025.json` — SSE, contrat outils (auto puis required), mesures mémoire, plafonds de requête, contrôle de benchmark et arrêt possédé; code de sortie 0. Sur la mesure conservée, le working set du processus modèle était de 855478272 octets et le buffer KV réservé de 176160768 octets. La première valeur est une mesure de working set; la seconde est une capacité d'allocation du runtime, pas de la mémoire résidente supplémentaire.
- Contrôle navigateur de la carte à l'arrêt : `AUDIT_RUN_2026-10-24/browser-muce-ui-smoke-20261025.json` — 2/2 scénarios réussis; l'état arrêté est affiché sans présenter de mesure runtime comme réelle.

Ces preuves attestent les chemins précis exécutés; elles ne démontrent pas une réussite universelle des tool calls, une vitesse supérieure sur toute charge, ni un gain OpenBLAS. Aucun build OpenBLAS et aucun A/B BLAS avant/après n'ont été faits dans cette passe.
