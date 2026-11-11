import os, json

HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()
if not HF_TOKEN:
    raise SystemExit("HF_TOKEN manquant : exportez-le dans l'environnement avant de lancer ce script.")
DIR_NAME = "D:/Mazz Code/mazz_control/kaggle_surgical_08b"
os.makedirs(DIR_NAME, exist_ok=True)

meta = {
    "id": "mazz92140/mazz-forge-surgical-08b",
    "title": "mazz-forge-surgical-08b",
    "code_file": "forge_surgical_08b.ipynb",
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
                "# MAZZ ÆNGENIUM — FORGE WEIGHT-SPACE PROGRAMMING (SURGICAL 0.8B)\n",
                "Déploiement du modèle Qwen3.5-0.8B opéré par chirurgie matricielle directe (Weight-Space Programming - MIT CSAIL).\n",
                "- MATH-500 : 7.9% -> 48.1%\n",
                "- GSM8K : 13.8% -> 67.1%\n",
                "- IFEval : 21.0% -> 62.3%\n",
                "- Boucles infinies éradiquées (hit token limit : 93% -> 33%).\n",
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
                "TARGET_FILENAME = 'Mazz-Technos-Draft-0.8B-Surgical.Q8_0.gguf'\n\n",
                "print('1/3 Telechargement du checkpoint chirurgical (Weight-Space Programming)...', flush=True)\n",
                "dl_p = hf_hub_download(\n",
                "    repo_id='prithivMLmods/Qwen3.5-0.8B-weight-space-programming-GGUF',\n",
                "    filename='Qwen3.5-0.8B-weight-space-programming.Q8_0.gguf',\n",
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
                "print(f'3/3 Upload direct vers {REPO_ID}...', flush=True)\n",
                "api = HfApi(token=HF_TOKEN)\n",
                "for attempt in range(1, 4):\n",
                "    try:\n",
                "        url = api.upload_file(\n",
                "            path_or_fileobj=target_p,\n",
                "            path_in_repo=TARGET_FILENAME,\n",
                "            repo_id=REPO_ID,\n",
                "            repo_type='model',\n",
                "            commit_message=f'Add surgical model: {TARGET_FILENAME} with Weight-Space Programming (MIT CSAIL)'\n",
                "        )\n",
                "        print('=== SUCCES DEPLOIEMENT CHIRURGICAL ===', flush=True)\n",
                "        print('URL :', url, flush=True)\n",
                "        break\n",
                "    except Exception as exc:\n",
                "        print(f'Tentative {attempt} echouee ({exc}), retry dans 15s...', flush=True)\n",
                "        time.sleep(15)\n",
                "        if attempt == 3:\n",
                "            raise\n\n",
                "if os.path.exists(target_p):\n",
                "    os.remove(target_p)\n",
                "print('Operation chirurgicale 0.8B terminee avec succes !', flush=True)\n"
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

with open(os.path.join(DIR_NAME, "forge_surgical_08b.ipynb"), "w", encoding="utf-8") as f:
    json.dump(nb, f, indent=2)

print("Kaggle surgical 0.8B kernel files generated successfully!")
