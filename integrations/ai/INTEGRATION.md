# Intégration du routeur IA MAZZ Control

## Activation et confidentialité

Le routeur est construit au démarrage sans appel réseau. Il ne reçoit des requêtes du gateway que lorsque `AI_ROUTER_ENABLED=true` et que le modèle demandé est `auto` ou `router/<alias>`. La valeur `enabled` du registre décrit l’état de livraison ; une clé valide active un fournisseur, sauf si `AI_<ID>_DISABLED=1`. Une clé ajoutée au fichier `mazz_control/.env` est rechargée à chaud.

Dans ce mode, les messages sont envoyés au fournisseur tiers choisi par le routeur. Ne l’activez que si cet envoi est accepté. Le Studio conserve son contrôle de mode d’exécution : `local_strict` doit continuer à refuser les appels distants.

## Points de branchement dans `app.py`

- Import protégé de `integrations.ai` : le gateway reste démarrable si la couche n’est pas installée.
- `lifespan` appelle `_build_ai_router`, construit `app.state.ai_router` et le lie au routeur global sans effectuer de requête réseau.
- `app.include_router(ai_routes)` expose les routes d’intégration ; `guard` protège les POST avec la clé de passerelle.
- `resolve_route` reconnaît `auto` et `router/<alias>` uniquement si `AI_ROUTER_ENABLED=true` et sélectionne le backend `router`.
- `GET /v1/models` ajoute `auto` et les alias `router/frontier`, `router/fast`, `router/code` et `router/vision` uniquement quand le flag est actif ; le Studio les découvre via son fournisseur MAZZ Control existant.
- En mode `local_strict`, le Studio refuse explicitement ces sélections de routeur avant l’appel au gateway.
- `_send_routed` délègue ce backend à `_send_via_ai_router`, qui utilise `ai_router.open_chat` et émet `X-Mazz-Backend: router/<provider>`.
- `RouteError` propage les en-têtes du routeur, dont `Retry-After` pour les quotas épuisés.
- Flag désactivé : les anciens chemins restent actifs et `auto` demeure inconnu (404), comme avant le branchement.

## Opérations

- `GET /integrations/status` : état et capacités des fournisseurs.
- `GET /integrations/quota` : quotas et réinitialisations.
- `POST /integrations/{id}/test` : test d’un fournisseur ; la clé fournie dans le corps n’est pas conservée ni journalisée.
- `POST /integrations/call/{capability}` : capacités `embedding`, `rerank`, `tts`, `stt`, `image`, `search`, `scrape`.
- Les POST requièrent la clé de passerelle. Le Studio doit la transmettre côté serveur dans `x-mazz-key`, jamais au navigateur.

## Mise en service et retour arrière

1. Vérifiez les variables et les fournisseurs avec `GET /integrations/status` et le bouton Tester du Studio.
2. Ajoutez `AI_ROUTER_ENABLED=true` dans `mazz_control/.env` seulement après avoir choisi les fournisseurs et accepté l’envoi éventuel à des services tiers.
3. Demandez `auto` ou `router/<alias>` pour utiliser ce chemin. Les autres modèles gardent le routage existant.
4. Retour immédiat : remettez `AI_ROUTER_ENABLED=false` ; aucun redémarrage n’est requis pour le fichier `.env`.
5. Retour code : `git revert 02fa81e` (puis, si nécessaire, les commits `4898a8e` et `ee0a899`) dans le dépôt de la passerelle.

Le fichier `mazz_control/.env` peut contenir des secrets en clair ; il est ignoré par Git et ne doit jamais être ajouté à un commit ou copié dans un rapport. Le sentinelle `anonymous` sert uniquement aux fournisseurs qui acceptent explicitement l’accès sans clé.

## Limites connues

- `registry_only` stocke et teste les clés mais n’est pas encore routé.
- Les identifiants de modèles initiaux doivent être confirmés dans la console du fournisseur avant usage ; le test expose les modèles disponibles quand l’API le permet.
- `amd_radeon` et `apinex` n’ont pas d’URL vérifiée et restent inutilisables tant que leurs API ne sont pas confirmées.
- La promotion IteraCompute mentionnée par le registre est limitée au 24 novembre 2026, 00:00 heure du Pacifique.
- Les quotas dépendent des comptes et des fournisseurs ; les valeurs déclarées ne garantissent pas une disponibilité ou un coût nul.

## Auto-hébergement

Les exemples Oracle, Modal et Hugging Face Space sous `selfhost/` sont des recettes de déploiement, pas des services déployés par ce dépôt. Voir leurs README respectifs. Configurez `LOCAL_ORACLE_URL`, `LOCAL_MODAL_URL` ou `HF_SPACE_USER`/`HF_SPACE_NAME` et leurs clés seulement après déploiement.
