"""GET /integrations/status and POST /integrations/{id}/test (the Test button)."""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..adapters.base import ProviderError
from ..router import AllProvidersFailed, NoProviderAvailable

router = APIRouter()


def get_ai(request: Request):
    return getattr(request.app.state, "ai_router", None)


def unavailable() -> JSONResponse:
    return JSONResponse({"error": {"type": "ai_layer_unavailable", "message": "Couche IA indisponible : verifier registry.yaml et les logs."}}, status_code=503)


def ai_error_response(exc: Exception) -> JSONResponse:
    """Router exceptions as explicit HTTP answers: 503 lists what is missing, 429 carries Retry-After, 502 lists failures."""
    if isinstance(exc, NoProviderAvailable):
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after is not None else {}
        return JSONResponse({"error": {"type": "no_provider_available", "message": str(exc), "capability": exc.capability,
                                       "missing": exc.missing, "waiting": exc.waiting}}, status_code=exc.status, headers=headers)
    if isinstance(exc, AllProvidersFailed):
        return JSONResponse({"error": {"type": "all_providers_failed", "message": str(exc), "attempts": exc.errors}}, status_code=502)
    if isinstance(exc, ProviderError):
        return JSONResponse({"error": {"type": f"provider_{exc.kind}", "message": str(exc)}}, status_code=400 if exc.kind in ("request", "config") else 502)
    raise exc


@router.get("/integrations/status")
async def integrations_status(request: Request):
    ai = get_ai(request)
    return ai.status() if ai else unavailable()


@router.post("/integrations/{provider_id}/test")
async def integrations_test(provider_id: str, request: Request):
    """Tests a provider with the key from .env, or with a key typed in the field (used once, never stored)."""
    ai = get_ai(request)
    if not ai:
        return unavailable()
    try:
        body: Optional[dict[str, Any]] = await request.json()
    except ValueError:
        body = None
    key = body.get("key") if isinstance(body, dict) and isinstance(body.get("key"), str) else None
    return await ai.test(provider_id, key)
