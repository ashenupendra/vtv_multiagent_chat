"""Telegram bot integration for Text Chat.

Telegram pushes each message to our webhook; we run it through the same
sensitive-data-filtered reply generation used by web-chat
(OrchestratorService.generate_reply), then push the reply back via
Telegram's sendMessage API. Conversation history per chat is persisted
through the existing generic state-record store (the same mechanism used
for website state and live-voice grounding history).
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import Settings
from app.repositories.chroma import ChromaRepository
from app.schemas.orchestration import ChatMessage, ChatRequest
from app.services.orchestrator import OrchestratorService
from app.services.sensitive_data import BLOCK_MESSAGE, SensitiveDataDetectedError

logger = logging.getLogger(__name__)

MAX_HISTORY_MESSAGES = 20


class TelegramService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rag_repository = ChromaRepository(settings)
        self._orchestrator_service = OrchestratorService(settings)

    def webhook_secret_matches(self, provided_secret: str | None) -> bool:
        configured = self._settings.telegram_webhook_secret
        if not configured:
            # No secret configured: nothing to check against. This keeps
            # local/dev setups simple, but production deployments should
            # always set TELEGRAM_WEBHOOK_SECRET.
            return True
        return provided_secret == configured

    def handle_update(self, update: dict[str, Any]) -> None:
        message = update.get("message") or update.get("edited_message")
        if not isinstance(message, dict):
            return  # Non-text updates (channel posts, reactions, ...) are ignored.

        chat = message.get("chat")
        text = message.get("text")
        if not isinstance(chat, dict) or not isinstance(text, str) or not text.strip():
            return

        chat_id = chat.get("id")
        if chat_id is None:
            return

        website_id = self._settings.telegram_website_id
        if not website_id:
            logger.warning("Telegram message received but TELEGRAM_WEBSITE_ID is not configured")
            self._send_message(
                chat_id,
                "This Telegram bot is not fully configured yet. Please contact the site administrator.",
            )
            return

        session_id = f"telegram-{chat_id}"
        history = self._load_history(chat_id)

        try:
            response = self._orchestrator_service.generate_reply(
                ChatRequest(
                    website_id=website_id,
                    session_id=session_id,
                    message=text,
                    history=history,
                )
            )
        except SensitiveDataDetectedError:
            logger.warning(
                "Blocked Telegram message containing sensitive data",
                extra={"chat_id": chat_id},
            )
            self._send_message(chat_id, BLOCK_MESSAGE)
            return

        self._send_message(chat_id, response.reply)
        self._save_history(
            chat_id,
            [
                *history,
                ChatMessage(role="user", content=text),
                ChatMessage(role="assistant", content=response.reply),
            ],
        )

    def _load_history(self, chat_id: int) -> list[ChatMessage]:
        record = self._rag_repository.get_state_record(f"telegram-history:{chat_id}")
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

    def _save_history(self, chat_id: int, history: list[ChatMessage]) -> None:
        trimmed = history[-MAX_HISTORY_MESSAGES:]
        self._rag_repository.save_state_record(
            f"telegram-history:{chat_id}",
            payload={
                "chat_id": chat_id,
                "messages": [message.model_dump() for message in trimmed],
            },
            metadata={
                "record_type": "telegram_history",
                "chat_id": str(chat_id),
            },
        )

    def _send_message(self, chat_id: int, text: str) -> None:
        if not self._settings.telegram_bot_token:
            logger.warning("Cannot send Telegram message: TELEGRAM_BOT_TOKEN is not configured")
            return

        url = f"https://api.telegram.org/bot{self._settings.telegram_bot_token}/sendMessage"
        try:
            response = httpx.post(
                url,
                json={"chat_id": chat_id, "text": text},
                timeout=10.0,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            logger.error(
                "Failed to send Telegram message",
                extra={"chat_id": chat_id, "error": str(error)},
            )
