# MAZZ Forge

Mode de l'Agent Studio qui fait construire un projet complet par un petit modèle local (vérifié avec
Qwen3 0,6B Q4_K_M sur i5-6500). Le projet est décrit par un **blueprint** ; le modèle écrit chaque corps de
fonction, de test et le texte du README ; rien n'est écrit dans le workspace avant d'avoir passé une exécution réelle.

## Fichiers

| Rôle | Fichier |
| :--- | :--- |
| Moteur | `packages/agent/src/forge.ts` (tests `forge.test.ts`) |
| Mémoire d'expérience (bandit) | `packages/agent/src/forge-experience.ts`, fichier `<dataDir>/forge-experience.json` |
| Serveur | mode `forge` de `POST /api/agent/run`, `GET /api/forge/blueprints` (`packages/core/src/server.ts`) |
| Événements | type `forge` (`packages/shared/src/events.ts`) |
| Interface | `apps/web/src/features/agent/ForgeBoard.tsx`, préréglage `apps/web/src/features/models/ForgePreset.tsx` |
| Blueprints | `D:\Mazz Code\Bib1\_BLUEPRINTS\*.json`, générés par `build_blueprints.mjs` |
| Scripts | `scripts/forge-run.mjs` (direct), `scripts/forge-e2e-server.mjs` (via le serveur), `scripts/forge-replay.mjs` |

## Déroulement

1. Choix du blueprint par mots-clés (égalité ou aucun mot-clé : refus, pas de devinette).
2. Recherche Bib1 ; une source n'est citée que si son texte correspond au motif `knowledgeMust`.
3. Pour chaque unité, lots de candidats (un par slot llama.cpp) :
   - **pas à pas** : le harness écrit le commentaire de l'étape, le modèle écrit le code de cette étape seulement ;
     grammaire GBNF (premier caractère `[a-z_]`, ou mot-clé imposé `for (`, `if (`, `while`, `with `, `return`) ;
     ancres obligatoires ; contrôle syntaxique réel (`gcc -fsyntax-only`, `ast.parse`) ; 5 essais par étape ;
   - **corps entier** (1 candidat sur 3) sous la liste complète des étapes ;
   - **oracle** : commandes exécutées dans un bac à sable temporaire ; les tests doivent aussi échouer face à une
     implémentation volontairement fausse (mutant) ;
   - **réparation** : à partir du 2ᵉ lot, le premier slot reprend le dernier candidat complet qui a échoué, avec son
     vrai message (compilateur, test, oracle ; chemins du bac à sable retirés) et demande un corps corrigé (approche S*) ;
     désactivable par `repair: false`. Le message transmis est la vraie cause (`diagnostic()` : premier `error:` de gcc
     avec sa ligne, ou dernière exception Python), pas les dernières lignes de sortie. Mesure 2026-10-28 avec Qwen3 0,6B
     (banc ci-dessous) : aucune réparation gagnante ; le modèle corrige mal même avec le bon message. Pour le 0,6B,
     l'échafaudage pas à pas compte bien plus que la réparation ;
   - parmi les réussites, le texte modèle le plus court gagne ;
   - **mémoire d'expérience** : chaque candidat de code reçoit un « bras » (pas à pas ou corps entier, palier de
     température 0 à 3). Sans données, c'est le portefeuille fixe (corps entier si n % 3 = 2, palier n % 4). Avec
     des données, échantillonnage de Thompson par clé `modèle|langage|impl ou test`, sauf le slot n % 4 = 0
     gardé pour l'exploration. Récompense = verdict de l'oracle ; une erreur du fournisseur n'est pas comptée ;
     décroissance 0,98 ; sauvegarde atomique après chaque unité. Serveur : actif ; `forge-run.mjs` : seulement
     avec `MAZZ_FORGE_EXPERIENCE=<fichier>`. Gain pas encore mesuré sur modèle réel.
4. Écriture des fichiers par `fs.write` (autorisations normales), `FORGE_REPORT.json`, build et vérifications par
   `compiler.gcc` et `terminal.run`.

## Format d'une unité (extrait réel de `crc32-ctypes.json`)

```json
{
  "id": "crc32_update", "file": "src/crc32.c", "lang": "c",
  "signature": "CRC32_API uint32_t crc32_update(uint32_t seed, const void *data_, size_t length)",
  "prelude": ["const unsigned char *data = (const unsigned char *)data_;"],
  "steps": [
    { "text": "declare uint32_t crc <- ~seed", "must": ["\\bcrc\\b", "~\\s*seed"] },
    { "text": "for i <- 0 .. length-1 (size_t i)", "opens": true, "must": ["for\\s*\\(\\s*size_t"] },
    { "text": "crc <- crc ^ data[i]", "depth": 2, "must": ["\\^"] },
    { "text": "return ~crc", "depth": 1, "must": ["~\\s*crc"] }
  ],
  "oracle": { "files": { "tests/_oracle.c": "..." }, "commands": [["{gcc}", "...", "-o", "build/oracle.exe"], ["{dir}/build/oracle.exe"]] }
}
```

## Écrire un blueprint qui marche avec un 0,6B

Leçons mesurées (runs `AUDIT_RUN_2026-10-25_FORGE/`) :

- Pseudo-code **au niveau des opérateurs** (`crc <- ~seed`), une instruction par étape. « Complément bit à bit »
  ou « 8 chiffres hexadécimaux » en langage naturel échouent ; donner l'opérateur ou le format exact.
- Pas de variable d'une lettre en début d'étape (`n = len(a)` produisait `ndef ...`) ; préférer `rows`, `cols`.
- Un appel sans valeur de retour est une étape « call » : le moteur refuse un `return` dans une étape qui n'en
  demande pas.
- Les listes d'arguments longues (`argtypes`) sont souvent recopiées de travers : l'oracle doit vérifier la liste
  exacte, sinon l'erreur passe et casse l'unité suivante.
- Chaque oracle doit être satisfaisable : le valider contre une implémentation de référence avant de l'utiliser
  (voir le script de contrôle décrit dans le rapport d'audit), et vérifier que chaque mutant est détecté.

## Banc d'essai

`node scripts/forge-bench.mjs <dossier> [--tasks crc32-ctypes:hard,vecmath-ctypes:coarse] [--configs repair,norepair] [--runs N]`
lance les mêmes blueprints avec plusieurs réglages contre un llama-server et écrit `results.json`, `summary.md` et, pour
chaque passage, tous les candidats avec leur stratégie et leur erreur (`*_events.json`). Variantes : `standard` ;
`hard` (ancres `must` retirées) ; `coarse` (une seule consigne par fonction : le corps entier d'un coup).

Mesures du 2026-10-28, Qwen3 0,6B, 4 slots, un passage par ligne (une seule mesure : bruit important) :

| Tâche | Avec réparation | Sans réparation |
| :--- | :--- | :--- |
| CRC-32 hard | 13/13, 56 candidats, 534 s | 13/13, 56 candidats, 382 s |
| vecmath hard | échec à `_load` (3/17) | 17/17, 76 candidats, 762 s |
| CRC-32 coarse | échec à `crc32_update` (0/13) | échec à `crc32_update` (0/13) |
| vecmath coarse | échec à `axpy` (6/17) ; avec le message corrigé : échec à `matmul` (8/17, 9 réparations, 0 gagnante) | échec à `axpy` (6/17) |

Leçons : les ancres comptent (vecmath hard bloque sur `_load` sans elles) ; sans pas à pas, le 0,6B n'écrit pas un corps
entier correct ; la réparation ne l'aide pas. Mesure suivante : le même banc avec Qwen3 1,7B et 4B.

### Comparaison des modèles locaux (2026-10-28)

`scripts/model-compare.ps1 -Model <gguf> [-Ctx N -Parallel N]` : juge puis banc, un passage par configuration.

| Mesure | Qwen3 0,6B (4 slots) | Qwen3 1,7B (4 slots) | Qwen3 4B (2 slots, 8 192 ctx) |
| :--- | :--- | :--- | :--- |
| Juge (explication juste 1re) | 11/15, 80 s | 15/15, 161 s | 15/15, 308 s |
| CRC-32 standard | 13/13, ~360 s | 13/13, 623 s | 12/13 (README), 1 103 s |
| vecmath hard, réparation | échec `_load` (3/17) | 17/17, 1 021 s | voir AUDIT_RUN…/compare-Qwen3-4B |
| vecmath hard, sans réparation | 17/17, 762 s | 17/17, 1 148 s | idem |
| CRC-32 coarse, réparation | échec (0/13) | 13/13, 1 097 s, 1 réparation gagnante | idem |
| CRC-32 coarse, sans réparation | échec (0/13) | 13/13, 895 s | idem |

Choix pour Forge sur cette machine : **Qwen3 1,7B**. Il réussit tout, y compris sans pas à pas fin (coarse), juge sans
erreur, et reste environ 1,7 fois plus lent que le 0,6B. Le 4B n'apporte rien de mesurable ici et coûte deux fois plus
de temps ; il a même bloqué sur une phrase du README.

## Juge par paires

`packages/agent/src/judge.ts` : `tournament()` classe des réponses non vérifiables par exécution (explication, README,
choix de conception) avec des comparaisons par paires « 1 / 2 / = » imposées par grammaire, l'ordre inversé à chaque
répétition (biais de position annulé), en tournoi complet jusqu'à 6 candidats puis en élimination directe.
`node scripts/judge-bench.mjs` : trois explications d'une fonction (juste, vague, fausse), classées 5 fois chacune.
Qwen3 0,6B, 3 jugements par paire : explication juste classée 1re 11/15 (hasard 5/15) ; 5/5 sur `vm_dot` et `clamp`,
1/5 sur `crc32_update` (code à opérations de bits), 80 s au total.

## Sécurité

Un blueprint vient d'un dossier modifiable par l'utilisateur. La validation refuse : chemins absolus, lecteurs
(`C:x`), flux NTFS, `..` ; commandes d'oracle autres que `{gcc}`, `{python}` et `{dir}/build/*` ; commandes finales
autres que `compiler.gcc` et `terminal.run`. Le bac à sable confine les écritures et n'hérite que de variables
d'environnement système (aucune clé API). Le code généré s'exécute toutefois avec les droits de l'utilisateur.

## Limites

- Forge réussit ce qu'un blueprint décrit ; la rédaction automatique de blueprints n'est pas livrée.
- Débit : 4 slots llama.cpp = 95 tokens/s cumulés contre 35 avec 1 slot (mesuré, Qwen3 0,6B, i5-6500) ;
  `models.parallel` vaut 1 par défaut, d'où le préréglage Forge du Model Hub.
