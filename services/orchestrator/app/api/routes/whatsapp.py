from fastapi import APIRouter, Header, HTTPException, Request, Response

from app.core.config import get_settings
from app.services.whatsapp import WhatsAppService

router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])


@router.post("/webhook")
async def whatsapp_webhook(
    request: Request,
    x_twilio_signature: str | None = Header(default=None),
) -> Response:
    """Twilio calls this (form-encoded, not JSON) on every incoming WhatsApp
    message once configured as the WhatsApp sandbox/number's webhook URL.
    Replies synchronously via TwiML in the response body."""
    service = WhatsAppService(get_settings())

    form = await request.form()
    form_params = {key: str(value) for key, value in form.items()}

    validation_url = _external_url(request)
    if not service.signature_matches(validation_url, form_params, x_twilio_signature):
        raise HTTPException(status_code=401, detail="Invalid Twilio request signature.")

    from_number = form_params.get("From", "")
    body = form_params.get("Body", "")
    twiml = service.handle_incoming_message(from_number, body)
    return Response(content=twiml, media_type="application/xml")


def _external_url(request: Request) -> str:
    # Twilio signs the exact public URL it called (always https). Behind a
    # tunnel/reverse proxy, request.url.scheme reflects the internal
    # plain-http hop, not what Twilio actually used - trust
    # X-Forwarded-Proto when present, otherwise assume https, since Twilio
    # never calls a plain-http webhook.
    scheme = request.headers.get("x-forwarded-proto", "https")
    host = request.headers.get("host", request.url.hostname or "")
    query = f"?{request.url.query}" if request.url.query else ""
    return f"{scheme}://{host}{request.url.path}{query}"
