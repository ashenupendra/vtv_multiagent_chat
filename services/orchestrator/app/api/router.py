from fastapi import APIRouter

from app.api.routes.auth import router as auth_router
from app.api.routes.health import router as health_router
from app.api.routes.live import router as live_router
from app.api.routes.orchestration import router as orchestration_router
from app.api.routes.telegram import router as telegram_router
from app.api.routes.whatsapp import router as whatsapp_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(health_router)
api_router.include_router(live_router)
api_router.include_router(orchestration_router)
api_router.include_router(telegram_router)
api_router.include_router(whatsapp_router)
