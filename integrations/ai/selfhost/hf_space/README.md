# Hugging Face Space (Docker)

Créez un Space privé ou public de type Docker, ajoutez ce dossier comme source, puis configurez `MODEL_FILE` (chemin du GGUF disponible dans le conteneur) et éventuellement `HF_SPACE_API_KEY` et `CTX_SIZE`. Le conteneur écoute sur le port 7860 et fournit l’API llama.cpp sous `/v1`.

Dans le gateway, renseignez `HF_SPACE_USER`, `HF_SPACE_NAME` et la clé `HF_SPACE_API_KEY` selon l’entrée correspondante de `registry.yaml`. Utilisez un Space privé si le modèle ou l’API ne doit pas être exposé ; protégez aussi le secret côté Space. Les limites CPU/RAM, veille et disponibilité varient selon l’offre Hugging Face. Aucun Space n’est déployé par ce dépôt.
