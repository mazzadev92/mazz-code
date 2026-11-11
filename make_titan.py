import json
import os

def create_titan_32b_notebook():
    cells = [
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "# MAZZ ÆNGENIUM — FORGE TITAN 32B COT (Kaggle)\n",
                "Ce notebook forge le modèle souverain de raisonnement **Mazz-Technos-Titan-32B-CoT** :\n",
                "1. Base : DeepSeek-R1-Distill-Qwen-32B ablitéré (zéro censure, raisonnement Chain-of-Thought pur)\n",
                "2. Format : GGUF `Q4_K_M` (18.49 Go)\n",
                "3. Téléversement automatique vers `mazz92/mazz-models` (via LFS standard)\n",
                "\n",
                "**Quota utilisé** : 100% Gratuit (Kaggle GPU T4 x2 ou Standard CPU)\n"
            ]
        },
        {
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": [
                "# 1. Installation du client Hugging Face\n",
                "!pip install -q huggingface_hub\n"
            ]
        },
        {
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": [
                "# 2. Forge et téléversement direct vers mazz92/mazz-models\n",
                "import os, shutil, time\n",
                "\n",
                "# Désactivation de xet pour éviter les erreurs HTTP 429 de XetHub\n",
                "os.environ['HF_HUB_DISABLE_XET'] = '1'\n",
                "os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'\n",
                "\n",
                "from huggingface_hub import hf_hub_download, HfApi\n",
                "\n",
                'HF_TOKEN = os.environ.get("HF_TOKEN")\n',
                "assert HF_TOKEN, 'HF_TOKEN manquant'\n",
                "REPO_ID = 'mazz92/mazz-models'\n",
                "TARGET_FILENAME = 'Mazz-Technos-Titan-32B-CoT.Q4_K_M.gguf'\n",
                "\n",
                "print('1/3 Téléchargement de la base DeepSeek-R1 32B dans /tmp (18.49 Go)...', flush=True)\n",
                "downloaded_path = hf_hub_download(\n",
                "    repo_id='bartowski/DeepSeek-R1-Distill-Qwen-32B-abliterated-GGUF',\n",
                "    filename='DeepSeek-R1-Distill-Qwen-32B-abliterated-Q4_K_M.gguf',\n",
                "    local_dir='/tmp',\n",
                "    token=HF_TOKEN\n",
                ")\n",
                "\n",
                "titan_path = os.path.join('/tmp', TARGET_FILENAME)\n",
                "if os.path.exists(titan_path) and titan_path != downloaded_path:\n",
                "    os.remove(titan_path)\n",
                "if downloaded_path != titan_path:\n",
                "    shutil.move(downloaded_path, titan_path)\n",
                "\n",
                "sz_gb = os.path.getsize(titan_path) / (1024**3)\n",
                "print(f'2/3 Modèle forgé avec succès : {TARGET_FILENAME} ({sz_gb:.2f} Go)', flush=True)\n",
                "\n",
                "print(f'3/3 Téléversement direct Git LFS vers votre dépôt Hugging Face {REPO_ID}...', flush=True)\n",
                "api = HfApi(token=HF_TOKEN)\n",
                "for attempt in range(1, 4):\n",
                "    try:\n",
                "        url = api.upload_file(\n",
                "            path_or_fileobj=titan_path,\n",
                "            path_in_repo=TARGET_FILENAME,\n",
                "            repo_id=REPO_ID,\n",
                "            repo_type='model',\n",
                "            commit_message=f'Add sovereign model: {TARGET_FILENAME} (By Eren Tipirdamaz / MAZZ AENGENIUM)'\n",
                "        )\n",
                "        print('=== SUCCÈS TOTAL MAZZ-TECHNOS-TITAN-32B-COT ===', flush=True)\n",
                "        print('Modèle souverain déployé sur :', url)\n",
                "        break\n",
                "    except Exception as exc:\n",
                "        print(f'Tentative {attempt} échouée ({exc}), nouvel essai dans 15s...', flush=True)\n",
                "        time.sleep(15)\n",
                "        if attempt == 3:\n",
                "            raise\n",
                "\n",
                "if os.path.exists(titan_path):\n",
                "    os.remove(titan_path)\n"
            ]
        }
    ]

    nb = {
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3"
            },
            "language_info": {
                "name": "python",
                "version": "3.10.12"
            }
        },
        "nbformat": 4,
        "nbformat_minor": 4
    }

    out_path = r"D:\Mazz Code\mazz_control\kaggle_titan_32b\forge_mazz_titan_32b.ipynb"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(nb, f, indent=2, ensure_ascii=False)
    print("Notebook Kaggle Titan 32B généré :", out_path)

if __name__ == "__main__":
    create_titan_32b_notebook()
