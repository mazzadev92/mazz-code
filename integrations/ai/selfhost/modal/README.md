# Modal

Créez un secret Modal nommé `mazz-vllm-key` contenant `VLLM_API_KEY`, puis définissez `MODEL_REPO` (un modèle Hugging Face auquel votre compte a accès), éventuellement `MODAL_GPU` et `SERVED_MODEL_NAME`.

```powershell
python -m pip install modal
modal setup
modal deploy modal_app.py
```

L’endpoint OpenAI-compatible renvoyé par Modal se termine par `/v1`; configurez `LOCAL_MODAL_URL` et la clé `VLLM_API_KEY` côté gateway. Le worker scale à zéro après cinq minutes d’inactivité et le premier démarrage inclut le chargement/téléchargement des poids. Coût GPU et autorisation de téléchargement dépendent du compte Modal et du modèle. Ce dépôt ne déploie pas l’application.
