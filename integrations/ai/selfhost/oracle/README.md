# Oracle Cloud / VM autonome

Installez Docker Compose, placez `model.gguf` dans `./models` (ou configurez `MODEL_DIR` et `MODEL_FILE`), puis créez un fichier `.env` non versionné contenant au minimum `LOCAL_ORACLE_KEY`. Le service llama.cpp écoute sur le loopback du serveur au port 8000 ; publiez-le derrière un tunnel TLS/authentifié si le gateway est sur une autre machine.

```sh
docker compose --profile oracle up -d llama.cpp
```

Pour une VM x86 avec GPU NVIDIA et assez de VRAM, le profil vLLM offre un serveur compatible OpenAI : définissez `MODEL_REPO`, puis lancez `docker compose --profile vllm up -d vllm`. Il faut installer au préalable le runtime NVIDIA Container Toolkit. Les profils isolent les deux services qui réutilisent le port 8000.

Pour systemd, copiez le compose, son `.env` et `mazz-llm.service` dans `/opt/mazz/oracle`, puis exécutez `systemctl enable --now mazz-llm`. Pour connecter le gateway, définissez `LOCAL_ORACLE_URL=http://<hote>:8000/v1` et la clé du fournisseur `LOCAL_ORACLE_KEY` dans son `.env`.

Ce dossier décrit un déploiement à effectuer. Aucun serveur Oracle n’est déployé par cette recette.
