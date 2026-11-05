"""/compute/* HTTP routes. State-changing calls need the control key (enforced by the gateway guard)."""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse

from . import logs as keptlogs
from .catalog import catalog
from .providers import ComputeError
from .services import load_services
from .service import ComputeService

router = APIRouter()
_service: Optional[ComputeService] = None
CHECK_TIMEOUT_S = 25.0


def service() -> ComputeService:
    global _service
    if _service is None:
        _service = ComputeService()
    return _service


def set_service(value: Optional[ComputeService]) -> None:
    """Test hook: replaces the lazily created service."""
    global _service
    _service = value


def error(exc: Exception, status: int = 400) -> JSONResponse:
    return JSONResponse({"error": {"type": "compute_error", "message": str(exc)}}, status_code=status)


async def _state(provider) -> dict[str, Any]:
    try:
        return await asyncio.wait_for(asyncio.to_thread(provider.check), CHECK_TIMEOUT_S)
    except asyncio.TimeoutError:
        return {"configured": True, "ok": False, "detail": "Verification trop longue (delai depasse)."}
    except Exception as exc:  # noqa: BLE001 - one provider's failure must not hide the others
        return {"configured": True, "ok": False, "detail": f"Verification impossible ({type(exc).__name__})."}


@router.get("/compute/providers")
async def compute_providers():
    svc = service()
    items = list(svc.providers.values())
    states = await asyncio.gather(*[_state(p) for p in items])
    deployments = await asyncio.gather(*[asyncio.to_thread(p.deployments) for p in items])
    return {"providers": [{**p.public(), "state": s, "deployments": d} for p, s, d in zip(items, states, deployments)]}


@router.post("/compute/providers/{provider_id}/configure")
async def compute_configure(provider_id: str, request: Request):
    try:
        body = await request.json()
        token = str(body.get("token", ""))
        state = await asyncio.to_thread(service().provider(provider_id).configure, token, body.get("extra"))
    except ComputeError as exc:
        return error(exc)
    except ValueError:
        return error(ComputeError("Corps JSON invalide."))
    return {"state": state}


@router.post("/compute/providers/{provider_id}/stop")
async def compute_stop(provider_id: str, request: Request):
    try:
        body = await request.json()
        provider = service().provider(provider_id)
        result = await asyncio.to_thread(provider.stop, str(body.get("deployment_id", "")))
        if provider.default_backend:  # the server is gone: its announcement must not linger as "ready"
            await asyncio.to_thread(service().forget, provider.default_backend)
        return result
    except ComputeError as exc:
        return error(exc)
    except ValueError:
        return error(ComputeError("Corps JSON invalide."))


@router.get("/compute/sources")
async def compute_sources():
    return await asyncio.to_thread(service().sources)


@router.post("/compute/send")
async def compute_send(request: Request):
    try:
        body = await request.json()
        job = service().send(dict(body.get("source") or {}), str(body.get("target", "")), dict(body.get("options") or {}))
    except ComputeError as exc:
        return error(exc)
    except (ValueError, TypeError):
        return error(ComputeError("Requete invalide."))
    return JSONResponse(job.to_dict(), status_code=202)


@router.get("/compute/jobs")
async def compute_jobs():
    return {"jobs": service().jobs.list()}


@router.get("/compute/jobs/{job_id}")
async def compute_job(job_id: str):
    job = service().jobs.get(job_id)
    return job.to_dict() if job else error(ComputeError("Tache inconnue."), 404)


@router.get("/compute/serving")
async def compute_serving():
    return {"backends": service().serving()}


@router.get("/compute/catalog")
async def compute_catalog():
    return {"models": catalog()}


@router.get("/compute/services")
async def compute_services():
    return {"services": [s.model_dump() for s in load_services()]}


@router.get("/compute/logs")
async def compute_logs():
    return {"logs": await asyncio.to_thread(keptlogs.list_logs)}


@router.get("/compute/logs/{name}")
async def compute_log(name: str):
    text = await asyncio.to_thread(keptlogs.read, name)
    return PlainTextResponse(text) if text is not None else error(ComputeError("Journal introuvable."), 404)
