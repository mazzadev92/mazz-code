# Journal de restauration (rollback)

Code : `packages/tools/src/git.ts` (`CheckpointManager`, singleton `globalCheckpointManager`). Tests : `packages/tools/src/checkpoint-security.test.ts`.

## Ce qui est journalisé

Avant d'être appliquée, chaque modification de fichier est capturée (contenu exact, binaire en base64, empreinte SHA-256) :

| Source | Où | Identifiant |
| --- | --- | --- |
| `fs.write`, `fs.patch`, `fs.delete` | boucle agent, avant l'exécution (`FILE_MUTATING_TOOLS`) | `chk_<taskId>` (un point par tâche) |
| `compiler.gcc` (exécutable de sortie) | boucle agent | `chk_<taskId>` |
| Sauvegarde dans l'éditeur | `PUT /api/files/write` | `chk_editor_<date>` |

Un fichier déjà capturé dans un point garde son premier état : le retour arrière ramène à l'état d'avant la tâche. Un fichier absent est journalisé comme absent (le rollback le supprime). Si la capture échoue (lien symbolique, chemin hors projet), l'outil n'est pas exécuté (« Point de restauration refusé »).

Non journalisé : effets de bord de `terminal.run` / `terminal.start`, opérations `git`, outils MCP. Le terminal n'est pas un écrivain de fichiers connu du journal.

## Stockage et rétention

- Persisté dans `<dataDir>/checkpoints.json` (écriture différée de 500 ms, vidée à l'arrêt) ; rechargé au démarrage (`load`). Le journal survit donc à un redémarrage.
- Rétention (`CheckpointManager.retention`, appliquée au chargement et à chaque capture) : 30 jours, 200 points, 256 Mo de contenu cumulé. Les plus anciens partent d'abord ; le point en cours d'enregistrement et le plus récent ne sont jamais supprimés.
- Suppression manuelle : `DELETE /api/checkpoints/:id`, ou purge via la section « Points de restauration » des données.

## Restaurer

- Interface : panneau Inspecteur, onglet « Restauration » (confirmation puis `POST /api/checkpoints/:id/rollback`) ; soumis à la permission d'écriture.
- Atomicité : tout le snapshot est validé avant la première écriture (intégrité SHA-256, chemins, types de destination), les copies de sauvegarde et fichiers temporaires `.mazz-rollback-*.tmp` sont préparés puis appliqués par `rename` / `link` ; toute erreur déclenche une compensation fichier par fichier. Un fichier modifié entre préparation et application bloque la restauration.
- Isolation : un point appartient à un workspace (refus ailleurs) et chaque chemin passe par `resolveSafePath` (un chemin `../` falsifié dans un enregistrement est refusé avant toute écriture).

## Preuves (tests)

Déjà présents : binaire et workspace, snapshot corrompu, base64 altéré, restauration d'absence et anciens enregistrements, conflit de destination, un identifiant pour deux workspaces, lien symbolique. Ajoutés : « journal survives a restart », « retention drops expired, then oldest… », « rollback of a tampered record refuses a path outside the workspace ». Scénario e2e S8 : création, rollback via l'API, fichier supprimé.
