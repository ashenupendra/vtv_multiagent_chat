from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthcheck() -> None:
    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_readiness() -> None:
    response = client.get("/api/ready")

    assert response.status_code == 200
    assert "text_model" in response.json()


def test_live_config() -> None:
    response = client.get("/api/live/config")

    assert response.status_code == 200
    body = response.json()
    assert body["api_mode"] == "backend_proxy"
    assert body["websocket_path"] == "/api/live/ws"
    assert body["status"] in {"available", "unavailable"}


def test_route_conversation() -> None:
    response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "text",
            "website_id": "acme",
            "session_id": "session-1",
            "message": "What products do you offer?",
            "history": [],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "accepted"
    assert body["route"]["agent"] == "text_chat"
    assert body["route"]["rag_collection"] == "ira-acme"
    assert body["route"]["rag_status"] in {"connected", "offline_stub"}
    assert "ROLE AND ROUTING" in body["route"]["system_prompt"]
    assert "GROUNDING POLICY" in body["route"]["system_prompt"]
    assert "WEBSITE CONTEXT" in body["route"]["system_prompt"]
    assert body["route"]["website_prompt_override_applied"] is False


def test_provision_website() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com",
            "display_name": "Example Site",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "provisioned"
    assert body["website_id"].startswith("example-site-")
    assert body["rag_status"] in {"connected", "offline_stub"}
    assert body["rag_endpoint"].startswith("http://")


def test_upsert_and_query_website_documents() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com",
            "display_name": "Knowledge Base",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    upsert_response = client.post(
        "/api/orchestration/documents",
        json={
            "website_id": website_id,
            "documents": [
                {
                    "id": "welcome",
                    "document": "IRA helps visitors with onboarding, pricing, and support questions.",
                    "metadata": {"source": "seed"},
                },
                {
                    "id": "faq",
                    "document": "Support is available by live chat and email during business hours.",
                    "metadata": {"source": "faq"},
                },
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert upsert_response.status_code == 200
    upsert_body = upsert_response.json()
    assert upsert_body["status"] == "upserted"
    assert upsert_body["upserted_count"] == 2

    query_response = client.post(
        "/api/orchestration/documents/query",
        json={
            "website_id": website_id,
            "query": "support chat",
            "limit": 3,
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    assert query_response.status_code == 200
    query_body = query_response.json()
    assert query_body["status"] == "queried"
    assert len(query_body["matches"]) >= 1
    assert "support" in query_body["matches"][0]["document"].lower()

    route_response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "text",
            "website_id": website_id,
            "session_id": "prompt-check-session",
            "message": "Summarize support options.",
            "history": [],
            "language_hint": "en-US",
        },
    )

    assert route_response.status_code == 200
    route_body = route_response.json()
    assert route_body["route"]["website_prompt_override_applied"] is False
    assert "knowledge base" in route_body["route"]["grounding_prompt"].lower()


def test_route_prompt_override_applied() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com/prompt",
            "display_name": "Prompted Site",
            "allowed_domains": ["example.com"],
            "crawl_depth": 3,
            "prompt_override": "Always start with a one-line answer, then bullet points.",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    route_response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "voice",
            "website_id": website_id,
            "session_id": "voice-prompt-session",
            "message": "Need onboarding help.",
            "history": [],
            "language_hint": "en-US",
        },
    )

    assert route_response.status_code == 200
    route_body = route_response.json()
    assert route_body["route"]["agent"] == "voice_processing"
    assert route_body["route"]["website_prompt_override_applied"] is True
    assert "website-specific prompt override" in route_body["route"]["website_prompt"].lower()


def test_list_and_delete_website_documents() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com/docs",
            "display_name": "Testing Docs",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    client.post(
        "/api/orchestration/documents",
        json={
            "website_id": website_id,
            "documents": [
                {
                    "id": "alpha",
                    "document": "Alpha document content for testing list and delete.",
                    "metadata": {"source": "seed"},
                },
                {
                    "id": "beta",
                    "document": "Beta document content for testing list and delete.",
                    "metadata": {"source": "seed"},
                },
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    list_response = client.get(
        f"/api/orchestration/documents?website_id={website_id}&limit=10",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert list_response.status_code == 200
    list_body = list_response.json()
    assert list_body["status"] == "listed"
    assert {document["id"] for document in list_body["documents"]} >= {"alpha", "beta"}

    delete_response = client.delete(
        f"/api/orchestration/documents/alpha?website_id={website_id}",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert delete_response.status_code == 200
    delete_body = delete_response.json()
    assert delete_body["status"] == "deleted"
    assert delete_body["deleted_count"] == 1

    list_after_delete = client.get(
        f"/api/orchestration/documents?website_id={website_id}&limit=10",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert list_after_delete.status_code == 200
    remaining_ids = {document["id"] for document in list_after_delete.json()["documents"]}
    assert "alpha" not in remaining_ids
    assert "beta" in remaining_ids


def test_login_and_session() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )

    assert login_response.status_code == 200
    token = login_response.json()["access_token"]
    assert login_response.json()["expires_in"] == 3600

    session_response = client.get(
        "/api/auth/session",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert session_response.status_code == 200
    assert session_response.json()["status"] == "active"


def test_provision_requires_authentication() -> None:
    response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com",
            "display_name": "Example Site",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
    )

    assert response.status_code == 401
