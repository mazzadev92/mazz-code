# Integration des Fournisseurs LLM Anonymes et Systeme de Cascade

Ce document detaille l'integration des fournisseurs LLM anonymes (sans inscription ni cle API) et le fonctionnement du moteur de cascade et repli automatique dans MAZZ AGENT STUDIO.

---

## 1. Fournisseurs Anonymes Integres

### 1.1 OVHcloud AI Endpoints (`ovh-ai`)
- **Base URL** : `https://oai.endpoints.kepler.ai.cloud.ovh.net/v1`
- **Protocole** : Compatible OpenAI Wire Protocol (Chat Completions & Models).
- **Authentification** : Aucune cle requise (`requiresApiKey: false`). Aucun entete d'autorisation n'est emis.
- **Quota anonyme** : 2 requetes / minute / IP / modele.
- **En-tetes de debordement observes** : `Retry-After`, `ratelimit-reset`, `ratelimit-remaining: 0`.
- **Filtrage des modeles** : Filtrage dynamique des modeles d'embeddings (`bge-`), de vision/diffusion (`stable-diffusion`, `flux-`) et vocaux (`whisper`, `nvr-tts`) afin d'exposer uniquement les 13 modeles conversationnels et de code reels (`Mistral-Nemo-Instruct-2407`, `Qwen3.5-9B`, `Meta-Llama-3_3-70B-Instruct`, `Mistral-Small-3.2-24B-Instruct-2506`, `gpt-oss-120b`, `gpt-oss-20b`, `Qwen3.6-27B`, `Qwen3.8-27B`, etc.).
- **Modele par defaut** : `Mistral-Nemo-Instruct-2407`.
- **Avertissement Quota** : Quota indicatif et non garanti (service public experimental OVHcloud sujet a variations ou indisponibilite).

### 1.2 llmfaucet (`llmfaucet`)
- **Base URL** : `https://api.llmfaucet.dev/v1`
- **Protocole** : Compatible OpenAI Chat Completions.
- **Authentification** : `Bearer free` (cle factice reservee pour les clients ou proxys imposant un entete d'autorisation). `requiresApiKey: false`.
- **Quota annonce** : 20 requetes / jour / IP.
- **Routeurs / modeles** : `auto:coding` (par defaut), `auto`, `auto:fast`, `auto:smart`.
- **Etat reel constate lors des tests** : Nom de domaine non resolu par les DNS publics (`getaddrinfo ENOTFOUND api.llmfaucet.dev`).
- **Gestion de la disponibilite** : Initialise avec `isAvailable: false`. En cas d'appel, l'erreur de connexion `ENOTFOUND` est classee comme recuperable et declenche instantanement la bascule vers le fournisseur suivant dans la cascade (OVHcloud).
- **Avertissement Quota** : Quota indicatif et non garanti (faucet communautaire pouvant etre sature ou temporairement hors ligne).

---

## 2. Architecture du Systeme de Cascade (`CascadeManager`)

Le moteur de cascade (`packages/providers/src/cascade.ts`) orchestre la selection, la verification et la bascule automatique entre candidats selon une hierarchie configurable :

```
Demande utilisateur
        │
        ▼
Cascade Sequence
  1. Modele local configure (llama-local : GGUF)
        │ (si 503 indisponible, crash ou non demarre)
        ▼
  2. Provider API principal configure (Groq : llama-3.3-70b-versatile)
        │ (si 429 rate limit ou TPM 8000 depasse)
        ▼
  3. llmfaucet (auto:coding)
        │ (si DNS ENOTFOUND ou timeout)
        ▼
  4. OVHcloud AI Endpoints (Mistral-Nemo-Instruct-2407)
```

### 2.1 Classification des Erreurs : Recuperables vs Non-Recuperables

| Code / Type d'Erreur | Classification | Action de la Cascade |
|---|---|---|
| **HTTP 429** (Rate Limit) | Recuperable | Parse `Retry-After`, active le cooldown du provider, bascule vers le suivant. |
| **HTTP 5xx** (500, 502, 503, 504) | Recuperable | Cooldown 30s, bascule vers le suivant. |
| **HTTP 404** (Model not found) | Recuperable | Cooldown 30s, bascule vers le suivant. |
| **Erreurs Reseau** (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`) | Recuperable | Cooldown 30s, bascule vers le suivant. |
| **Erreur de flux** (`PROVIDER_STREAM_ERROR`, fragment corrompu) | Recuperable | Cooldown 20s, bascule vers le suivant. |
| **HTTP 400** (Bad Request) | **Non-recuperable** | Arret immediat, remonte l'erreur sans bascule. |
| **HTTP 413** (Context length exceeded) | **Non-recuperable** | Arret immediat, confié au compacteur / gestionnaire de contexte. |
| **Interruption Utilisateur** (`AbortError`) | **Non-recuperable** | Arret immediat. |
| **LOCAL STRICT Violation** | **Non-recuperable** | Arret immediat conformement a la politique de securite locale. |

### 2.2 Gestion des Cooldowns et `Retry-After`

- Lorsqu'un fournisseur repond par un HTTP 429 ou 5xx avec l'en-tete standard `Retry-After: <secondes>`, le `CascadeManager` enregistre un cooldown exact correspondant a cette duree.
- Durant cette periode, le fournisseur est marque en etat `cooling_down` et est automatiquement ignore lors des tentatives de cascade, evitant d'aggraver la saturation ou de subir des delais reseau inutiles.
- Des l'expiration du delai, le statut repasse en `healthy` et le fournisseur redevient eligible.

### 2.3 Protection Anti-Boucle et Isolation des Outils

- **Anti-boucle** : Au sein d'un tour de generation, un ensemble `attempted = new Set<string>()` garantit qu'aucun fournisseur n'est appele plus d'une fois.
- **Epuisement propre** : Si tous les fournisseurs de la cascade echouent, l'evenement `{ type: 'error', code: 'CASCADE_EXHAUSTED' }` est emis proprement avec le diagnostic du dernier echec.
- **Zero double execution d'outils** : Les appels d'outils ne sont transmis pour execution qu'apres la finalisation complete d'un flux de reponse par un fournisseur. Une bascule survenue au cours de la generation ne provoque jamais d'action partielle sur les fichiers ou le terminal.

---

## 3. Parametres et Interface Utilisateur

1. **Fournisseurs (`ProvidersView.tsx`)** :
   - Badge specifique `Anonyme (Sans cle)` pour les providers anonymes.
   - Suppression complete des champs de saisie de cle API pour ces providers.
   - Mention expresse des quotas non garantis.
   - Carte de monitoring de la cascade affichant l'etat en temps reel de chaque etape (`Opérationnel`, `Cooldown`, `Indisponible`) avec bouton de test direct.
2. **Parametres (`SettingsView.tsx`)** :
   - Section dediee `Cascade et Résilience (Modèles Anonymes)`.
   - Reglage du commutateur global (`cascade.enabled`), du nombre max de bascules (`cascade.maxFallbacks`, 1 a 10) et du cooldown par defaut (`cascade.cooldownSec`, 5 a 600s).
3. **Barre de Statut Cognitive (`LiveStatusLine.tsx`)** :
   - Indicateur visuel `BASCULE CASCADE` en cas de transition active.
4. **Historique des Echanges (`TurnView.tsx`)** :
   - Banniere d'information contextuelle indiquant le fournisseur relaye et le fournisseur effectif ayant repondu.

---

## 4. Resultats des Tests Reels

- **OVHcloud AI Endpoints** :
  - `GET /v1/models` : Succes HTTP 200 (264 ms), 22 modeles detectes, 13 modeles conversationnels exposes.
  - `POST /v1/chat/completions` non-streaming : Succes HTTP 200 (101 ms), reponse valide.
  - `POST /v1/chat/completions` streaming SSE : Succes HTTP 200, flux de jetons continu.
  - Quota 429 : En-tete `Retry-After: 31` verifie et applique au cooldown.
- **llmfaucet** :
  - `testConnection` : Echec de resolution DNS (`fetch failed: getaddrinfo ENOTFOUND api.llmfaucet.dev`).
  - Cascade live : Bascule immediate sans latence parasite vers OVHcloud qui a rendu la reponse sans echec pour l'utilisateur.
