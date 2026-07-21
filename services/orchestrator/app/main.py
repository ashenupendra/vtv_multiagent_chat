from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import get_settings
from app.observability.otel import configure_otel


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        description="Initial IRA orchestration service scaffold.",
    )
    configure_otel(app, settings)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(api_router, prefix="/api")

    @app.get("/")
    def root() -> dict[str, str]:
        return {
            "message": "IRA orchestrator service is running",
            "environment": settings.environment,
        }

    return app


app = create_app()
