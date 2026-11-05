"""POST /v1/videos/generations: relays the request to a remote video backend (engine diffusers_video, Wan 2.1 on Kaggle/Colab).
Auth is the gateway's /v1 guard; the backend's own key is added in routes_images.relay and never returned."""
from fastapi import APIRouter, Request

from routes_images import relay

router = APIRouter()
TIMEOUT_S = 900.0  # generation takes minutes


@router.post("/v1/videos/generations")
async def videos_generations(request: Request):
    return await relay(request, "/v1/videos/generations", "video", TIMEOUT_S, "Aucun modele de video en ligne : envoyez-en un depuis Calcul GPU.", "de video")
