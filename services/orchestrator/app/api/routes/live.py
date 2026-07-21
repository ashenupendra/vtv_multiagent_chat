from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.api.deps import get_live_proxy_service
from app.schemas.live import LiveConfigResponse
from app.services.live import LiveProxyService

router = APIRouter(prefix="/live", tags=["live"])


@router.get("/config", response_model=LiveConfigResponse)
def get_live_config(
    model: str | None = None,
    service: LiveProxyService = Depends(get_live_proxy_service),
) -> LiveConfigResponse:
    return service.build_config(model)


@router.websocket("/ws")
async def proxy_live_session(
    websocket: WebSocket,
    model: str,
    website_id: str,
    language_hint: str | None = None,
) -> None:
    await websocket.accept()
    service = get_live_proxy_service()
    try:
        await service.proxy_session(
            websocket,
            model=model,
            website_id=website_id,
            language_hint=language_hint,
        )
    except WebSocketDisconnect:
        return
