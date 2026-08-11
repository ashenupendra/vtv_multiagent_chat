import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.sensitive_data import (
    SensitiveDataDetectedError,
    assert_not_sensitive,
    contains_sensitive_data,
    scan_for_sensitive_data,
)

client = TestClient(app)


@pytest.mark.parametrize(
    "text",
    [
        "My NIC is 962345678V",
        "Here is my passport N1234567",
        "My driving licence number is B1234567",
        "Card number: 4111 1111 1111 1111",
        "My account number is 1234567890123",
        "The CVV is 123",
        "My pin code is 4821",
        "My SSN is 123-45-6789",
        "My tax id number is 987654321",
        "My date of birth is 05/12/1990",
        "Call me at +1 415-555-0132",
        "The OTP is 482913",
        "My password is hunter2",
    ],
)
def test_detects_each_sensitive_category(text: str) -> None:
    findings = scan_for_sensitive_data(text)
    assert findings, f"expected a finding for: {text!r}"


@pytest.mark.parametrize(
    "text",
    [
        "Can you help me with onboarding and pricing questions?",
        "What are your business hours on weekdays?",
        "The website launched last year and has grown steadily.",
        "I need help resetting my account settings, not sure how.",
        "Thanks for the quick response, that solved my issue.",
    ],
)
def test_no_false_positive_on_ordinary_messages(text: str) -> None:
    assert scan_for_sensitive_data(text) == []


def test_findings_never_carry_the_matched_value() -> None:
    findings = scan_for_sensitive_data("My card number is 4111 1111 1111 1111")
    for finding in findings:
        assert "4111" not in finding.category
        assert "4111" not in finding.rule_id


def test_email_rule_is_disabled_by_default() -> None:
    assert scan_for_sensitive_data("Reach me at jane.doe@example.com") == []
    assert contains_sensitive_data(
        "Reach me at jane.doe@example.com",
        enable_rule_ids={"email_address"},
    )


def test_card_number_rule_uses_luhn_to_avoid_false_positives() -> None:
    # 16 digits but fails the Luhn checksum - should not be flagged as a card.
    findings = scan_for_sensitive_data("Order reference 1234567812345678")
    assert not any(finding.rule_id == "card_number" for finding in findings)


def test_assert_not_sensitive_raises_with_categories() -> None:
    with pytest.raises(SensitiveDataDetectedError) as excinfo:
        assert_not_sensitive("My SSN is 123-45-6789")
    assert "Social Security / Tax ID number" in excinfo.value.categories


def test_assert_not_sensitive_passes_for_clean_text() -> None:
    assert_not_sensitive("How do I update my billing address?")


def test_route_conversation_blocks_sensitive_text_before_model_call() -> None:
    response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "text",
            "website_id": "any-site",
            "session_id": "sensitive-guard-session",
            "message": "My SSN is 123-45-6789, can you help me update it?",
            "history": [],
        },
    )

    assert response.status_code == 422
    assert "sensitive personal information" in response.json()["detail"].lower()


def test_route_conversation_allows_clean_text() -> None:
    response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "text",
            "website_id": "any-site",
            "session_id": "sensitive-guard-session-clean",
            "message": "Can you help me with pricing questions?",
            "history": [],
        },
    )

    assert response.status_code == 200


def _admin_token() -> str:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    return login_response.json()["access_token"]


def test_admin_preview_route_bypasses_sensitive_data_filter() -> None:
    token = _admin_token()

    response = client.post(
        "/api/orchestration/route/admin-preview",
        json={
            "mode": "text",
            "website_id": "any-site",
            "session_id": "admin-preview-session",
            "message": "Sample content with SSN 123-45-6789 for a knowledge base test.",
            "history": [],
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200


def test_admin_preview_route_requires_admin_session() -> None:
    response = client.post(
        "/api/orchestration/route/admin-preview",
        json={
            "mode": "text",
            "website_id": "any-site",
            "session_id": "admin-preview-session-unauth",
            "message": "Can you help me with pricing questions?",
            "history": [],
        },
    )

    assert response.status_code in (401, 403)


def test_public_route_still_blocks_even_with_admin_style_payload() -> None:
    # The sensitive-data filter must remain in force on the real end-user
    # entry point regardless of payload shape - only the dedicated
    # admin-authenticated preview endpoint may bypass it.
    response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "text",
            "website_id": "any-site",
            "session_id": "public-route-session",
            "message": "My passport number is N1234567",
            "history": [],
        },
    )

    assert response.status_code == 422
