"""Provider management from the app: save/remove a key, add/remove a custom provider, switch one on or off."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..loader import RegistryError
from ..userconfig import add_user_provider, remove_user_provider, set_env_var
from .status import get_ai, unavailable

router = APIRouter()


def bad(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": {"type": "invalid_request", "message": message}}, status_code=status)


async def _body(request: Request) -> dict[str, Any]:
    try:
        data = await request.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _row(ai, provider_id: str) -> dict[str, Any]:
    return next((p for p in ai.status()["providers"] if p["id"] == provider_id), {})


@router.put("/integrations/{provider_id}/key")
async def save_key(provider_id: str, request: Request):
    """Writes the key into .env (git-ignored). The router sees it on its next access: no restart."""
    ai = get_ai(request)
    if not ai:
        return unavailable()
    spec = ai.registry.get(provider_id)
    if spec is None or not spec.auth.env:
        return bad("Fournisseur inconnu ou sans cle.", 404)
    key = str((await _body(request)).get("key", "")).strip()
    if len(key) < 6 or len(key) > 4096 or any(c.isspace() for c in key):
        return bad("Cle invalide (6 a 4096 caracteres, sans espace).")
    set_env_var(ai.env.path, spec.auth.env, key)
    set_env_var(ai.env.path, f"AI_{provider_id.upper()}_DISABLED", None)
    return _row(ai, provider_id)


@router.delete("/integrations/{provider_id}/key")
async def remove_key(provider_id: str, request: Request):
    ai = get_ai(request)
    if not ai:
        return unavailable()
    spec = ai.registry.get(provider_id)
    if spec is None or not spec.auth.env:
        return bad("Fournisseur inconnu ou sans cle.", 404)
    set_env_var(ai.env.path, spec.auth.env, None)
    return _row(ai, provider_id)


@router.put("/integrations/{provider_id}/enabled")
async def set_enabled(provider_id: str, request: Request):
    """enabled:false writes AI_<ID>_DISABLED=1 (the registry file stays untouched)."""
    ai = get_ai(request)
    if not ai:
        return unavailable()
    if ai.registry.get(provider_id) is None:
        return bad("Fournisseur inconnu.", 404)
    enabled = bool((await _body(request)).get("enabled", True))
    set_env_var(ai.env.path, f"AI_{provider_id.upper()}_DISABLED", None if enabled else "1")
    return _row(ai, provider_id)


@router.post("/integrations/providers")
async def add_provider(request: Request):
    ai = get_ai(request)
    if not ai:
        return unavailable()
    data = await _body(request)
    try:
        provider = add_user_provider(data, {p.id for p in ai.registry.providers}, ai._user_path)
    except (ValueError, RegistryError) as exc:
        return bad(str(exc))
    except Exception as exc:  # noqa: BLE001 - pydantic validation of a hand-typed entry
        return bad(f"Fournisseur invalide : {str(exc)[:200]}")
    key = str(data.get("key", "")).strip()
    if key:
        set_env_var(ai.env.path, provider.auth.env or f"{provider.id.upper()}_KEY", key)
    ai.reload()
    return JSONResponse(_row(ai, provider.id), status_code=201)


@router.delete("/integrations/providers/{provider_id}")
async def remove_provider(provider_id: str, request: Request):
    """Removes a provider the user added (and its key). A built-in one cannot be deleted: it is switched off instead."""
    ai = get_ai(request)
    if not ai:
        return unavailable()
    if provider_id not in ai.user_provider_ids:
        if ai.registry.get(provider_id) is None:
            return bad("Fournisseur inconnu.", 404)
        return bad("Fournisseur integre : desactive-le (interrupteur) ou retire sa cle.", 409)
    spec = ai.registry.get(provider_id)
    remove_user_provider(provider_id, ai._user_path)
    if spec and spec.auth.env:
        set_env_var(ai.env.path, spec.auth.env, None)
    set_env_var(ai.env.path, f"AI_{provider_id.upper()}_DISABLED", None)
    ai.reload()
    return {"removed": provider_id}
