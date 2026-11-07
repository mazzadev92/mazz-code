# 04 — Passerelle : Chiffrement DPAPI et gestion des secrets

## 1. Mécanisme Windows DPAPI

Sous Windows, la passerelle utilise les fonctions natives de `crypt32.dll` pour protéger les secrets stockés sur le disque :
- `CryptProtectData` chiffre le jeton avec une clé dérivée cryptographiquement de la session de connexion Windows de l'utilisateur.
- Les données chiffrées sont encodées en base64 et stockées sous la clé `api_key_dpapi` dans `backends.json`.
- En cas de migration ou de lecture d'une ancienne version contenant des clés en clair, la passerelle les chiffre automatiquement à chaud et réécrit le fichier.

## 2. Étanchéité des réponses d'API et journaux

- Aucun endpoint public de la passerelle (`GET /api/backends`, `GET /api/quotas`, `GET /api/status`) ne renvoie la clé API en clair.
- L'objet renvoyé au client contient uniquement `has_key: true|false`.
- Les fonctions de journalisation filtrent expressément toute variable sensible avant émission vers les fichiers de logs.

