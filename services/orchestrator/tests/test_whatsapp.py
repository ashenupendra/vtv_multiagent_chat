from unittest.mock import patch

from fastapi.testclient import TestClient
from twilio.request_validator import RequestValidator

from app.core.config import Settings, get_settings
from app.main import app
from app.services.orchestrator import OrchestratorService
from app.services.whatsapp import WhatsAppService

client = TestClient(app)

TEST_AUTH_TOKEN = "test-twilio-auth-token"


def _settings_with_whatsapp(website_id: str = "any-site") -> Settings:
    return Settings(
        TWILIO_ACCOUNT_SID="test-sid",
        TWILIO_AUTH_TOKEN=TEST_AUTH_TOKEN,
        WHATSAPP_WEBSITE_ID=website_id,
    )


def test_signature_matches_valid_signature() -> None:
    service = WhatsAppService(_settings_with_whatsapp())
    url = "https://example.com/api/whatsapp/webhook"
    params = {"From": "whatsapp:+15551234567", "Body": "Hello"}
    valid_signature = RequestValidator(TEST_AUTH_TOKEN).compute_signature(url, params)

    assert service.signature_matches(url, params, valid_signature) is True
    assert service.signature_matches(url, params, "wrong-signature") is False
    assert service.signature_matches(url, params, None) is False


def test_signature_open_when_unconfigured() -> None:
    service = WhatsAppService(Settings(TWILIO_AUTH_TOKEN=""))
    assert service.signature_matches("https://example.com/x", {}, None) is True


def test_handle_incoming_message_returns_twiml_reply_and_persists_history() -> None:
    service = WhatsAppService(_settings_with_whatsapp())

    with patch.object(
        OrchestratorService, "_generate_text_reply", return_value="Sure, here is the answer."
    ):
        twiml = service.handle_incoming_message("whatsapp:+15550001111", "What are your hours?")

    assert "<Message>Sure, here is the answer.</Message>" in twiml
    assert twiml.startswith("<?xml")

    history = service._load_history("whatsapp:+15550001111")  # type: ignore[attr-defined]
    assert history[-2].role == "user"
    assert history[-2].content == "What are your hours?"
    assert history[-1].role == "assistant"
    assert history[-1].content == "Sure, here is the answer."


def test_handle_incoming_message_blocks_sensitive_message_before_model_call() -> None:
    service = WhatsAppService(_settings_with_whatsapp())

    with patch.object(
        OrchestratorService,
        "_generate_text_reply",
        side_effect=AssertionError("model must not be called for blocked messages"),
    ):
        twiml = service.handle_incoming_message("whatsapp:+15550002222", "My SSN is 123-45-6789")

    assert "sensitive personal information" in twiml.lower()


def test_handle_incoming_message_without_configured_website_sends_notice() -> None:
    service = WhatsAppService(_settings_with_whatsapp(website_id=""))
    twiml = service.handle_incoming_message("whatsapp:+15550003333", "hello")
    assert "not fully configured" in twiml.lower()


def test_handle_incoming_message_ignores_empty_body() -> None:
    service = WhatsAppService(_settings_with_whatsapp())
    twiml = service.handle_incoming_message("whatsapp:+15550004444", "   ")
    assert "<Message>" not in twiml


def test_webhook_endpoint_rejects_invalid_signature() -> None:
    import os

    os.environ["TWILIO_AUTH_TOKEN"] = TEST_AUTH_TOKEN
    get_settings.cache_clear()
    try:
        response = client.post(
            "/api/whatsapp/webhook",
            data={"From": "whatsapp:+15550005555", "Body": "hi"},
            headers={"X-Twilio-Signature": "wrong-signature"},
        )
        assert response.status_code == 401
    finally:
        os.environ.pop("TWILIO_AUTH_TOKEN", None)
        get_settings.cache_clear()


def test_webhook_endpoint_accepts_valid_signature() -> None:
    import os

    os.environ["TWILIO_AUTH_TOKEN"] = TEST_AUTH_TOKEN
    os.environ["WHATSAPP_WEBSITE_ID"] = "any-site"
    get_settings.cache_clear()
    try:
        form_data = {"From": "whatsapp:+15550006666", "Body": "hi"}
        url = "https://testserver/api/whatsapp/webhook"
        signature = RequestValidator(TEST_AUTH_TOKEN).compute_signature(url, form_data)

        with patch.object(
            OrchestratorService, "_generate_text_reply", return_value="Hello there!"
        ):
            response = client.post(
                "/api/whatsapp/webhook",
                data=form_data,
                headers={"X-Twilio-Signature": signature},
            )

        assert response.status_code == 200
        assert "Hello there!" in response.text
    finally:
        os.environ.pop("TWILIO_AUTH_TOKEN", None)
        os.environ.pop("WHATSAPP_WEBSITE_ID", None)
        get_settings.cache_clear()
