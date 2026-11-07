# 06 — Desktop & Portable : Installeur NSIS vs Package Portable

## 1. Tableau comparatif des deux cibles de livraison

| Caractéristique | Version Publique (Installeur) | Version Privée (Portable) |
| :--- | :--- | :--- |
| **Fichier / Format** | `Mazz-Code-1.2.0-Setup.exe` (NSIS) | Répertoire `Mazz Code Portable/` |
| **Diffusion autorisée** | Publique, libre, distribuable à des tiers | Privée et confidentielle (Propriétaire uniquement) |
| **Données utilisateur** | Vierges de toute clé ou compte | Profils Modal, Kaggle et Hugging Face pré-intégrés |
| **Stockage des données** | `%APPDATA%/Mazz Code/` | Sous-dossier local `data/` (`portable.flag`) |
| **Exécution sans installation** | Non (installe dans `AppData/Local/Programs`) | Oui (exécutable direct sur clé USB) |
| **Modèles inclus** | Aucun (dossier `models/` vide) | Aucun (l'utilisateur ajoute ses `.gguf` dans `models/`) |

## 2. Procédure d'assemblage

L'assemblage des livrables s'effectue par deux scripts coordonnés :
1. `node scripts/build-desktop.mjs` : Construit la version décompressée dans `build/desktop/output/win-unpacked` et l'installeur NSIS dans `build/desktop/output/`.
2. `powershell -File "D:\Mazz Code\Mazz Code AE\assemble-portable.ps1"` : Duplique la version décompressée vers `Mazz Code AE\Mazz Code Portable`, y injecte le flag `portable.flag`, copie le dossier `data/` privé contenant les profils Modal et Kaggle, et vérifie la présence de `cloudflared.exe`.

