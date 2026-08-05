from app.core.config import Settings
from app.services.live import LiveProxyService
from app.services.prompts import RetrievedSnippet


def test_build_text_turn_message_includes_retrieval_context() -> None:
    service = LiveProxyService(Settings())
    service._orchestrator_service.build_retrieval_matches = lambda website_id, query, limit=3: [  # type: ignore[method-assign]
        RetrievedSnippet(
            id="doc-1",
            document="IRA supports multilingual onboarding and pricing help.",
            source="crawl",
            page_url="https://example.com/help",
            page_title="Help",
        )
    ]

    message, event = service._build_text_turn_message(  # type: ignore[attr-defined]
        "example-site",
        "Can you help with onboarding?",
    )

    grounded_text = message["clientContent"]["turns"][0]["parts"][0]["text"]
    assert "retrieved website evidence" in grounded_text.lower()
    assert "cite it with labels like [1]" in grounded_text
    assert "User request: Can you help with onboarding?" in grounded_text
    assert event["type"] == "grounding"
    assert event["source"] == "text"
    assert len(event["matches"]) == 1
    assert event["citations"][0]["label"] == "[1]"


def test_build_audio_grounding_turn_returns_follow_up_message() -> None:
    service = LiveProxyService(Settings())
    service._orchestrator_service.build_retrieval_matches = lambda website_id, query, limit=3: [  # type: ignore[method-assign]
        RetrievedSnippet(
            id="doc-2",
            document="Support is available in English and Tamil for onboarding questions.",
            source="seed",
            page_url="https://example.com/support",
            page_title="Support",
        )
    ]

    message, event = service._build_audio_grounding_turn(  # type: ignore[attr-defined]
        "example-site",
        "I need multilingual onboarding support.",
    )

    assert message is not None
    grounded_text = message["clientContent"]["turns"][0]["parts"][0]["text"]
    assert "previous spoken turn" in grounded_text.lower()
    assert "cite it with labels like [1]" in grounded_text
    assert "I need multilingual onboarding support." in grounded_text
    assert event["type"] == "grounding"
    assert event["source"] == "audio"
    assert len(event["matches"]) == 1
    assert event["citations"][0]["label"] == "[1]"


def test_text_turn_includes_language_directive_even_without_matches() -> None:
    service = LiveProxyService(Settings())
    service._orchestrator_service.build_retrieval_matches = lambda website_id, query, limit=3: []  # type: ignore[method-assign]

    message, _event = service._build_text_turn_message(  # type: ignore[attr-defined]
        "example-site",
        "Mama oyata ape sathkaraya gena kathaa karanna oona.",
    )

    grounded_text = message["clientContent"]["turns"][0]["parts"][0]["text"]
    assert "detect the language of this message" in grounded_text.lower()
    assert "Mama oyata ape sathkaraya gena kathaa karanna oona." in grounded_text


def test_audio_grounding_turn_includes_language_directive_even_without_matches() -> None:
    service = LiveProxyService(Settings())
    service._orchestrator_service.build_retrieval_matches = lambda website_id, query, limit=3: []  # type: ignore[method-assign]

    message, _event = service._build_audio_grounding_turn(  # type: ignore[attr-defined]
        "example-site",
        "Nan mozhiyai support venum.",
    )

    assert message is not None
    grounded_text = message["clientContent"]["turns"][0]["parts"][0]["text"]
    assert "detect the language of this message" in grounded_text.lower()
    assert "Nan mozhiyai support venum." in grounded_text


def test_map_client_message_blocks_sensitive_text_before_forwarding() -> None:
    service = LiveProxyService(Settings())
    service._orchestrator_service.build_retrieval_matches = lambda *args, **kwargs: (_ for _ in ()).throw(  # type: ignore[method-assign]
        AssertionError("RAG lookup must not run for blocked messages")
    )

    messages, events, should_await = service._map_client_message(  # type: ignore[attr-defined]
        {"type": "text", "text": "My card number is 4111 1111 1111 1111"},
        "example-site",
    )

    assert messages == []
    assert should_await is False
    assert len(events) == 1
    assert events[0]["type"] == "blocked"
    assert events[0]["source"] == "text"
    assert "Credit or debit card number" in events[0]["categories"]


def test_map_client_message_forwards_clean_text() -> None:
    service = LiveProxyService(Settings())
    service._orchestrator_service.build_retrieval_matches = lambda website_id, query, limit=3: []  # type: ignore[method-assign]

    messages, events, should_await = service._map_client_message(  # type: ignore[attr-defined]
        {"type": "text", "text": "Can you help with onboarding?"},
        "example-site",
    )

    assert len(messages) == 1
    assert events[0]["type"] == "grounding"


def test_live_grounding_history_is_persisted_and_loaded() -> None:
    service = LiveProxyService(Settings())

    stored_event = service._store_live_grounding_event(  # type: ignore[attr-defined]
        website_id="example-site",
        session_id="voice-session-1",
        event={
            "type": "grounding",
            "source": "text",
            "query": "pricing support",
            "citations": [
                {
                    "label": "[1]",
                    "document_id": "doc-3",
                    "excerpt": "Pricing support is available on weekdays.",
                }
            ],
            "matches": [
                {
                    "id": "doc-3",
                    "document": "Pricing support is available on weekdays.",
                    "metadata": {"page_title": "Pricing"},
                }
            ],
        },
    )

    history = service._load_live_grounding_history(  # type: ignore[attr-defined]
        website_id="example-site",
        session_id="voice-session-1",
    )

    assert stored_event["turn_id"]
    assert stored_event["recorded_at"]
    assert len(history) >= 1
    assert history[-1]["turn_id"] == stored_event["turn_id"]
    assert history[-1]["query"] == "pricing support"
    assert history[-1]["citations"][0]["label"] == "[1]"

    api_response = service.get_grounding_history(
        website_id="example-site",
        session_id="voice-session-1",
    )
    assert api_response.status == "loaded"
    assert api_response.entries[-1].citations[0].label == "[1]"
