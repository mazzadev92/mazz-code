import os, json

HF_TOKEN = os.environ.get("HF_TOKEN", "").strip()

def create_kernel(dir_name, kernel_id, title, ipynb_name, targets):
    os.makedirs(dir_name, exist_ok=True)
    meta = {
        "id": f"mazz92140/{kernel_id}",
        "title": title,
        "code_file": ipynb_name,
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
    with open(os.path.join(dir_name, "kernel-metadata.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    code_lines = [
        "import os, shutil, time\n",
        "os.environ['HF_HUB_DISABLE_XET'] = '1'\n",
        "os.environ['HF_HUB_ENABLE_HF_TRANSFER'] = '0'\n",
        "from huggingface_hub import hf_hub_download, HfApi\n\n",
        f"HF_TOKEN = os.environ.get('HF_TOKEN') or '{HF_TOKEN}'\n",
        "REPO_ID = 'mazz92/mazz-models'\n",
        "api = HfApi(token=HF_TOKEN)\n\n"
    ]

    for item in targets:
        src_repo = item["src_repo"]
        src_file = item["src_file"]
        target_name = item["target_name"]
        desc = item["desc"]
        code_lines.extend([
            f"print('=== [DEBUT] {target_name} ({desc}) ===', flush=True)\n",
            f"p = hf_hub_download(repo_id='{src_repo}', filename='{src_file}', local_dir='/tmp', token=HF_TOKEN)\n",
            f"target_p = os.path.join('/tmp', '{target_name}')\n",
            "if os.path.exists(target_p) and target_p != p:\n",
            "    os.remove(target_p)\n",
            "if p != target_p:\n",
            "    shutil.move(p, target_p)\n",
            "sz_gb = os.path.getsize(target_p) / (1024**3)\n",
            f"print(f'Telecharge: {target_name} ({{sz_gb:.2f}} Go), upload vers {{REPO_ID}}...', flush=True)\n",
            "for attempt in range(1, 4):\n",
            "    try:\n",
            "        url = api.upload_file(\n",
            "            path_or_fileobj=target_p,\n",
            f"            path_in_repo='{target_name}',\n",
            "            repo_id=REPO_ID,\n",
            "            repo_type='model',\n",
            f"            commit_message='Add sovereign model: {target_name} (By Eren Tipirdamaz / MAZZ AENGENIUM)'\n",
            "        )\n",
            f"        print('SUCCES: {target_name} -> ', url, flush=True)\n",
            "        break\n",
            "    except Exception as exc:\n",
            "        print(f'Tentative {attempt} echouee ({exc}), retry dans 15s...', flush=True)\n",
            "        time.sleep(15)\n",
            "        if attempt == 3:\n",
            "            raise\n",
            "if os.path.exists(target_p):\n",
            "    os.remove(target_p)\n",
            f"print('=== [TERMINE] {target_name} ===\\n', flush=True)\n\n"
        ])

    nb = {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [f"# MAZZ AENGENIUM - FORGE {title}\n", "Forge automatique sans GPU (CPU pur, 100% gratuit, 0 quota consomme)."]
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
                "source": code_lines
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
    with open(os.path.join(dir_name, ipynb_name), "w", encoding="utf-8") as f:
        json.dump(nb, f, indent=2)
    print(f"Created kernel files in {dir_name}")

if __name__ == "__main__":
    # 1. Local CPU
    create_kernel(
        "D:/Mazz Code/mazz_control/kaggle_local_cpu",
        "mazz-forge-local-cpu",
        "mazz-forge-local-cpu",
        "forge_mazz_local_cpu.ipynb",
        [
            {
                "src_repo": "mradermacher/Huihui-Qwen3.5-4B-abliterated-GGUF",
                "src_file": "Huihui-Qwen3.5-4B-abliterated.Q4_K_M.gguf",
                "target_name": "Mazz-Technos-Base-4B.Q4_K_M.gguf",
                "desc": "Base Grand Public 4B CPU 4-5 tok/s"
            },
            {
                "src_repo": "mradermacher/Qwen3.5-0.8B-abliterated-GGUF",
                "src_file": "Qwen3.5-0.8B-abliterated.Q8_0.gguf",
                "target_name": "Mazz-Technos-Draft-0.8B.Q8_0.gguf",
                "desc": "Ultra-Fast CPU Draft 0.8B"
            }
        ]
    )

    # 2. Multimodal
    create_kernel(
        "D:/Mazz Code/mazz_control/kaggle_multimodal",
        "mazz-forge-multimodal",
        "mazz-forge-multimodal",
        "forge_mazz_multimodal.ipynb",
        [
            {
                "src_repo": "city96/FLUX.1-schnell-gguf",
                "src_file": "flux1-schnell-Q4_0.gguf",
                "target_name": "Mazz-Technos-Vision-Flux.Q4_0.gguf",
                "desc": "Sovereign Image Gen 12B Schnell"
            },
            {
                "src_repo": "samuelchristlie/Wan2.1-T2V-1.3B-GGUF",
                "src_file": "Wan2.1-T2V-1.3B-Q8_0.gguf",
                "target_name": "Mazz-Technos-Motion-Wan.Q8_0.gguf",
                "desc": "Sovereign Video Gen Wan 2.1 1.3B Q8"
            }
        ]
    )
