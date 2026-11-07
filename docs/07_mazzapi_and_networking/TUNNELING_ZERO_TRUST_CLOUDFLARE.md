# 07 — Réseau : Tunneling Zero-Trust Cloudflare

## 1. Intégration de `cloudflared.exe`

Pour permettre aux sessions d'inférence déportées (Kaggle, Colab, instances distantes) ou aux clients mobiles de joindre en toute sécurité la passerelle locale `mazz_control` sans exiger d'ouverture de port NAT sur la box internet ou le pare-feu :
- Le binaire `cloudflared.exe` (Cloudflare Tunnel) est embarqué directement dans les ressources de l'application sous `resources/cloudflared/cloudflared.exe`.
- Le script `scripts/mazz-tunnel.ps1` résout automatiquement l'exécutable local avant de chercher dans d'éventuels dossiers de téléchargements.

## 2. Fonctionnement du Quick Tunnel TLS

1. Le script initialise un tunnel TLS sortant vers les serveurs périphériques Cloudflare :
   ```powershell
   cloudflared tunnel --url http://127.0.0.1:7070
   ```
2. Cloudflare attribue une URL publique temporaire en HTTPS (`https://*.trycloudflare.com`).
3. La passerelle locale exige le jeton d'authentification `X-Mazz-Key` sur tous les endpoints sensibles. Même accessible via l'URL publique, la passerelle rejette immédiatement tout appel non authentifié.

