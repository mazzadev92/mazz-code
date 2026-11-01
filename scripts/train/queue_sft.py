"""Kaggle allows few GPU sessions at once: pushes the queued models one by one as running kernels finish,
then downloads every finished GGUF into D:/Models Locaux/Mazz models/entraines.

Usage: py -3.14 scripts/train/queue_sft.py <dataset.jsonl> --models a,b,c [--max-running 2]
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = Path('D:/Models Locaux/Mazz models/entraines')
ENV = dict(os.environ, PYTHONUTF8='1', PYTHONIOENCODING='utf-8')
USER = 'mazz92140'


def slug(model: str) -> str:
    return 'sft-' + re.sub(r'[^a-z0-9]+', '-', model.split('/')[-1].lower()).strip('-')


def status(model: str) -> str:
    r = subprocess.run([sys.executable, '-m', 'kaggle', 'kernels', 'status', f'{USER}/{slug(model)}'], capture_output=True, text=True, encoding='utf-8', errors='replace', env=ENV)
    m = re.search(r'KernelWorkerStatus\.(\w+)', r.stdout + r.stderr)
    return m.group(1) if m else 'ABSENT'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dataset')
    ap.add_argument('--models', required=True)
    ap.add_argument('--max-running', type=int, default=2)
    a = ap.parse_args()
    queue = a.models.split(',')
    pushed: set[str] = set()
    done: set[str] = set()
    OUT.mkdir(parents=True, exist_ok=True)
    while len(done) < len(queue):
        states = {m: status(m) for m in queue if m not in done}
        for m, s in states.items():
            if s in ('COMPLETE', 'ERROR', 'CANCEL_ACKNOWLEDGED') and (m in pushed or s == 'COMPLETE'):
                if s == 'COMPLETE':
                    subprocess.run([sys.executable, '-m', 'kaggle', 'kernels', 'output', f'{USER}/{slug(m)}', '-p', str(OUT / slug(m))], env=ENV, capture_output=True)
                print(f'{time.strftime("%H:%M")} {m} : {s}', flush=True)
                done.add(m)
        running = sum(1 for m, s in states.items() if s in ('RUNNING', 'QUEUED') and m not in done)
        for m in queue:
            if running >= a.max_running:
                break
            if m in done or m in pushed or states.get(m) in ('RUNNING', 'QUEUED'):
                continue
            r = subprocess.run([sys.executable, str(HERE / 'push_sft.py'), a.dataset, '--models', m], capture_output=True, text=True, encoding='utf-8', errors='replace', env=ENV)
            ok = 'envoyé' in r.stdout
            print(f'{time.strftime("%H:%M")} {m} : {"envoyé" if ok else "échec envoi " + (r.stdout + r.stderr)[-300:]}', flush=True)
            pushed.add(m)
            if not ok:
                done.add(m)
            running += 1
        time.sleep(300)
    print('file terminée', flush=True)


if __name__ == '__main__':
    main()
