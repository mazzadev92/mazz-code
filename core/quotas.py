"""Usage and remaining quota of every compute source, each value tagged with where it comes from.

Sources and how they are measured:
- colab   `colab usage` (CLI in WSL Debian): compute units left, burn rate, active assignments.
- modal   `modal billing summary --json` (this month) against the monthly credit the user set (30 $).
- kaggle  no public GPU quota API: hours counted locally from sessions started through MAZZ Control
          (30 h per week, reset Saturday 00:00 UTC) plus the kernels listed by the Kaggle CLI.
- groq    x-ratelimit-* headers of a 1-token request (cached, costs one request per refresh).
- local   llama-server /metrics counters (tokens generated and processed since it started).
A source that cannot be measured returns status "error" with the reason, never a guessed value.
"""
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time

import httpx

from . import local_runtime
from .paths import mazz_path
from .quota_db import get_quota_status
from .secret_file import read_secret

CACHE_SECONDS = {"colab": 120, "modal": 300, "kaggle": 300, "groq": 600, "local": 5}
MODAL_MONTHLY_CREDIT_USD = float(os.environ.get("MAZZ_MODAL_CREDIT_USD", "30"))
GROQ_KEY_FILE = mazz_path("groq.key")
PYTHON = os.environ.get("MAZZ_PYTHON") or sys.executable

_cache = {}
# One collection at a time; a forced refresh still waits FORCE_MIN_SECONDS per source (no probe flood).
_collect_lock = threading.Lock()
FORCE_MIN_SECONDS = 30


def _run(cmd, timeout=60):
    env = {**os.environ, "PYTHONWARNINGS": "ignore"}
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), encoding="utf-8", errors="replace")
    return r.returncode, r.stdout, r.stderr


def _entry(sid, label, source, **values):
    return {"id": sid, "label": label, "source": source, "measured_at": time.time(), "status": "ok", "error": None, **values}


def _error(sid, label, source, message):
    return {"id": sid, "label": label, "source": source, "measured_at": time.time(), "status": "error", "error": message[:300]}


def colab():
    label, src = "Google Colab Pro", "colab usage (CLI WSL Debian)"
    try:
        code, out, err = _run(["wsl", "-d", "Debian", "--", "bash", "-lc", "~/.local/bin/colab usage"], timeout=90)
    except Exception as exc:
        return _error("colab", label, src, str(exc))
    balance = re.search(r"Current balance:\s*([\d.]+)", out)
    if code != 0 or not balance:
        return _error("colab", label, src, (err or out).strip() or f"code {code}")
    rate = re.search(r"Usage rate:\s*([\d.]+)", out)
    active = re.search(r"Active assignments:\s*(\d+)", out)
    return _entry("colab", label, src, unit="unités de calcul", remaining=float(balance.group(1)),
                  burn_per_hour=float(rate.group(1)) if rate else None,
                  active_sessions=int(active.group(1)) if active else None,
                  hours_left_at_rate=(float(balance.group(1)) / float(rate.group(1))) if rate and float(rate.group(1)) > 0 else None)


def modal():
    label, src = "Modal Labs", "modal billing summary --json (ce mois)"
    try:
        code, out, err = _run([PYTHON, "-W", "ignore", "-m", "modal", "billing", "summary", "--json"], timeout=90)
        data = json.loads(out[out.index("{"):])
    except Exception as exc:
        return _error("modal", label, src, str(exc))
    if code != 0:
        return _error("modal", label, src, err.strip() or f"code {code}")
    used = float(data.get("metered_cost") or 0)
    return _entry("modal", label, src, unit="USD", used=round(used, 4), limit=MODAL_MONTHLY_CREDIT_USD,
                  remaining=round(MODAL_MONTHLY_CREDIT_USD - used, 4), billed=float(data.get("billed_cost") or 0),
                  reset="1er du mois", percent=round(100 * used / MODAL_MONTHLY_CREDIT_USD, 1) if MODAL_MONTHLY_CREDIT_USD else None)


def kaggle():
    label = "Kaggle GPU"
    src = "heures comptées localement (sessions MAZZ Control) + kaggle kernels list"
    try:
        q = get_quota_status()
    except Exception as exc:
        return _error("kaggle", label, src, str(exc))
    kernels = []
    try:
        code, out, _ = _run(["py", "-3.14", "-m", "kaggle", "kernels", "list", "--mine", "--page-size", "10", "--csv"], timeout=60)
        if code == 0:
            lines = [l for l in out.splitlines() if l and not l.startswith("Warning")]
            head = lines[0].split(",") if lines else []
            for l in lines[1:]:
                row = dict(zip(head, l.split(",")))
                kernels.append({"ref": row.get("ref"), "last_run": row.get("lastRunTime")})
    except Exception as exc:  # the kernel list is optional detail: the quota entry is still returned
        logging.getLogger(__name__).debug("kaggle kernels list indisponible : %s", type(exc).__name__)
    return _entry("kaggle", label, src, unit="heures/semaine", used=q.get("used_hours"), limit=q.get("max_hours", 30.0),
                  remaining=q.get("remaining_hours"), percent=q.get("percentage"), reset=q.get("week_reset_utc"),
                  estimated=True, kernels=kernels[:10])


def groq():
    label, src = "Groq (API gratuite)", "en-têtes x-ratelimit-* d'une requête de 1 token"
    key = read_secret(GROQ_KEY_FILE)
    if not key:
        return _error("groq", label, src, f"clé absente ({GROQ_KEY_FILE})")
    try:
        auth = {"Authorization": f"Bearer {key}"}
        # Model list is free; probe with the smallest chat model actually offered today.
        ids = [m["id"] for m in httpx.get("https://api.groq.com/openai/v1/models", headers=auth, timeout=20).json().get("data", [])]
        chat = [i for i in ids if not re.search(r"whisper|tts|guard|playai|orpheus", i)]
        probe = next((i for i in chat if "instant" in i), chat[0] if chat else None)
        if not probe:
            return _error("groq", label, src, "aucun modèle de chat listé")
        r = httpx.post("https://api.groq.com/openai/v1/chat/completions", timeout=20, headers=auth,
                       json={"model": probe, "max_tokens": 1, "messages": [{"role": "user", "content": "."}]})
    except Exception as exc:
        return _error("groq", label, src, str(exc))
    h = r.headers
    if "x-ratelimit-remaining-requests" not in h:
        return _error("groq", label, src, f"HTTP {r.status_code} sans en-têtes de quota")
    num = lambda k: int(h[k]) if h.get(k, "").isdigit() else None
    return _entry("groq", label, src, unit="requêtes/jour et tokens/min",
                  requests_remaining=num("x-ratelimit-remaining-requests"), requests_limit=num("x-ratelimit-limit-requests"),
                  tokens_remaining=num("x-ratelimit-remaining-tokens"), tokens_limit=num("x-ratelimit-limit-tokens"),
                  reset_requests=h.get("x-ratelimit-reset-requests"), reset_tokens=h.get("x-ratelimit-reset-tokens"),
                  http_status=r.status_code)


def local(base_url=None):
    label, src = "llama-server local", "/metrics de llama-server (depuis son démarrage)"
    url = base_url or local_runtime.base_url()
    try:
        # /metrics requires the shared key once the server runs with --api-key-file; a keyless server
        # ignores the extra header, so sending it unconditionally is safe for both cases.
        r = httpx.get(f"{url}/metrics", headers=local_runtime.headers(), timeout=3)
        r.raise_for_status()
        text = r.text
    except Exception as exc:
        return _error("local", label, src, str(exc))
    def metric(name):
        m = re.search(rf"^llamacpp:{name}\s+([\d.e+]+)", text, re.M)
        return float(m.group(1)) if m else None
    return _entry("local", label, src, unit="tokens", cost="0 €",
                  tokens_generated=metric("tokens_predicted_total"), tokens_processed=metric("prompt_tokens_total"),
                  gen_tok_per_s=metric("predicted_tokens_seconds"), prompt_tok_per_s=metric("prompt_tokens_seconds"),
                  requests_processing=metric("requests_processing"))


SOURCES = {"local": local, "colab": colab, "modal": modal, "kaggle": kaggle, "groq": groq}


def collect(force=False):
    with _collect_lock:
        return _collect(force)


def _collect(force):
    out = []
    for sid, fn in SOURCES.items():
        cached = _cache.get(sid)
        max_age = min(FORCE_MIN_SECONDS, CACHE_SECONDS[sid]) if force else CACHE_SECONDS[sid]
        if cached and time.time() - cached["measured_at"] < max_age:
            out.append(cached)
            continue
        try:
            value = fn()
        except Exception as exc:
            value = _error(sid, sid, "?", f"{type(exc).__name__}: {exc}")
        _cache[sid] = value
        out.append(value)
    return out
