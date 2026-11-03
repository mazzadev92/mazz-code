# SETUP - checklist des fournisseurs IA

Genere depuis `registry.yaml` par `python -m integrations.ai.generate_docs` : ne modifiez pas ce fichier a la main.
Cochez les cases au fil de vos inscriptions ; les noms de variables sont ceux a coller dans `mazz_control/.env`.
Les chemins de menus des consoles changent : en cas d'ecart, fiez-vous au libelle a l'ecran.

| Suivi | Valeur |
|---|---|
| Fournisseurs dans le registre | 41 |
| Fournisseurs configures (cle posee) | __ / 41 (voir GET /integrations/status) |
| Capacite quotidienne cumulee si tout est configure (requetes/jour declarees) | 17 950 + tokens et credits non convertibles |

## Regles de protection carte (fournisseurs avec carte ou depot)

- Utilisez une carte virtuelle plafonnee a 1-2 EUR (ou une carte prepayee), jamais votre carte principale.
- Desactivez l'auto-recharge / le renouvellement automatique et fixez une limite de depense a 0 quand l'option existe.
- Surveillez la premiere facture : un depassement silencieux est le seul vrai risque.
- Rotation : creez une nouvelle cle, remplacez-la dans `.env` (prise en compte en moins de 5 s), puis revoquez l'ancienne dans la console.

## Auto-heberges (essayes en premier)

### Oracle VM (vLLM / llama.cpp) (`local_oracle`)

- **Inscription** : https://www.oracle.com/cloud/free/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : Pas de console : la cle est celle que vous passez a vllm --api-key (LOCAL_ORACLE_KEY), ou vide.
- **Variable(s) `.env`** : `LOCAL_ORACLE_KEY`, `LOCAL_ORACLE_URL` (cle optionnelle : `anonymous` sans compte)
- **Quota** : non plafonne cote client. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Inference illimitee sur votre propre VM, 24/7.
- **Notes** : VM Always Free (ARM). Voir selfhost/oracle. Cle optionnelle (vLLM --api-key).
- **Routage** : priorite 1, classe selfhost.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Modal (vos poids) (`local_modal`)

- **Inscription** : https://modal.com/
- **Prerequis** : carte : oui - carte requise ; telephone : non.
- **Ou trouver la cle** : Secret Modal mazz-vllm-key (VLLM_API_KEY) que vous creez : modal secret create.
- **Variable(s) `.env`** : `LOCAL_MODAL_KEY`, `LOCAL_MODAL_URL`
- **Quota** : non plafonne cote client. **Reinitialisation** : jamais (credit unique).
- **En pratique** : 30 $/mois de credit Modal recurrents ; le routeur l'utilise avant les gratuits.
- **Notes** : URL donnee par `modal deploy` (LOCAL_MODAL_URL, terminee par /v1). Scale-to-zero : le premier appel peut etre lent.
- **Routage** : priorite 2, classe selfhost.
- **Protection carte** : carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Hugging Face Space (endpoint vLLM) (`local_hf_space`)

- **Inscription** : https://huggingface.co/spaces
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : Cle de votre choix (LOCAL_HF_SPACE_KEY), ou jeton HF si le Space est prive.
- **Variable(s) `.env`** : `LOCAL_HF_SPACE_KEY`, `HF_SPACE_USER`, `HF_SPACE_NAME` (cle optionnelle : `anonymous` sans compte)
- **Quota** : non plafonne cote client. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Secours gratuit sans quota de requetes, debit faible.
- **Notes** : Variables HF_SPACE_USER et HF_SPACE_NAME. Space CPU gratuit : lent, a reserver aux petits modeles.
- **Routage** : priorite 3, classe selfhost.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

## Chat (gratuits, par priorite)

### NVIDIA NIM (`nim`)

- **Inscription** : https://build.nvidia.com/
- **Prerequis** : carte : non ; telephone : oui - verification telephone.
- **Ou trouver la cle** : build.nvidia.com > profil (en haut a droite) > API Keys > Generate API Key.
- **Variable(s) `.env`** : `NIM_KEY`
- **Quota** : 40 rpm. **Reinitialisation** : continu (fenetre glissante).
- **En pratique** : 40 requetes/min sur un large catalogue de modeles ouverts.
- **Notes** : Verification telephone a l'inscription. Id de modele non confirme : verifier avec Tester.
- **Routage** : priorite 10, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Groq (`groq`)

- **Inscription** : https://console.groq.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : console.groq.com > API Keys > Create API Key.
- **Variable(s) `.env`** : `GROQ_KEY`
- **Quota** : 30 rpm, 14 400 req/fenetre. **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : Reponses tres rapides ; ideal pour agents et petits traitements.
- **Notes** : Les plafonds reels varient par modele : 14400 rpd vaut pour les modeles 8B.
- **Routage** : priorite 11, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### AMD Radeon Cloud (`amd_radeon`)

- **Inscription** : https://developer.amd.com/ai-developer-program/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : A determiner apres verification du programme AMD AI Developer.
- **Variable(s) `.env`** : `AMD_RADEON_KEY`
- **Quota** : non plafonne cote client. **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : Inconnu tant que l'offre n'est pas confirmee.
- **Notes** : NON VERIFIE. AMD documente 100 $ de credits GPU (AMD Developer Cloud, 30 jours) pour auto-heberger vLLM, pas une API hebergee a 10 $/jour. Ne pas activer sans URL officielle.
- **Routage** : priorite 23, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Google AI Studio (Gemini) (`aistudio`)

- **Inscription** : https://aistudio.google.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : aistudio.google.com > Get API key > Create API key.
- **Variable(s) `.env`** : `AISTUDIO_KEY`
- **Quota** : 1 500 req/fenetre. **Reinitialisation** : chaque jour a 00:00 (America/Los_Angeles).
- **En pratique** : Contexte tres long (1M) et vision ; 1500 requetes/jour.
- **Notes** : Reset a minuit heure du Pacifique (fuseau a confirmer dans la console).
- **Routage** : priorite 12, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Cerebras (`cerebras`)

- **Inscription** : https://cloud.cerebras.ai/
- **Prerequis** : carte : oui - carte requise ; telephone : non.
- **Ou trouver la cle** : cloud.cerebras.ai > API Keys > Create new key.
- **Variable(s) `.env`** : `CEREBRAS_KEY`
- **Quota** : 5 rpm, 1 000 000 tokens/fenetre. **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : 1M tokens/jour, tres rapide.
- **Notes** : Carte demandee a l'inscription (verifier si encore necessaire).
- **Routage** : priorite 13, classe free.
- **Protection carte** : carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### ModelScope (`modelscope`)

- **Inscription** : https://modelscope.cn/
- **Prerequis** : carte : non ; telephone : oui - verification telephone.
- **Ou trouver la cle** : modelscope.cn > Mon espace > Jeton d'acces (Access Token).
- **Variable(s) `.env`** : `MODELSCOPE_KEY`
- **Quota** : 2 000 req/fenetre. **Reinitialisation** : chaque jour a 00:00 (Asia/Shanghai).
- **En pratique** : 2000 requetes/jour sur des modeles ouverts recents.
- **Notes** : Compte chinois : verification telephone. Fuseau de reset suppose Asia/Shanghai (a confirmer).
- **Routage** : priorite 17, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Z.ai (Zhipu GLM) (`zai`)

- **Inscription** : https://z.ai/
- **Prerequis** : carte : non ; telephone : oui - verification telephone.
- **Ou trouver la cle** : z.ai > Manage API Keys > Create a new API key.
- **Variable(s) `.env`** : `ZAI_KEY`
- **Quota** : non plafonne cote client. **Reinitialisation** : continu (fenetre glissante).
- **En pratique** : Modeles GLM Flash gratuits, sans plafond dur documente.
- **Notes** : Seuls les modeles Flash sont gratuits ; les autres sont facturables.
- **Routage** : priorite 18, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### LLM7.io (`llm7`)

- **Inscription** : https://llm7.io/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : llm7.io > Get token (optionnel).
- **Variable(s) `.env`** : `LLM7_KEY` (cle optionnelle : `anonymous` sans compte)
- **Quota** : 100 000 tokens/fenetre. **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : 100k tokens/jour sans compte : filet de securite.
- **Notes** : Fonctionne sans cle (limites plus basses) ; une cle est optionnelle.
- **Routage** : priorite 21, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### OpenRouter (`openrouter`)

- **Inscription** : https://openrouter.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : openrouter.ai > menu du profil > Keys > Create Key.
- **Variable(s) `.env`** : `OPENROUTER_KEY`
- **Quota** : 20 rpm, 50 req/fenetre. **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : Passerelle vers de nombreux modeles gratuits.
- **Notes** : Modeles ':free' uniquement. 50 requetes/jour, 1000 apres un depot unique de 10 $ (non conseille ici).
- **Routage** : priorite 14, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Mistral La Plateforme (`mistral`)

- **Inscription** : https://console.mistral.ai/
- **Prerequis** : carte : non ; telephone : oui - verification telephone.
- **Ou trouver la cle** : console.mistral.ai > API Keys > Create new key.
- **Variable(s) `.env`** : `MISTRAL_KEY`
- **Quota** : 60 rpm. **Reinitialisation** : continu (fenetre glissante).
- **En pratique** : Bons modeles generalistes et code, europeens.
- **Notes** : Plan gratuit (Experiment) : verification telephone, donnees possiblement utilisees pour l'entrainement. Plafond rpm a confirmer dans la console.
- **Routage** : priorite 15, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### DeepInfra (`deepinfra`)

- **Inscription** : https://deepinfra.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : deepinfra.com > Dashboard > API Keys > New API Key.
- **Variable(s) `.env`** : `DEEPINFRA_KEY`
- **Quota** : budget : 5 USD/mois, suivi cote DeepInfra. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Large catalogue, tarifs bas apres le credit.
- **Notes** : 5 $/mois (le credit se consomme a l'usage, pas de compteur client).
- **Routage** : priorite 40, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Novita AI (`novita`)

- **Inscription** : https://novita.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : novita.ai > Settings > Key Management > Add New Key.
- **Variable(s) `.env`** : `NOVITA_KEY`
- **Quota** : budget : 0.50 USD une fois. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Credit de depart pour tests.
- **Notes** : 0,50 $ de credit unique (non renouvele).
- **Routage** : priorite 41, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Nebius Token Factory (`nebius`)

- **Inscription** : https://tokenfactory.nebius.com/
- **Prerequis** : carte : oui - carte requise ; telephone : non.
- **Ou trouver la cle** : tokenfactory.nebius.com > API keys > Create API key.
- **Variable(s) `.env`** : `NEBIUS_KEY`
- **Quota** : budget : 1 USD / 30 jours. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Credit court, a utiliser en dernier.
- **Notes** : 1 $ pendant 30 jours, carte demandee.
- **Routage** : priorite 43, classe credit.
- **Protection carte** : carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Fireworks AI (`fireworks`)

- **Inscription** : https://fireworks.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : fireworks.ai > Account > API Keys > Create API key.
- **Variable(s) `.env`** : `FIREWORKS_KEY`
- **Quota** : budget : 1 USD une fois. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Credit de depart, inference rapide.
- **Notes** : 1 $ de credit unique.
- **Routage** : priorite 42, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Vercel AI Gateway (`vercel_gateway`)

- **Inscription** : https://vercel.com/docs/ai-gateway
- **Prerequis** : carte : oui - carte requise ; telephone : non.
- **Ou trouver la cle** : vercel.com > onglet AI Gateway > API Keys > Create key.
- **Variable(s) `.env`** : `VERCEL_GATEWAY_KEY`
- **Quota** : budget : 5 USD / 30 jours. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Acces a tout le catalogue avec un seul credit.
- **Notes** : 5 $ tous les 30 jours (fenetre glissante cote Vercel, approximee ici par le 1er du mois). Carte requise.
- **Routage** : priorite 44, classe credit.
- **Protection carte** : carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### OVHcloud AI Endpoints (`ovh_endpoints`)

- **Inscription** : https://endpoints.ai.cloud.ovh.net/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : Manager OVHcloud > Public Cloud > AI Endpoints > API keys.
- **Variable(s) `.env`** : `OVH_ENDPOINTS_KEY` (cle optionnelle : `anonymous` sans compte)
- **Quota** : 12 rpm. **Reinitialisation** : continu (fenetre glissante).
- **En pratique** : Hebergement europeen ; fonctionne meme sans cle.
- **Notes** : URL confirmee par la doc OVHcloud (guide LiteLLM) et des passerelles tierces. Sans cle : acces gratuit avec limites de debit (rpm a confirmer).
- **Routage** : priorite 20, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Ollama Cloud (`ollama_cloud`)

- **Inscription** : https://ollama.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : ollama.com > Settings > Keys (ollama.com/settings/keys) > Add API Key.
- **Variable(s) `.env`** : `OLLAMA_CLOUD_KEY`
- **Quota** : budget : Quota gratuit non publie : voir la page d'usage Ollama. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Modeles cloud avec quota mensuel gratuit.
- **Notes** : URL confirmee (docs.ollama.com). Limites non publiees : voir ollama.com/pricing et la page d'usage.
- **Routage** : priorite 25, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### IteraCompute (`itera`)

- **Inscription** : https://iteracompute.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : iteracompute.com > Dashboard > API Keys.
- **Variable(s) `.env`** : `ITERA_KEY`
- **Quota** : 160 000 tpm, 30 000 000 tokens/fenetre. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : 30M tokens/mois sur un 27B (jusqu'au 24 novembre 2026).
- **Notes** : Confirme sur iteracompute.com/docs.html : palier gratuit Qwen3.8-27B 30M tokens/mois. La promotion gratuite se termine le 2026-11-24 00:00 heure du Pacifique. File d'attente possible (jusqu'a 120 s).
- **Routage** : priorite 19, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### APInex (`apinex`)

- **Inscription** : https://apinex.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : A determiner.
- **Variable(s) `.env`** : `APINEX_KEY`
- **Quota** : non plafonne cote client. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Inconnu.
- **Notes** : NON VERIFIE : service introuvable. L'offre '10M tokens/mois' ne repose que sur ressources.txt.
- **Routage** : priorite 24, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Cloudflare Workers AI (`cloudflare`)

- **Inscription** : https://dash.cloudflare.com/sign-up
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : dash.cloudflare.com > Workers AI > Use REST API > Create a Workers AI API Token ; Account ID dans la meme page.
- **Variable(s) `.env`** : `CLOUDFLARE_KEY`, `CLOUDFLARE_ACCOUNT_ID`
- **Quota** : budget : 10000 neurons/jour, suivi cote Cloudflare. **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : Embeddings et petits LLM gratuits, reset 00:00 UTC.
- **Notes** : Variables CLOUDFLARE_KEY (jeton API Workers AI) et CLOUDFLARE_ACCOUNT_ID. 10 000 neurons/jour (compteur non expose par l'API).
- **Routage** : priorite 16, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Cohere (`cohere`)

- **Inscription** : https://dashboard.cohere.com/welcome/register
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : dashboard.cohere.com > API Keys > Trial key (Create).
- **Variable(s) `.env`** : `COHERE_KEY`
- **Quota** : 20 rpm, 1 000 req/fenetre. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Rerank et embeddings de qualite ; 1000 appels/mois.
- **Notes** : Cle trial : 1000 appels/mois, usage non commercial. Ids de modeles a confirmer avec Tester.
- **Routage** : priorite 22, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

## Embeddings et rerank

### Voyage AI (`voyage`)

- **Inscription** : https://www.voyageai.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : dashboard.voyageai.com > API keys > Create new secret key.
- **Variable(s) `.env`** : `VOYAGE_KEY`
- **Quota** : budget : 200M tokens/modele, suivi cote Voyage. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Meilleurs embeddings pour RAG, gros volume gratuit.
- **Notes** : 200M tokens gratuits par modele (unique). Ids a confirmer avec Tester.
- **Routage** : priorite 10, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Jina AI (`jina`)

- **Inscription** : https://jina.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : jina.ai > API (jina.ai/?sui=apikey) : la cle est affichee sur la page.
- **Variable(s) `.env`** : `JINA_KEY`
- **Quota** : budget : 10M tokens, suivi cote Jina. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Embeddings, reranker et lecture de pages.
- **Notes** : 10M tokens gratuits (unique).
- **Routage** : priorite 11, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

## Audio (voix, transcription)

### ElevenLabs (`elevenlabs`)

- **Inscription** : https://elevenlabs.io/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : elevenlabs.io > Developers > API Keys > Create API Key.
- **Variable(s) `.env`** : `ELEVENLABS_KEY`, `ELEVENLABS_VOICE_ID`
- **Quota** : 10 000 characters. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Synthese vocale de haute qualite, 10k caracteres/mois.
- **Notes** : 10000 credits/mois (1 credit = 1 caractere sur les modeles standard). Variable optionnelle ELEVENLABS_VOICE_ID.
- **Routage** : priorite 10, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Cartesia (`cartesia`)

- **Inscription** : https://cartesia.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : play.cartesia.ai > Keys (play.cartesia.ai/keys) > Create.
- **Variable(s) `.env`** : `CARTESIA_KEY`, `CARTESIA_VOICE_ID`
- **Quota** : 20 000 credits. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : TTS tres faible latence, 20k credits/mois.
- **Notes** : Doc officielle 2026-11 : Authorization Bearer + Cartesia-Version 2026-08-14 (et non X-API-Key). Variable CARTESIA_VOICE_ID requise ; id de modele a confirmer.
- **Routage** : priorite 11, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Deepgram (`deepgram`)

- **Inscription** : https://deepgram.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : console.deepgram.com > Settings > API Keys > Create a New API Key.
- **Variable(s) `.env`** : `DEEPGRAM_KEY`
- **Quota** : budget : 200 USD une fois, suivi cote Deepgram. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Transcription rapide, gros credit de depart.
- **Notes** : 200 $ de credit sans expiration. Modele a confirmer.
- **Routage** : priorite 10, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### AssemblyAI (`assemblyai`)

- **Inscription** : https://www.assemblyai.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : assemblyai.com/dashboard > API Keys (page d'accueil du dashboard).
- **Variable(s) `.env`** : `ASSEMBLYAI_KEY`
- **Quota** : budget : 50 USD une fois, suivi cote AssemblyAI. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Transcription avec diarisation et resume.
- **Notes** : 50 $ de credit. API asynchrone (soumission puis interrogation).
- **Routage** : priorite 11, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Speechmatics (`speechmatics`)

- **Inscription** : https://www.speechmatics.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : portal.speechmatics.com > Manage > API Keys.
- **Variable(s) `.env`** : `SPEECHMATICS_KEY`
- **Quota** : budget : 480 min/mois, suivi cote Speechmatics. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Transcription multilingue, 480 min/mois.
- **Notes** : URL issue de la doc courante (hote eu1). API asynchrone par taches : cle stockee et testee, pas encore routee. 480 min/mois.
- **Routage** : aucun (cle stockee et testee, API par taches).
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Gladia (`gladia`)

- **Inscription** : https://www.gladia.io/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : app.gladia.io > API keys.
- **Variable(s) `.env`** : `GLADIA_KEY`
- **Quota** : budget : 10 h/mois, suivi cote Gladia. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Transcription, 10 h/mois.
- **Notes** : Confirme : POST /v2/pre-recorded, en-tete x-gladia-key. API asynchrone : cle stockee et testee, pas encore routee. 10 h/mois.
- **Routage** : aucun (cle stockee et testee, API par taches).
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

## Image et 3D

### Stability AI (`stability`)

- **Inscription** : https://platform.stability.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : platform.stability.ai > Account > API Keys > Create API Key.
- **Variable(s) `.env`** : `STABILITY_KEY`
- **Quota** : budget : 25 credits une fois, suivi cote Stability. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Generation d'images, quelques dizaines d'images.
- **Notes** : 25 credits offerts (unique). Le chemin du modele est un endpoint, pas un id.
- **Routage** : priorite 10, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Recraft (`recraft`)

- **Inscription** : https://www.recraft.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : recraft.ai > Profil > API (token d'API).
- **Variable(s) `.env`** : `RECRAFT_KEY`
- **Quota** : budget : 30 credits/jour (interface web, API a confirmer). **Reinitialisation** : chaque jour a 00:00 (UTC).
- **En pratique** : Images et vecteurs, a verifier avant de compter dessus.
- **Notes** : Confirme : POST /v1/images/generations, Bearer. L'acces API peut exiger un plan payant ; les 30 credits/jour ne valent peut-etre que pour l'interface web.
- **Routage** : priorite 11, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Meshy (`meshy`)

- **Inscription** : https://www.meshy.ai/
- **Prerequis** : carte : oui - carte requise ; telephone : non.
- **Ou trouver la cle** : meshy.ai > Settings > API.
- **Variable(s) `.env`** : `MESHY_KEY`
- **Quota** : budget : 100 credits/mois (interface web). **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : 3D par API uniquement avec abonnement.
- **Notes** : Confirme (docs.meshy.ai) : POST /openapi/v2/text-to-3d. Un compte gratuit recoit 402 : l'API exige un plan payant. Non route.
- **Routage** : aucun (cle stockee et testee, API par taches).
- **Protection carte** : carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Tripo AI (`tripo`)

- **Inscription** : https://www.tripo3d.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : platform.tripo3d.ai > API Keys.
- **Variable(s) `.env`** : `TRIPO_KEY`
- **Quota** : budget : credits API payants. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : 3D par API, usage facture.
- **Notes** : Confirme (developers.tripo3d.ai) : https://openapi.tripo3d.ai, POST /v3/generation/text-to-model, Bearer. Credits API factures (1 credit = 0,01 $) ; gratuite non confirmee. Non route.
- **Routage** : aucun (cle stockee et testee, API par taches).
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### fal.ai (`fal`)

- **Inscription** : https://fal.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : fal.ai/dashboard/keys > Add key.
- **Variable(s) `.env`** : `FAL_KEY`
- **Quota** : budget : ~20 USD une fois, suivi cote fal. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Images rapides (FLUX), credit de depart.
- **Notes** : Environ 20 $ de credit a l'inscription. Appel synchrone sur fal.run/<modele>.
- **Routage** : priorite 12, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

## Recherche et extraction web

### Tavily (`tavily`)

- **Inscription** : https://app.tavily.com/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : app.tavily.com > API Keys (page d'accueil du dashboard).
- **Variable(s) `.env`** : `TAVILY_KEY`
- **Quota** : 1 000 req/fenetre. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Recherche web orientee agents.
- **Notes** : 1000 recherches/mois.
- **Routage** : priorite 10, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Exa (`exa`)

- **Inscription** : https://exa.ai/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : dashboard.exa.ai > API Keys.
- **Variable(s) `.env`** : `EXA_KEY`
- **Quota** : budget : 20 USD une fois, suivi cote Exa. **Reinitialisation** : jamais (credit unique).
- **En pratique** : Recherche semantique.
- **Notes** : 20 $ de credit.
- **Routage** : priorite 12, classe credit.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Brave Search (`brave`)

- **Inscription** : https://brave.com/search/api/
- **Prerequis** : carte : oui - carte requise ; telephone : non.
- **Ou trouver la cle** : api-dashboard.search.brave.com > API Keys.
- **Variable(s) `.env`** : `BRAVE_KEY`
- **Quota** : 60 rpm, 1 000 req/fenetre. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Recherche web independante, 1000 requetes/mois.
- **Notes** : Le plan gratuit peut exiger une carte (non debitee sous le quota). rpm du plan a confirmer.
- **Routage** : priorite 11, classe free.
- **Protection carte** : carte virtuelle 1-2 EUR, auto-recharge desactivee, limite de depense a 0.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)

### Firecrawl (`firecrawl`)

- **Inscription** : https://www.firecrawl.dev/
- **Prerequis** : carte : non ; telephone : non.
- **Ou trouver la cle** : firecrawl.dev/app > API Keys.
- **Variable(s) `.env`** : `FIRECRAWL_KEY`
- **Quota** : 1 000 req/fenetre. **Reinitialisation** : le 1er du mois a 00:00 (UTC).
- **En pratique** : Extraction de pages web en markdown.
- **Notes** : 1000 credits/mois (1 page = 1 credit).
- **Routage** : priorite 13, classe free.
- **Protection carte** : aucune carte necessaire ; ne saisissez pas de carte si l'inscription n'en demande pas.

- [ ] compte cree
- [ ] cle posee dans `.env`
- [ ] teste OK (bouton Tester dans Fournisseurs > Routeur MAZZ Control)
