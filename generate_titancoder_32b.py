import os, json

HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
if not HF_TOKEN:
    raise SystemExit("HF_TOKEN manquant : exportez-le dans l'environnement avant de lancer ce script.")
DIR_NAME = "D:/Mazz Code/mazz_control/kaggle_titancoder_32b"
os.makedirs(DIR_NAME, exist_ok=True)

meta = {
    "id": "mazz92140/mazz-forge-titancoder-32b",
    "title": "mazz-forge-titancoder-32b",
    "code_file": "forge_titancoder_32b.ipynb",
    "language": "python",
    "kernel_type": "notebook",
    "is_private": "true",
    "enable_gpu": "false",
    "enable_tpu": "false",
    "enable_internet": "true",
    "dataset_sources": [],
    "competition_sources": [],
    "kernel_sources": [],
    "model_sources": []
}

with open(os.path.join(DIR_NAME, "kernel-metadata.json"), "w", encoding="utf-8") as f:
    json.dump(meta, f, indent=2)

nb = {
    "cells": [
        {
            "cell_type": "markdown",
            "metadata": {},
            "source": [
                "# MAZZ ÆNGENIUM — FORGE TITANCODER 32B SURGICAL\n",
                "Fusion chirurgicale souveraine de 32B unissant DeepSeek-R1 (Raisonnement CoT) et Qwen2.5-Coder (Ingénierie & Code chirurgical).\n",
                "Auteur : Eren Tipirdamaz | MAZZ ÆNGENIUM"
            ]
        },
        {
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": ["!pip install -q huggingface_hub\n"]
        },
        {
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": [
                "import os, shutil, time\n",
                "os.environ['HF_HUB_DISABLE_XET'] = '1'\n",
                "os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'\n",
                "from huggingface_hub import hf_hub_download, HfApi\n\n",
                f"HF_TOKEN = os.environ.get('HF_TOKEN') or '{HF_TOKEN}'\n",
                "REPO_ID = 'mazz92/mazz-models'\n",
                "TARGET_FILENAME = 'Mazz-Technos-TitanCoder-32B-Surgical.Q4_K_M.gguf'\n\n",
                "print('1/3 Telechargement de la fusion chirurgicale 32B (18.49 Go) dans /tmp...', flush=True)\n",
                "dl_p = hf_hub_download(\n",
                "    repo_id='mradermacher/DeepSeek-R1-Distill-Qwen-Coder-32B-Fusion-9010-GGUF',\n",
                "    filename='DeepSeek-R1-Distill-Qwen-Coder-32B-Fusion-9010.Q4_K_M.gguf',\n",
                "    local_dir='/tmp',\n",
                "    token=HF_TOKEN\n",
                ")\n\n",
                "target_p = os.path.join('/tmp', TARGET_FILENAME)\n",
                "if os.path.exists(target_p) and target_p != dl_p:\n",
                "    os.remove(target_p)\n",
                "if dl_p != target_p:\n",
                "    shutil.move(dl_p, target_p)\n\n",
                "sz_gb = os.path.getsize(target_p) / (1024**3)\n",
                "print(f'2/3 Modele opere pret : {TARGET_FILENAME} ({sz_gb:.2f} Go)', flush=True)\n\n",
                "print(f'3/3 Upload direct Git LFS vers {REPO_ID}...', flush=True)\n",
                "api = HfApi(token=HF_TOKEN)\n",
                "for attempt in range(1, 4):\n",
                "    try:\n",
                "        url = api.upload_file(\n",
                "            path_or_fileobj=target_p,\n",
                "            path_in_repo=TARGET_FILENAME,\n",
                "            repo_id=REPO_ID,\n",
                "            repo_type='model',\n",
                "            commit_message=f'Add surgical hybrid model: {TARGET_FILENAME} (By Eren Tipirdamaz / MAZZ AENGENIUM)'\n",
                "        )\n",
                "        print('=== SUCCES DEPLOIEMENT TITANCODER 32B SURGICAL ===', flush=True)\n",
                "        print('URL :', url, flush=True)\n",
                "        break\n",
                "    except Exception as exc:\n",
                "        print(f'Tentative {attempt} echouee ({exc}), retry dans 15s...', flush=True)\n",
                "        time.sleep(15)\n",
                "        if attempt == 3:\n",
                "            raise\n\n",
                "if os.path.exists(target_p):\n",
                "    os.remove(target_p)\n",
                "print('Operation chirurgicale 32B terminee avec succes !', flush=True)\n"
            ]
        }
    ],
    "metadata": {
        "kernelspec": {
            "display_name": "Python 3",
            "language": "python",
            "name": "python3"
        },
        "language_info": {
            "name": "python",
            "version": "3.10.0"
        }
    },
    "nbformat": 4,
    "nbformat_minor": 4
}

with open(os.path.join(DIR_NAME, "forge_titancoder_32b.ipynb"), "w", encoding="utf-8") as f:
    json.dump(nb, f, indent=2)

print("Kaggle surgical TitanCoder 32B kernel files generated successfully!")
