# 07 — Réseau : Auto-détection LAN et serveurs locaux

## 1. Découverte automatique des runtimes d'inférence

Au démarrage ou lors d'un appel à `/api/backends` ou `POST /api/backends/scan-lan`, la passerelle sonde de manière non-bloquante (délai d'attente maximal de 800 ms) les ports standards utilisés par les serveurs d'inférence open-source :
- **Port 11434** : Détection du serveur **Ollama** (`http://127.0.0.1:11434/v1/models`).
- **Port 1234** : Détection de **LM Studio** (`http://127.0.0.1:1234/v1/models`).
- **Port 8000** : Détection d'un serveur local **vLLM** (`http://127.0.0.1:8000/v1/models`).

## 2. Enregistrement dynamique sans configuration

Dès qu'un serveur répond positivement sur l'un de ces ports :
1. La passerelle extrait la liste des modèles actuellement chargés ou téléchargés.
2. Une entrée est générée dynamiquement dans le registre des backends (`ollama-local`, `lmstudio-local`, etc.) avec le drapeau `builtin: true`.
3. Les modèles associés apparaissent immédiatement dans la liste des modèles utilisables par l'agent ou sélectionnables dans l'interface, sans exiger de saisie manuelle d'URL ou de clé API par l'utilisateur.
4. Si le serveur tiers est éteint ultérieurement, la sonde de santé le détecte et le retire proprement de la liste des cibles actives sans bloquer le système.

