from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app
from app.services.orchestrator import OrchestratorService

client = TestClient(app)


def test_chat_endpoint_returns_generated_reply() -> None:
    with patch.object(
        OrchestratorService,
        "_generate_text_reply",
        return_value="Hello from the assistant.",
    ):
        response = client.post(
            "/api/orchestration/chat",
            json={
                "website_id": "any-site",
                "session_id": "chat-test-session",
                "message": "What are your business hours?",
                "history": [],
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "answered"
    assert body["reply"] == "Hello from the assistant."
    assert "observability_trace_id" in body


def test_chat_endpoint_includes_conversation_history_in_model_call() -> None:
    captured: dict[str, object] = {}

    def fake_generate(self, *, model, system_prompt, history, message):
        captured["history"] = history
        captured["message"] = message
        return "Got it."

    with patch.object(OrchestratorService, "_generate_text_reply", fake_generate):
        response = client.post(
            "/api/orchestration/chat",
            json={
                "website_id": "any-site",
                "session_id": "chat-test-session-history",
                "message": "And what about weekends?",
                "history": [
                    {"role": "user", "content": "Are you open on weekdays?"},
                    {"role": "assistant", "content": "Yes, Monday to Friday."},
                ],
            },
        )

    assert response.status_code == 200
    assert len(captured["history"]) == 2  # type: ignore[arg-type]
    assert captured["message"] == "And what about weekends?"


def test_chat_endpoint_blocks_sensitive_message_before_model_call() -> None:
    with patch.object(
        OrchestratorService,
        "_generate_text_reply",
        side_effect=AssertionError("model must not be called for blocked messages"),
    ):
        response = client.post(
            "/api/orchestration/chat",
            json={
                "website_id": "any-site",
                "session_id": "chat-test-session-blocked",
                "message": "My SSN is 123-45-6789",
                "history": [],
            },
        )

    assert response.status_code == 422
    assert "sensitive personal information" in response.json()["detail"].lower()


def test_chat_endpoint_falls_back_when_model_returns_empty() -> None:
    with patch.object(OrchestratorService, "_generate_text_reply", return_value=""):
        response = client.post(
            "/api/orchestration/chat",
            json={
                "website_id": "any-site",
                "session_id": "chat-test-session-fallback",
                "message": "Tell me a joke.",
                "history": [],
            },
        )

    assert response.status_code == 200
    body = response.json()
    assert body["reply"]
