"""Managing providers from the app: write/remove an API key in .env, add or remove a custom OpenAI-compatible provider.

The built-in registry.yaml is never edited: custom providers live in user_providers.yaml in the MAZZ data folder, keys in
the git-ignored .env, and "removing" a built-in provider switches it off with AI_<ID>_DISABLED=1."""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Optional

import yaml

from .loader import USER_PROVIDERS_PATH, Provider, RegistryError

ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
PROVIDER_ID = re.compile(r"^[a-z0-9][a-z0-9_]{1,31}$")
URL = re.compile(r"^https?://[^\s]+$")


def _clean(value: str, what: str) -> str:
    value = (value or "").strip()
    if not value or "\n" in value or "\r" in value:
        raise ValueError(f"{what} invalide")
    return value


def set_env_var(path: Path, name: str, value: Optional[str]) -> None:
    """Sets NAME=value in the .env file (value None removes the line). Other lines are kept byte for byte; the write is atomic."""
    if not ENV_NAME.match(name):
        raise ValueError("nom de variable invalide")
    if value is not None:
        value = _clean(value, "valeur")
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    kept = [l for l in lines if not re.match(rf"^\s*(export\s+)?{re.escape(name)}\s*=", l)]
    if value is not None:
        kept.append(f"{name}={value}")
    tmp = path.with_suffix(path.suffix + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp.write_text("\n".join(kept) + "\n", encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _read_users(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return list((yaml.safe_load(path.read_text(encoding="utf-8")) or {}).get("providers", []))


def _write_users(path: Path, items: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(yaml.safe_dump({"providers": items}, allow_unicode=True, sort_keys=False), encoding="utf-8")
    os.replace(tmp, path)


def user_provider_ids(path: Path = USER_PROVIDERS_PATH) -> set[str]:
    return {item.get("id", "") for item in _read_users(path)}


def add_user_provider(data: dict[str, Any], taken: set[str], path: Path = USER_PROVIDERS_PATH) -> Provider:
    """Validates and stores a custom OpenAI-compatible provider. `taken` = ids already used by the registry."""
    pid = _clean(str(data.get("id", "")), "id").lower()
    if not PROVIDER_ID.match(pid):
        raise ValueError("id : minuscules, chiffres et _ (2 a 32 caracteres)")
    if pid in taken:
        raise ValueError(f"id deja utilise : {pid}")
    base_url = _clean(str(data.get("base_url", "")), "base_url").rstrip("/")
    if not URL.match(base_url):
        raise ValueError("base_url doit commencer par http:// ou https://")
    capabilities = [c for c in data.get("capabilities") or ["chat"] if c in ("chat", "vision", "embedding", "image")] or ["chat"]
    models = [{"alias": str(m["alias"]), "id": str(m["id"])} for m in data.get("models") or [] if isinstance(m, dict) and m.get("alias") and m.get("id")]
    entry = {
        "id": pid, "label": str(data.get("label") or pid)[:60], "base_url": base_url,
        "auth": {"type": "bearer", "env": f"{pid.upper()}_KEY", "optional": bool(data.get("optional_key", False))},
        "adapter": "openai_compat", "capabilities": capabilities, "models": models, "model_pattern": data.get("model_pattern") or ".*",
        "limits": {"reset": "never"}, "priority": int(data.get("priority", 60)), "cost_class": data.get("cost_class", "free"),
        "requires_card": False, "requires_phone": False, "signup_url": str(data.get("signup_url", "")), "enabled": False,
        "notes": "Ajoute depuis l'application.", "key_path": "Console du fournisseur.", "practical": "Fournisseur personnalise.",
    }
    provider = Provider.model_validate(entry)  # RegistryError-grade validation, before anything is written
    items = [i for i in _read_users(path) if i.get("id") != pid] + [entry]
    _write_users(path, items)
    return provider


def remove_user_provider(pid: str, path: Path = USER_PROVIDERS_PATH) -> bool:
    items = _read_users(path)
    kept = [i for i in items if i.get("id") != pid]
    if len(kept) == len(items):
        return False
    _write_users(path, kept)
    return True
