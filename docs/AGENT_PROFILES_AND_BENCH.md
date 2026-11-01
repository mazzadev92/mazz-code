# Profils de harnais et banc d'agent réaliste

## Un harnais, deux profils

Le Studio accepte n'importe quel fournisseur : llama.cpp, Ollama, LM Studio en local ; DeepSeek, Groq, Gemini,
OpenAI, Anthropic en API ; ou toute API compatible OpenAI ajoutée dans Fournisseurs. Le comportement de l'agent
s'adapte au modèle (`agent.modelProfile`, Paramètres, Agent) :

| | Petit modèle (`small`) | Grand modèle (`large`) |
| :--- | :--- | :--- |
| Pour | modèles locaux 0,6B à 8B | API distantes, modèles locaux de 14B et plus |
| Plan | découpé par le Studio, plan structuré imposé, routage NeuroKernel | libre, le modèle planifie seul |
| Outils | quelques-uns selon la demande (`tools.request` pour le reste) | tous proposés, descriptions complètes |
| Itérations | réglage `agent.maxIterations` | au moins 40 |
| Permissions, points de restauration, vérification des modifications | actifs | actifs |

`auto` (défaut) choisit à chaque tâche : API distante ou taille lue dans le nom du modèle (14B et plus, taille totale
pour les MoE) donne `large`, sinon `small`. Fonction : `resolveModelProfile()` (`packages/agent/src/agent-loop.ts`).

## Robustesse face aux API

- **Limites de débit** (HTTP 429, 502, 503) : attente du délai indiqué par le fournisseur (en-tête Retry-After ou
  message « try again in 1.6s ») puis nouvel essai, 6 fois au plus, 65 s maximum chacun (`retryDelayMs`,
  `packages/providers/src/openai.ts`).
- **Erreur dans le flux** (`{"error": ...}` envoyé au milieu du flux par Groq) : message réel affiché, et le même appel au
  modèle est relancé deux fois au plus, aucun outil de la réponse rejetée n'ayant été exécuté.
- **Requête trop grande** (HTTP 413, par exemple 8 000 jetons par requête sur l'offre gratuite de Groq) : les anciens
  résultats d'outils sont raccourcis (`shrinkToolResults`) et l'appel relancé, trois fois au plus.

## Aides pour les petits modèles locaux (ajoutées le 2026-10-28, mesurées sur le banc)

| Aide | Problème observé (Qwen3 1,7B) | Où |
| :--- | :--- | :--- |
| Fichiers cités préchargés, numérotés, plus la commande de test exacte | cherchait 8 fois le chemin du fichier au lieu de le lire ; essayait `pytest` absent | `mentionedFiles`, `testCommandHint` (agent-loop) |
| Carte du projet dans les modes Ask, Plan, Review | cherchait « total TTC » dans des fichiers `*.c` d'un projet Python, puis répondait que rien n'existait | `buildRepoMap` + PageRank |
| Anti-boucle : appel de lecture identique non relancé, avec une consigne | même `code.search` répété jusqu'à épuisement des étapes | `REPEAT_GUARDED_TOOLS` |
| Relance quand le modèle conclut sans la modification ou le test demandés (2 fois) | s'arrêtait après avoir seulement exploré | `MAX_COMPLETION_NUDGES` |
| Contrôle de syntaxe à l'écriture (Python, C, JSON) | écrivait des lignes `=======` dans `stats.py` | `syntax-gate.ts` (fs.write, fs.patch) |
| `fs.read` ignore `maxLines` sous 40 | lisait les fichiers avec `maxLines: 1` | `fs.ts` |
| `code.search` sur un fichier, et recherche de secours sans ripgrep | un fichier en `path` donnait « ripgrep introuvable » | `code.ts` |
| Limite d'étapes 25 au lieu de 12 | tâches coupées en cours | `settings.ts` |

Résultat local, Qwen3 1,7B, profil petit modèle : 0/3 avant comme après. Mais l'agent passe d'explorer sans fin à
corriger et lancer les tests (bug : correction appliquée, tests lancés avec la bonne commande ; compréhension : 0/4 puis
3/4 faits exacts). Ce qui manque désormais est le raisonnement du modèle (trouver le bon correctif), pas le harnais.
Mode réflexion de Qwen3 essayé : chaque appel épuise ses 2 048 jetons de sortie en réflexion sans agir ; il faudra
plafonner la réflexion par appel avant qu'il serve.

### Modèles locaux sur le banc réaliste (harnais avec ces aides, 2026-10-28)

| Modèle | bugfix | median | understand |
| :--- | :--- | :--- | :--- |
| Qwen3 1,7B | échec (correctif faux, tests lancés) | échec (25 étapes) | 3/4 faits |
| Qwen3.5 0,8B abliterated | échec | échec (contenu de fichier inexploitable) | 0/4 |
| Qwen3.5 4B abliterated | presque (1 test caché sur 2 échoue), 3 outils | échec (fichier de tests cassé, arrêt) | **réussi 4/4**, 96 s |
| Qwen3.5 4B, réflexion plafonnée à 512 jetons par réponse (`models.acceleration.reasoningBudget`), contexte 8 192 | presque (1 test sur 2), 625 s | échec, 1 454 s | non mesuré (délai de l'appel API du banc dépassé) |
| Groq gpt-oss-120b (API) | réussi | réussi (sur un passage séparé) | réussi |

## Banc réaliste

`scripts/agent-bench/run.mjs` passe trois tâches, chacune sur une copie neuve de sa fixture, notées par un contrôle caché :

| Tâche | Ce qui est demandé | Contrôle caché |
| :--- | :--- | :--- |
| `bugfix-textstats` | corriger les deux bugs qui font échouer les tests, sans toucher aux tests | tests supplémentaires jamais vus par l'agent |
| `feature-median` | ajouter `median()` avec ses tests | comportement (pair, impair, vide, liste non modifiée) et tests du projet qui couvrent `median` et passent |
| `understand-shop` | expliquer un petit projet inconnu (mode Ask, lecture seule) | 4 faits exacts dans la réponse (fonction, fichier, taux de TVA, seuil de livraison) |

Les contrôles cachés ont été validés : ils échouent sur la fixture d'origine et passent avec une solution de référence.

```
node scripts/agent-bench/run.mjs <dossier> --runner studio --provider groq-api --model openai/gpt-oss-120b --key-file <fichier contenant seulement la clé>
node scripts/agent-bench/run.mjs <dossier> --runner studio --provider llama-local --model D:\TESSERA\Mgguf\Qwen_Qwen3-1.7B-Q4_K_M.gguf
node scripts/agent-bench/run.mjs <dossier> --runner claude      (Claude Code, `claude -p`, session connectée requise)
```

`--list-models 1` affiche les modèles du fournisseur. Une erreur d'authentification de Claude Code est notée
« non mesuré », jamais comme un échec de tâche.

### Mesures du 2026-10-28 (Groq, `openai/gpt-oss-120b`, offre gratuite, profil grand modèle)

| Passage | bugfix | median | understand | Remarque |
| :--- | :--- | :--- | :--- | :--- |
| 1 | échec | échec | échec | avant correctifs : abandon immédiat sur 429 |
| 2 | réussi (376 s, 13 outils) | échec | réussi (71 s, 4/4) | arrêt sur erreur dans le flux |
| 2 bis | | réussi (251 s, 16 outils) | | après correctif du flux et relance |
| 3 (un passage) | réussi (182 s, 17 outils) | échec | réussi (18 s, 4/4) | requête au-delà de 8 000 jetons (413) |
| 4 | interrompu | | | quota quotidien Groq épuisé (200 000 jetons) ; réduction de contexte non encore mesurée |

Chaque tâche a été réussie au moins une fois par le Studio avec Groq ; un passage complet 3/3 d'un coup reste à faire
(prochain quota ou offre payante). La comparaison avec Claude Code n'a pas été faite.
