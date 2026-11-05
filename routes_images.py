"""POST /v1/images/generations: relays the request to a remote image backend (engine diffusers on Kaggle/Colab).
Auth is the gateway's /v1 guard; the backend's own key is added here and never returned.
`relay` is shared by the video and 3D routes (routes_videos.py, routes_3d.py): only capability, path, timeout and wording differ."""
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

import app as _app
from core import backends

router = APIRouter()
TIMEOUT_S = 300.0


def _error(status, message):
    return JSONResponse({"error": {"message": message}}, status_code=status)


async def relay(request: Request, path: str, capability: str, timeout: float, absent: str, label: str):
    try:
        body = await request.json()
        assert isinstance(body, dict)
    except Exception:
        return _error(400, "Corps JSON invalide.")
    model = str(body.get("model") or "")
    client = _app.http(request)
    prefix, _, rest = model.partition("/")
    chosen = None
    for b in backends.all_backends():
        if b["kind"] == "local" or capability not in b.get("capabilities", []):
            continue
        if "/" in model and b["id"] != prefix:
            continue
        await backends.probe(client, b)
        name = rest if "/" in model else model
        if b.get("healthy") and (not name or name in b.get("models", [])):
            chosen, served = b, name or b["models"][0]
            break
    if not chosen:
        return _error(404, absent)
    try:
        r = await client.post(f"{chosen['base_url']}{path}", json={**body, "model": served},
                              headers=backends.headers(chosen), timeout=timeout)
    except httpx.HTTPError as exc:
        return _error(502, f"Backend {label} {chosen['id']} injoignable ({type(exc).__name__}).")
    try:
        data = r.json()
    except ValueError:
        return _error(502, f"Reponse illisible du backend {label} {chosen['id']} (HTTP {r.status_code}).")
    return JSONResponse(data, status_code=r.status_code, headers={"x-mazz-backend": chosen["id"]})


@router.post("/v1/images/generations")
async def images_generations(request: Request):
    return await relay(request, "/v1/images/generations", "image", TIMEOUT_S, "Aucun modele d'image en ligne : envoyez-en un depuis Calcul GPU.", "d'image")
