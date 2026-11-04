from fastapi import APIRouter

from . import manage, quota, status

router = APIRouter()
router.include_router(manage.router)  # /integrations/providers and /{id}/key before /{id}/test
router.include_router(quota.router)  # /integrations/call/... before /integrations/{id}/test
router.include_router(status.router)
