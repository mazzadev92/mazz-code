# ADR-001 : Orchestrateur Principal Unique (Cordis/DeepSeek) et Bridge Isolé pour Hermes Agent

## Contexte
Le projet **MAZZ ÆNGENIUM — Agent Studio** requiert l'intégration de deux socles open-source majeurs :
1. **DeepSeek Harness** (basé sur le méta-framework Cordis).
2. **Hermes Agent** (développé par Nous Research).

Lancer simultanément deux boucles d'agent concurrentes sur la même tâche mènerait inévitablement à des conflits d'écritures de fichiers, des récursions infinies d'appels mutuels, une saturation de la mémoire vive (16 Go) et une perte de prévisibilité.

## Décision
1. **Orchestrateur Principal Unique** :
   - Le noyau de MAZZ Agent Studio repose sur l'architecture Cordis (`packages/core`).
   - L'orchestrateur principal contrôle le graphe de plugins, le contexte, les sessions, les permissions et la boucle d'exécution de haut niveau.
2. **Hermes Agent en Bridge Complémentaire Isolé** (`packages/hermes-bridge`) :
   - Hermes n'exécute jamais de boucle concurrente sur la session active.
   - Il est encapsulé dans un pont de communication structuré (via sous-processus Python / CLI ou API locale).
   - MAZZ peut déléguer à Hermes une sous-tâche délimitée avec :
     - un workspace restreint,
     - un budget de tokens / temps strict,
     - un schéma de résultat typé.
   - Hermes retourne son résultat et ses artefacts à l'orchestrateur MAZZ, sans droit de ré-invoquer le chef d'orchestre en cascade.
3. **Statut d'intégration** :
   - Si l'environnement Hermes n'est pas installé ou n'est pas activé par l'utilisateur, le système fonctionne sans interruption via le moteur principal.
   - Aucun mock ne simule une exécution Hermes réussie si le runtime n'est pas présent.

## Conséquences
- Architecture robuste et prévisible.
- Aucune collision de fichiers ni boucle de rétroaction infinie.
- Respect strict de la limite de 16 Go de RAM de la machine hôte.
