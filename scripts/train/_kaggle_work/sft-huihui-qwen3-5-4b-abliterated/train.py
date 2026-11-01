# Kaggle kernel: LoRA fine-tuning of a small chat model on the Studio's tool trajectories, then GGUF export.
# Placeholders filled by push_sft.py: huihui-ai/Huihui-Qwen3.5-4B-abliterated (Hugging Face id), /kaggle/input/studio-tools-sft-data, 2, 3072.
# The account's GPU is a Tesla P100 (sm_60): Kaggle's preinstalled torch needs sm_70+, so torch 2.2.0+cu118 is
# installed first (fix found in TESSERA's kaggle_backend.py). P100 has no bf16: fp16 autocast, fp32 LoRA weights.
import json
import os
import subprocess
import sys
import time

def sh(*args):
    print('$', ' '.join(args), flush=True)
    subprocess.run(list(args), check=True)

# Library pins per model family (push_sft.py): classic architectures use transformers 4.51; recent ones (LFM2,
# Qwen3.5) need a newer transformers, hence a newer torch, still from the cu118 index that keeps sm_60 kernels.
sh(sys.executable, '-m', 'pip', 'install', '-q', 'torch==2.6.0+cu118', '--index-url', 'https://download.pytorch.org/whl/cu118')
# The image's torchvision/torchaudio are built for its own torch and break transformers' imports ("torchvision::nms
# does not exist"); text training needs neither.
sh(sys.executable, '-m', 'pip', 'uninstall', '-y', '-q', 'torchvision', 'torchaudio')
sh(sys.executable, '-m', 'pip', 'install', '-q', *'transformers>=4.57 peft>=0.17 accelerate>=1.10'.split(), 'sentencepiece', 'gguf>=0.10')

import torch  # noqa: E402
from peft import LoraConfig, get_peft_model  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

BASE = 'huihui-ai/Huihui-Qwen3.5-4B-abliterated'
DATA = '/kaggle/input/studio-tools-sft-data'
EPOCHS = 2
MAX_LEN = 3072
OUT = '/kaggle/working'
started = time.time()
print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'aucun', flush=True)
# A real kernel launch, not just is_available(): an incompatible build fails here instead of training on CPU.
try:
    torch.ones(64, 64, device='cuda') @ torch.ones(64, 64, device='cuda')
    torch.cuda.synchronize()
except Exception as err:  # noqa: BLE001 -- any CUDA failure stops the run before the long part
    raise SystemExit(f'GPU inutilisable avec ce torch : {err}')

tok = AutoTokenizer.from_pretrained(BASE)
rows = []
# Kaggle mounts datasets under /kaggle/input/<slug> or /kaggle/input/datasets/<user>/<slug> depending on the image.
for root, _dirs, files in os.walk(DATA if os.path.isdir(DATA) else '/kaggle/input'):
    for name in files:
        if name.endswith('.jsonl'):
            with open(os.path.join(root, name), encoding='utf-8') as f:
                rows += [json.loads(l) for l in f if l.strip()]
if not rows:
    for root, _dirs, files in os.walk('/kaggle/input'):
        print(root, files[:5], flush=True)
    raise SystemExit('aucune trajectoire trouvée sous /kaggle/input')
print(len(rows), 'trajectoires', flush=True)


def encode(row):
    """Token ids and labels: only the assistant turns are learned, the prompt and tool results are context."""
    msgs, tools = row['messages'], row['tools']
    for m in msgs:
        for c in m.get('tool_calls', []) or []:
            if isinstance(c['function']['arguments'], str):
                c['function']['arguments'] = json.loads(c['function']['arguments'])
    full = tok.apply_chat_template(msgs, tools=tools, tokenize=False)
    ids = tok(full, add_special_tokens=False)['input_ids']
    labels = [-100] * len(ids)
    for i, m in enumerate(msgs):
        if m['role'] != 'assistant':
            continue
        start = len(tok(tok.apply_chat_template(msgs[:i], tools=tools, tokenize=False, add_generation_prompt=True), add_special_tokens=False)['input_ids'])
        end = len(tok(tok.apply_chat_template(msgs[:i + 1], tools=tools, tokenize=False), add_special_tokens=False)['input_ids'])
        for k in range(start, min(end, len(ids))):
            labels[k] = ids[k]
    return ids[:MAX_LEN], labels[:MAX_LEN]


data = [encode(r) for r in rows]
data = [d for d in data if any(l != -100 for l in d[1])]
print(len(data), 'exemples encodés ; longueur moyenne', sum(len(d[0]) for d in data) // max(1, len(data)), flush=True)

# Up to ~2.5B parameters the base fits in fp32 on the P100's 16 GB; larger bases are loaded in fp16 and only the
# LoRA weights are kept in fp32 (stable optimizer updates).
big = any(s in BASE.lower() for s in ('-3b', '-4b', '-7b', '-8b'))
model = AutoModelForCausalLM.from_pretrained(BASE, torch_dtype=torch.float16 if big else torch.float32).cuda()
model.gradient_checkpointing_enable()
model.enable_input_require_grads()
model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type='CAUSAL_LM',
                                         target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj']))
for p in model.parameters():
    if p.requires_grad:
        p.data = p.data.float()
model.print_trainable_parameters()
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-4, weight_decay=0.0)
scaler = torch.cuda.amp.GradScaler()
ACCUM = 8
steps_total = EPOCHS * len(data) // ACCUM
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 20) * max(0.05, 1 - s / max(1, steps_total)))
model.train()
step = 0
for epoch in range(EPOCHS):
    order = torch.randperm(len(data)).tolist()
    running = 0.0
    for n, idx in enumerate(order):
        ids, labels = data[idx]
        x = torch.tensor([ids], device='cuda')
        y = torch.tensor([labels], device='cuda')
        with torch.autocast('cuda', dtype=torch.float16):
            loss = model(input_ids=x, labels=y).loss / ACCUM
        scaler.scale(loss).backward()
        running += loss.item()
        if (n + 1) % ACCUM == 0:
            scaler.unscale_(opt)
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt)
            scaler.update()
            opt.zero_grad(set_to_none=True)
            sched.step()
            step += 1
            if step % 10 == 0:
                print(f'époque {epoch + 1} pas {step}/{steps_total} perte {running / 10:.4f} ({time.time() - started:.0f} s)', flush=True)
                running = 0.0

model = model.merge_and_unload()
merged = '/kaggle/tmp/merged'
os.makedirs(merged, exist_ok=True)
model.half().save_pretrained(merged, safe_serialization=True)
tok.save_pretrained(merged)
del model
torch.cuda.empty_cache()

sh('git', 'clone', '--depth', '1', 'https://github.com/ggml-org/llama.cpp', '/kaggle/tmp/llama.cpp')
name = BASE.split('/')[-1] + '-studio-tools-q8_0.gguf'
sh(sys.executable, '/kaggle/tmp/llama.cpp/convert_hf_to_gguf.py', merged, '--outtype', 'q8_0', '--outfile', f'{OUT}/{name}')
with open(f'{OUT}/train_report.json', 'w', encoding='utf-8') as f:
    json.dump({'base': BASE, 'examples': len(data), 'epochs': EPOCHS, 'steps': step, 'gguf': name, 'seconds': round(time.time() - started)}, f, indent=2)
print('terminé', name, round(time.time() - started), 's', flush=True)
