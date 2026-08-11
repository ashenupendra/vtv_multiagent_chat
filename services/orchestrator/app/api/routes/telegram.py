from fastapi import APIRouter, Header, HTTPException, Request

from app.core.config import get_settings
from app.services.telegram import TelegramService

router = APIRouter(prefix="/telegram", tags=["telegram"])


@router.post("/webhook")
async def telegram_webhook(
    request: Request,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict[str, str]:
    """Telegram calls this on every incoming message once configured via
    Telegram's setWebhook API with a matching secret_token. Always returns
    200 quickly (per Telegram's requirements) once the update is accepted."""
    service = TelegramService(get_settings())
    if not service.webhook_secret_matches(x_telegram_bot_api_secret_token):
        raise HTTPException(status_code=401, detail="Invalid Telegram webhook secret.")

    update = await request.json()
    service.handle_update(update)
    return {"status": "ok"}
