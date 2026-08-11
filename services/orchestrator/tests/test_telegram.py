from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import app
from app.services.orchestrator import OrchestratorService
from app.services.telegram import TelegramService

client = TestClient(app)


def _settings_with_telegram(website_id: str = "any-site") -> Settings:
    return Settings(
        TELEGRAM_BOT_TOKEN="test-token",
        TELEGRAM_WEBHOOK_SECRET="test-secret",
        TELEGRAM_WEBSITE_ID=website_id,
    )


def test_webhook_secret_matches() -> None:
    service = TelegramService(_settings_with_telegram())
    assert service.webhook_secret_matches("test-secret") is True
    assert service.webhook_secret_matches("wrong-secret") is False
    assert service.webhook_secret_matches(None) is False


def test_webhook_secret_open_when_unconfigured() -> None:
    service = TelegramService(Settings(TELEGRAM_WEBHOOK_SECRET=""))
    assert service.webhook_secret_matches(None) is True


def test_handle_update_sends_reply_and_persists_history() -> None:
    service = TelegramService(_settings_with_telegram())
    sent_messages: list[tuple[int, str]] = []

    def fake_send(self: TelegramService, chat_id: int, text: str) -> None:
        sent_messages.append((chat_id, text))

    with patch.object(
        OrchestratorService, "_generate_text_reply", return_value="Sure, here is the answer."
    ), patch.object(TelegramService, "_send_message", fake_send):
        service.handle_update(
            {
                "message": {
                    "chat": {"id": 555001},
                    "text": "What are your business hours?",
                }
            }
        )

    assert sent_messages == [(555001, "Sure, here is the answer.")]
    history = service._load_history(555001)  # type: ignore[attr-defined]
    assert history[-2].role == "user"
    assert history[-2].content == "What are your business hours?"
    assert history[-1].role == "assistant"
    assert history[-1].content == "Sure, here is the answer."


def test_handle_update_blocks_sensitive_message_before_model_call() -> None:
    service = TelegramService(_settings_with_telegram())
    sent_messages: list[tuple[int, str]] = []

    def fake_send(self: TelegramService, chat_id: int, text: str) -> None:
        sent_messages.append((chat_id, text))

    with patch.object(
        OrchestratorService,
        "_generate_text_reply",
        side_effect=AssertionError("model must not be called for blocked messages"),
    ), patch.object(TelegramService, "_send_message", fake_send):
        service.handle_update(
            {
                "message": {
                    "chat": {"id": 555002},
                    "text": "My SSN is 123-45-6789",
                }
            }
        )

    assert len(sent_messages) == 1
    assert "sensitive personal information" in sent_messages[0][1].lower()


def test_handle_update_ignores_non_text_updates() -> None:
    service = TelegramService(_settings_with_telegram())
    # Should not raise even though there's no usable text message.
    service.handle_update({"channel_post": {"chat": {"id": 1}, "text": "hi"}})
    service.handle_update({"message": {"chat": {"id": 1}, "sticker": {}}})


def test_handle_update_without_configured_website_sends_notice() -> None:
    service = TelegramService(_settings_with_telegram(website_id=""))
    sent_messages: list[tuple[int, str]] = []

    def fake_send(self: TelegramService, chat_id: int, text: str) -> None:
        sent_messages.append((chat_id, text))

    with patch.object(TelegramService, "_send_message", fake_send):
        service.handle_update({"message": {"chat": {"id": 555003}, "text": "hello"}})

    assert len(sent_messages) == 1
    assert "not fully configured" in sent_messages[0][1].lower()


def test_webhook_endpoint_rejects_invalid_secret() -> None:
    import os

    os.environ["TELEGRAM_WEBHOOK_SECRET"] = "expected-secret"
    get_settings.cache_clear()
    try:
        response = client.post(
            "/api/telegram/webhook",
            json={"message": {"chat": {"id": 1}, "text": "hi"}},
            headers={"X-Telegram-Bot-Api-Secret-Token": "wrong-secret"},
        )
        assert response.status_code == 401
    finally:
        os.environ.pop("TELEGRAM_WEBHOOK_SECRET", None)
        get_settings.cache_clear()


def test_webhook_endpoint_accepts_matching_secret() -> None:
    import os

    os.environ["TELEGRAM_WEBHOOK_SECRET"] = "expected-secret"
    get_settings.cache_clear()
    try:
        with patch.object(TelegramService, "handle_update", return_value=None) as mock_handle:
            response = client.post(
                "/api/telegram/webhook",
                json={"message": {"chat": {"id": 1}, "text": "hi"}},
                headers={"X-Telegram-Bot-Api-Secret-Token": "expected-secret"},
            )
        assert response.status_code == 200
        assert mock_handle.called
    finally:
        os.environ.pop("TELEGRAM_WEBHOOK_SECRET", None)
        get_settings.cache_clear()
