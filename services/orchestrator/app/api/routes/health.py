from fastapi import APIRouter

from app.core.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/health")
def healthcheck() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ok",
        "service": settings.app_name,
        "environment": settings.environment,
    }


@router.get("/ready")
def readiness() -> dict[str, str]:
    settings = get_settings()
    return {
        "status": "ready",
        "default_agent": settings.default_agent_name,
        "text_model": settings.google_text_model,
        "live_model": settings.google_live_model,
    }
