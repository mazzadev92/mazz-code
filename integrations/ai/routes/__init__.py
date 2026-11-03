from fastapi import APIRouter

from . import quota, status

router = APIRouter()
router.include_router(quota.router)  # /integrations/call/... before /integrations/{id}/test
router.include_router(status.router)
