# 05 — Calcul GPU : Orchestration Modal Labs et Serverless

## 1. Architecture Serverless Scale-to-Zero

Modal Labs permet d'instancier des conteneurs GPU (NVIDIA L40S, A100) en quelques secondes avec une facturation stricte à la seconde d'utilisation :
- **Mode passif (`passive: true`)** : Contrairement aux serveurs permanents, l'instance Modal ne reçoit aucune sonde de santé périodique pour éviter de réveiller inutilement le conteneur et d'engager des coûts.
- **Réveil à la demande** : Lorsqu'une requête vise explicitement un modèle hébergé sur Modal, la passerelle émet la requête HTTP vers le endpoint serverless, déclenchant le conteneur à froid.
- **Spend-Limit à 0.00 $** : Par défaut, le compte propriétaire dispose d'une limite de dépense stricte interdisant tout prélèvement au-delà des crédits alloués.

