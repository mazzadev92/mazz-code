# 06 — Desktop & Portable : Embarquement des runtimes Node, Python et llama.cpp

## 1. Structure du dossier `resources/`

Le dossier de ressources empaqueté avec l'application contient l'ensemble des dépendances d'exécution natives :
- `resources/node/` : Binaire `node.exe` officiel 24.22.2 sans dépendance d'installation globale.
- `resources/python/` : Distribution embarquée Python 3.12.10 avec fichier `python._pth` configuré pour charger `Lib/site-packages`. Les packages tiers (`fastapi`, `uvicorn`, `httpx`, `modal`, `kaggle`, `pydantic`) y sont pré-installés.
- `resources/llama/` : Moteur `llama-server.exe` optimisé pour Windows x64.
- `resources/cloudflared/` : Binaire `cloudflared.exe` pour le tunneling sortant Zero-Trust.
- `resources/gateway/` : Bytecode compilé `.pyc` de la passerelle. Les sources `.py` sont supprimées lors du packaging pour fermer le code.

## 2. Fermeture du code et minification

Le script de construction `scripts/build-desktop.mjs` applique une politique de fermeture stricte avant l'empaquetage :
1. Compilation de tous les fichiers Python en bytecode `.pyc` via `compileall -b`.
2. Éradication complète des fichiers `.py` et des répertoires `__pycache__`.
3. Minification du code JavaScript serveur via `esbuild`.
4. Encapsulation du Studio dans une archive ASAR protégée.

