"""POST /v1/3d/generations: relays the request to a remote 3D backend (engine triposr on Kaggle/Colab).
Auth is the gateway's /v1 guard; the backend's own key is added in routes_images.relay and never returned."""
from fastapi import APIRouter, Request

from routes_images import relay

router = APIRouter()
TIMEOUT_S = 300.0  # generation takes minutes


@router.post("/v1/3d/generations")
async def threed_generations(request: Request):
    return await relay(request, "/v1/3d/generations", "3d", TIMEOUT_S, "Aucun modele 3D en ligne : envoyez-en un depuis Calcul GPU.", "3D")
