# 02 — Agents : Registre d'outils et intégration MCP

## 1. Outils natifs du harnais

Le registre `@mazz/tools` fournit les capacités d'interaction directe avec l'environnement :
- `fs.read` : Lecture de fichier avec pagination par lignes (`startLine`, `endLine`), évitant d'engorger le contexte pour les gros fichiers.
- `fs.write` : Création de fichier neuf ou remplacement complet.
- `fs.patch` : Édition chirurgicale par blocs cibles.
- `fs.list` : Parcours récursif d'arborescence avec filtrage d'exclusions (`.git`, `node_modules`, `dist`).
- `terminal.run` : Exécution ponctuelle de commande avec capture de sortie et code retour.
- `terminal.start` : Démarrage de processus interactif lié à un PTY virtuel.

## 2. Intégration du Model Context Protocol (MCP)

MAZZ Code implémente le standard ouvert **Model Context Protocol** (MCP) pour étendre les capacités de l'agent sans modifier son code source :
- **Transports supportés** :
  - `stdio` : Processus exécuté localement communicant sur ses flux standard.
  - `http` (Streamable) : Serveur distant délivrant des outils et des ressources via HTTP/SSE.
- **Cycle de vie** : Découverte des outils au démarrage, initialisation via poignée de main JSON-RPC 2.0, injection dynamique dans le schéma d'outils du modèle sous le préfixe `mcp__<serveur>__<outil>`.
- **Isolation** : Un crash d'un serveur MCP n'interrompt pas la boucle principale de l'agent ; l'erreur est notifiée et isolée.

