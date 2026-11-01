"""Uploads the trajectory dataset to Kaggle and pushes one LoRA training kernel per base model.

Usage (Python with the `kaggle` package, e.g. `py -3.14`):
  py -3.14 scripts/train/push_sft.py <dataset.jsonl> --models Qwen/Qwen3-1.7B [--epochs 2] [--max-len 3072]
Then: py -3.14 -m kaggle kernels status <user>/<slug> ; py -3.14 -m kaggle kernels output <user>/<slug> -p <dir>
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')


def kaggle(*args, cwd=None):
    r = subprocess.run([sys.executable, '-m', 'kaggle', *args], capture_output=True, text=True, encoding='utf-8', errors='replace', cwd=cwd, env=ENV)
    return r.returncode, (r.stdout + r.stderr).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dataset')
    ap.add_argument('--models', required=True, help='Hugging Face ids, comma separated')
    ap.add_argument('--epochs', type=int, default=2)
    ap.add_argument('--max-len', type=int, default=3072)
    ap.add_argument('--work', default=str(HERE / '_kaggle_work'))
    a = ap.parse_args()

    code, out = kaggle('config', 'view')
    user = re.search(r'username:\s*(\S+)', out)
    if not user:
        sys.exit(f'compte Kaggle introuvable : {out[:300]}')
    user = user.group(1)
    work = Path(a.work)
    shutil.rmtree(work, ignore_errors=True)
    data_dir = work / 'data'
    data_dir.mkdir(parents=True)
    shutil.copy(a.dataset, data_dir / Path(a.dataset).name)
    slug = 'studio-tools-sft-data'
    (data_dir / 'dataset-metadata.json').write_text(json.dumps({'title': slug, 'id': f'{user}/{slug}', 'licenses': [{'name': 'CC0-1.0'}]}), encoding='utf-8')
    code, _ = kaggle('datasets', 'status', f'{user}/{slug}')
    code, out = kaggle('datasets', 'version', '-p', str(data_dir), '-m', 'trajectoires', '-r', 'zip') if code == 0 else kaggle('datasets', 'create', '-p', str(data_dir), '-r', 'zip')
    if code != 0:
        sys.exit(f'échec envoi du dataset : {out[:500]}')
    for _ in range(60):
        code, out = kaggle('datasets', 'status', f'{user}/{slug}')
        if 'ready' in out.lower():
            break
        time.sleep(5)
    time.sleep(20)
    print(f'dataset {user}/{slug} prêt', flush=True)

    template = (HERE / 'kaggle_sft_lora.py').read_text(encoding='utf-8')
    for model in a.models.split(','):
        kslug = 'sft-' + re.sub(r'[^a-z0-9]+', '-', model.split('/')[-1].lower()).strip('-')
        kdir = work / kslug
        kdir.mkdir(parents=True)
        recent = any(s in model.lower() for s in ('qwen3.5', 'lfm2'))
        # Kaggle's image is Python 3.13 now: cu118 wheels exist from torch 2.5.0 (2.2.0 is gone).
        torch_pin = 'torch==2.6.0+cu118'
        libs = 'transformers>=4.57 peft>=0.17 accelerate>=1.10' if recent else 'transformers==4.51.3 peft==0.15.2 accelerate==1.6.0'
        script = (template.replace('__BASE_MODEL__', model).replace('__TORCH__', torch_pin).replace('__LIBS__', libs)
                  .replace('__DATASET_DIR__', f'/kaggle/input/{slug}')
                  .replace('__EPOCHS__', str(a.epochs)).replace('__MAX_LEN__', str(a.max_len)))
        (kdir / 'train.py').write_text(script, encoding='utf-8')
        (kdir / 'kernel-metadata.json').write_text(json.dumps({
            'id': f'{user}/{kslug}', 'title': kslug, 'code_file': 'train.py', 'language': 'python', 'kernel_type': 'script',
            'is_private': True, 'enable_gpu': True, 'enable_internet': True, 'dataset_sources': [f'{user}/{slug}'],
        }, indent=2), encoding='utf-8')
        code, out = kaggle('kernels', 'push', '-p', str(kdir), '--accelerator', 'nvidiaTeslaT4')
        print(f'{model} -> {user}/{kslug} : {"envoyé" if code == 0 else "ÉCHEC"} {out[-300:]}', flush=True)


if __name__ == '__main__':
    main()
