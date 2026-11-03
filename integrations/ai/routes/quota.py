"""GET /integrations/quota and POST /integrations/call/{capability} (embedding, rerank, tts, stt, image, search, scrape)."""
from __future__ import annotations

import base64
import binascii
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..adapters.base import ProviderError
from ..router import AllProvidersFailed, NoProviderAvailable
from .status import ai_error_response, get_ai, unavailable

router = APIRouter()
CAPABILITIES = ("embedding", "rerank", "tts", "stt", "image", "search", "scrape")


@router.get("/integrations/quota")
async def integrations_quota(request: Request):
    ai = get_ai(request)
    return ai.quota_report() if ai else unavailable()


@router.post("/integrations/call/{capability}")
async def integrations_call(capability: str, request: Request):
    """Runs a non-chat capability through the router. Needs AI_ROUTER_ENABLED=true (chat goes through /v1)."""
    ai = get_ai(request)
    if not ai:
        return unavailable()
    if capability not in CAPABILITIES:
        return JSONResponse({"error": {"type": "unknown_capability", "message": f"capability : {', '.join(CAPABILITIES)}"}}, status_code=404)
    if not ai.enabled:
        return JSONResponse({"error": {"type": "router_disabled", "message": "AI_ROUTER_ENABLED=false : routeur desactive."}}, status_code=409)
    try:
        payload: dict[str, Any] = await request.json()
        if not isinstance(payload, dict):
            raise ValueError
        if "audio_b64" in payload:
            payload["audio"] = base64.b64decode(payload.pop("audio_b64"), validate=True)
        result = await ai.execute(capability, payload)
    except (ValueError, KeyError, TypeError, binascii.Error):
        return JSONResponse({"error": {"type": "invalid_request", "message": "Corps JSON invalide ou champ obligatoire absent."}}, status_code=400)
    except (NoProviderAvailable, AllProvidersFailed, ProviderError) as exc:
        return ai_error_response(exc)
    return result.model_dump()
