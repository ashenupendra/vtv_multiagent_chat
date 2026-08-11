"""WhatsApp (via Twilio) integration for Text Chat.

Mirrors app/services/telegram.py: Twilio POSTs each incoming WhatsApp
message to our webhook (form-encoded, not JSON), we validate Twilio's
request signature, run it through the same sensitive-data-filtered reply
generation used by web-chat and Telegram (OrchestratorService.generate_reply),
and reply via TwiML in the webhook response itself (no separate outbound
API call needed, unlike Telegram's sendMessage).

Conversation history per WhatsApp number is persisted through the same
generic state-record store used for Telegram history and live-voice
grounding history.
"""

from __future__ import annotations

import logging
from typing import Any
from xml.sax.saxutils import escape as xml_escape

from twilio.request_validator import RequestValidator

from app.core.config import Settings
from app.repositories.chroma import ChromaRepository
from app.schemas.orchestration import ChatMessage, ChatRequest
from app.services.orchestrator import OrchestratorService
from app.services.sensitive_data import BLOCK_MESSAGE, SensitiveDataDetectedError

logger = logging.getLogger(__name__)

MAX_HISTORY_MESSAGES = 20


class WhatsAppService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rag_repository = ChromaRepository(settings)
        self._orchestrator_service = OrchestratorService(settings)

    def signature_matches(
        self,
        url: str,
        form_params: dict[str, Any],
        signature: str | None,
    ) -> bool:
        if not self._settings.twilio_auth_token:
            # No auth token configured: nothing to validate against. Keeps
            # local/dev setups simple, but production must always set
            # TWILIO_AUTH_TOKEN.
            return True
        if not signature:
            return False
        validator = RequestValidator(self._settings.twilio_auth_token)
        return validator.validate(url, form_params, signature)

    def handle_incoming_message(self, from_number: str, body: str) -> str:
        """Returns a TwiML XML string to send back as the webhook response."""
        if not body.strip():
            return _empty_twiml()

        website_id = self._settings.whatsapp_website_id
        if not website_id:
            logger.warning("WhatsApp message received but WHATSAPP_WEBSITE_ID is not configured")
            return _twiml_reply(
                "This WhatsApp number is not fully configured yet. Please contact the site administrator."
            )

        session_id = f"whatsapp-{from_number}"
        history = self._load_history(from_number)

        try:
            response = self._orchestrator_service.generate_reply(
                ChatRequest(
                    website_id=website_id,
                    session_id=session_id,
                    message=body,
                    history=history,
                )
            )
        except SensitiveDataDetectedError:
            logger.warning(
                "Blocked WhatsApp message containing sensitive data",
                extra={"from_number": from_number},
            )
            return _twiml_reply(BLOCK_MESSAGE)

        self._save_history(
            from_number,
            [
                *history,
                ChatMessage(role="user", content=body),
                ChatMessage(role="assistant", content=response.reply),
            ],
        )
        return _twiml_reply(response.reply)

    def _load_history(self, from_number: str) -> list[ChatMessage]:
        record = self._rag_repository.get_state_record(f"whatsapp-history:{from_number}")
        if not record:
            return []
        raw_messages = record.get("messages")
        if not isinstance(raw_messages, list):
            return []

        history: list[ChatMessage] = []
        for item in raw_messages:
            if (
                isinstance(item, dict)
                and item.get("role") in ("user", "assistant")
                and isinstance(item.get("content"), str)
            ):
                history.append(ChatMessage(role=item["role"], content=item["content"]))
        return history

    def _save_history(self, from_number: str, history: list[ChatMessage]) -> None:
        trimmed = history[-MAX_HISTORY_MESSAGES:]
        self._rag_repository.save_state_record(
            f"whatsapp-history:{from_number}",
            payload={
                "from_number": from_number,
                "messages": [message.model_dump() for message in trimmed],
            },
            metadata={
                "record_type": "whatsapp_history",
                "from_number": from_number,
            },
        )


def _twiml_reply(text: str) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?><Response><Message>{xml_escape(text)}</Message></Response>'


def _empty_twiml() -> str:
    return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
