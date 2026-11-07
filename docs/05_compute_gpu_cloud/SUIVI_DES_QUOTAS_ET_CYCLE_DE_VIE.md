# 05 — Calcul GPU : Suivi des quotas et cycle de vie

## 1. Comptabilité locale des heures GPU

Kaggle ne fournissant pas d'API publique pour interroger le solde d'heures restantes en cours de semaine, MAZZ Code implémente un système de suivi local précis dans `mazz_sessions.db` :
- Chaque session lancée sur `kaggle_t4` enregistre son heure de démarrage (`start_time`), sa durée réelle et ses battements de cœur périodiques (*heartbeats*).
- La fenêtre glissante hebdomadaire est calculée à partir du samedi précédent à 00:00 UTC jusqu'au samedi suivant.
- Dès que le cumul des heures atteint 27 heures sur les 30 autorisées, l'application bascule en alerte critique (*critical*). Au-delà de 29 heures, les lancements sont bloqués pour éviter la suspension du compte.

## 2. Parallélisation de la collecte des quotas

La collecte sur `/api/quotas` agrège 5 sources en parallèle :
- Colab via le CLI sous WSL Debian.
- Modal via `modal billing summary --json`.
- Kaggle via la base locale et `kaggle kernels list`.
- Groq via l'envoi d'une requête minimale et lecture des headers `x-ratelimit-*`.
- Local via `/metrics` de `llama-server`.
Grâce au patron *stale-while-revalidate*, l'interface reçoit instantanément les données en cache et ne subit jamais de temps de latence au chargement.

