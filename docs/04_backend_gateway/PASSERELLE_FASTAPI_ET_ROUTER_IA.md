# 04 — Passerelle : Architecture FastAPI et Routeur IA

## 1. Rôle de la passerelle `mazz_control`

La passerelle Python (FastAPI sur port 7070) constitue le centre névralgique de routage pour toutes les requêtes d'inférence, de calcul et de quotas. Elle dissocie le Studio d'interface des moteurs sous-jacents.

### Fonctionnalités principales :
- Découverte et enregistrement dynamique des moteurs d'inférence (`/api/backends`).
- Contrôle de santé périodique (*health probes*) sur les ports locaux et les tunnels distants.
- Gestion du disjoncteur (Circuit Breaker) pour isoler les fournisseurs défaillants.
- Allocation ordonnée des slots d'inférence pour éviter de surcharger la RAM ou la VRAM de la machine hôte.

## 2. Le disjoncteur d'inférence (Circuit Breaker)

Pour chaque fournisseur distant ou local :
- Un compteur d'échecs consécutifs est maintenu.
- **État Fermé (Closed)** : Fonctionnement nominal, les requêtes sont transmises au backend.
- **État Ouvert (Open)** : Après 3 échecs consécutifs (timeout, erreur 502/503/504, 429 quota dépassé), le disjoncteur s'ouvre. Pendant la période de refroidissement (30 s), les requêtes suivantes sont immédiatement déroutées vers le modèle local de secours sans tenter le réseau.
- **État Semi-ouvert (Half-Open)** : Après le délai de refroidissement, une requête test est tentée. Si elle réussit, le circuit se referme ; en cas de nouvel échec, il se réouvre instantanément.

