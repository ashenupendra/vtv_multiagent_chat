from unittest.mock import patch

from fastapi.testclient import TestClient
from uuid import uuid4

from app.main import app
from app.services.crawler import CrawlChunk, CrawlPage, CrawlResult
from app.services.live import LiveProxyService
from app.core.config import Settings

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


def test_live_grounding_history_endpoint() -> None:
    service = LiveProxyService(Settings())
    service._store_live_grounding_event(  # type: ignore[attr-defined]
        website_id="history-site",
        session_id="history-session",
        event={
            "type": "grounding",
            "source": "text",
            "query": "support hours",
            "citations": [
                {
                    "label": "[1]",
                    "document_id": "doc-history",
                    "excerpt": "Support is available during weekdays.",
                }
            ],
            "matches": [
                {
                    "id": "doc-history",
                    "document": "Support is available during weekdays.",
                    "metadata": {"page_title": "Support"},
                }
            ],
        },
    )

    response = client.get(
        "/api/live/grounding-history?website_id=history-site&session_id=history-session&limit=10"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "loaded"
    assert body["website_id"] == "history-site"
    assert body["session_id"] == "history-session"
    assert len(body["entries"]) >= 1
    assert body["entries"][-1]["citations"][0]["label"] == "[1]"


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
    assert "citation labels" in body["route"]["system_prompt"].lower()
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
    assert body["crawl_status"] == "not_started"
    assert body["indexed_page_count"] == 0
    assert body["indexed_chunk_count"] == 0


def test_public_website_list() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com/public",
            "display_name": "Public Voice Site",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    response = client.get("/api/orchestration/websites/public")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "listed"
    assert any(website["website_id"] == website_id for website in body["websites"])


def test_public_website_list_does_not_scan_documents_per_website() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com/lightweight-list",
            "display_name": "Lightweight List",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    with patch(
        "app.services.orchestrator.ChromaRepository.list_documents",
        side_effect=AssertionError("list_documents should not be called for website list"),
    ):
        response = client.get("/api/orchestration/websites/public")

    assert response.status_code == 200
    assert response.json()["status"] == "listed"


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
    assert len(route_body["route"]["retrieval_matches"]) >= 1
    assert "support" in route_body["route"]["retrieval_matches"][0]["document"].lower()
    assert len(route_body["route"]["citations"]) >= 1
    assert route_body["route"]["citations"][0]["label"] == "[1]"


def test_voice_route_includes_retrieval_matches() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": "https://example.com/voice",
            "display_name": "Voice Ready",
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
                    "id": "voice-help",
                    "document": "Voice support covers multilingual onboarding and support guidance.",
                    "metadata": {"source": "seed", "page_title": "Voice Support"},
                }
            ],
        },
        headers={"Authorization": f"Bearer {token}"},
    )

    route_response = client.post(
        "/api/orchestration/route",
        json={
            "mode": "voice",
            "website_id": website_id,
            "session_id": "voice-retrieval-session",
            "message": "Can you help with multilingual onboarding?",
            "history": [],
            "language_hint": "en-US",
        },
    )

    assert route_response.status_code == 200
    route_body = route_response.json()
    assert route_body["route"]["agent"] == "voice_processing"
    assert len(route_body["route"]["retrieval_matches"]) >= 1
    assert len(route_body["route"]["citations"]) >= 1
    assert "multilingual onboarding" in route_body["route"]["grounding_prompt"].lower()


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


def test_crawl_status_and_job_queue() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]
    crawl_slug = uuid4().hex[:8]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": f"https://invalid.localhost/crawl/{crawl_slug}",
            "display_name": f"Crawl Ready {crawl_slug}",
            "allowed_domains": ["invalid.localhost"],
            "crawl_depth": 4,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    crawl_status_response = client.get(
        f"/api/orchestration/websites/{website_id}/crawl-status",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert crawl_status_response.status_code == 200
    crawl_status_body = crawl_status_response.json()
    assert crawl_status_body["crawl_status"] == "not_started"
    assert crawl_status_body["jobs"] == []

    with patch(
        "app.services.orchestrator.WebsiteCrawler.crawl",
        side_effect=RuntimeError("crawl failed"),
    ):
        queue_response = client.post(
            f"/api/orchestration/websites/{website_id}/crawl-jobs",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert queue_response.status_code == 200
    queue_body = queue_response.json()
    assert queue_body["status"] == "queued"
    assert queue_body["job"]["status"] == "failed"

    jobs_response = client.get(
        f"/api/orchestration/websites/{website_id}/crawl-jobs?limit=10",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert jobs_response.status_code == 200
    jobs_body = jobs_response.json()
    assert len(jobs_body["jobs"]) >= 1
    assert jobs_body["jobs"][0]["job_id"] == queue_body["job"]["job_id"]
    assert jobs_body["jobs"][0]["status"] == "failed"

    details_response = client.get(
        f"/api/orchestration/websites/{website_id}",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert details_response.status_code == 200
    details_body = details_response.json()
    assert details_body["crawl_status"] == "failed"
    assert details_body["latest_crawl_job_id"] == queue_body["job"]["job_id"]


def test_crawl_job_executes_and_ingests_documents() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]
    crawl_slug = uuid4().hex[:8]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": f"https://example.com/{crawl_slug}",
            "display_name": f"Crawlable Site {crawl_slug}",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    with patch(
        "app.services.orchestrator.WebsiteCrawler.crawl",
        return_value=CrawlResult(
            pages=[
                CrawlPage(
                    url=f"https://example.com/{crawl_slug}",
                    title="Home",
                    text="IRA supports onboarding, pricing, and help-desk automation.",
                    depth=0,
                    content_hash="page-home",
                ),
                CrawlPage(
                    url="https://example.com/about",
                    title="About",
                    text="IRA indexes website content into a searchable knowledge base.",
                    depth=1,
                    content_hash="page-about",
                ),
            ],
            chunks=[
                CrawlChunk(
                    chunk_id="crawl:page-home:0",
                    page_url=f"https://example.com/{crawl_slug}",
                    page_title="Home",
                    depth=0,
                    chunk_index=0,
                    chunk_count=1,
                    text="title: Home\nurl: https://example.com/home\ntext: IRA supports onboarding, pricing, and help-desk automation.",
                    content_hash="page-home",
                ),
                CrawlChunk(
                    chunk_id="crawl:page-about:0",
                    page_url="https://example.com/about",
                    page_title="About",
                    depth=1,
                    chunk_index=0,
                    chunk_count=1,
                    text="title: About\nurl: https://example.com/about\ntext: IRA indexes website content into a searchable knowledge base.",
                    content_hash="page-about",
                ),
            ],
            pages_discovered=2,
            pages_crawled=2,
            pages_failed=0,
        ),
    ):
        queue_response = client.post(
            f"/api/orchestration/websites/{website_id}/crawl-jobs",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert queue_response.status_code == 200
    queue_body = queue_response.json()
    assert queue_body["job"]["status"] == "completed"
    assert queue_body["job"]["pages_crawled"] == 2
    assert queue_body["job"]["indexed_chunk_count"] >= 2

    crawl_status_response = client.get(
        f"/api/orchestration/websites/{website_id}/crawl-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert crawl_status_response.status_code == 200
    crawl_status_body = crawl_status_response.json()
    assert crawl_status_body["crawl_status"] == "completed"
    assert crawl_status_body["indexed_page_count"] == 2
    assert crawl_status_body["indexed_chunk_count"] >= 2

    documents_response = client.get(
        f"/api/orchestration/documents?website_id={website_id}&limit=20",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert documents_response.status_code == 200
    documents_body = documents_response.json()
    assert len(documents_body["documents"]) >= 2
    assert all(document["metadata"].get("source") == "crawl" for document in documents_body["documents"])


def test_crawl_job_with_empty_result_is_marked_failed() -> None:
    login_response = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "change-me"},
    )
    token = login_response.json()["access_token"]
    crawl_slug = uuid4().hex[:8]

    provision_response = client.post(
        "/api/orchestration/websites",
        json={
            "website_url": f"https://example.com/{crawl_slug}",
            "display_name": f"Empty Crawl {crawl_slug}",
            "allowed_domains": ["example.com"],
            "crawl_depth": 2,
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    website_id = provision_response.json()["website_id"]

    with patch(
        "app.services.orchestrator.WebsiteCrawler.crawl",
        return_value=CrawlResult(
            pages=[],
            chunks=[],
            pages_discovered=1,
            pages_crawled=0,
            pages_failed=0,
        ),
    ):
        queue_response = client.post(
            f"/api/orchestration/websites/{website_id}/crawl-jobs",
            headers={"Authorization": f"Bearer {token}"},
        )

    assert queue_response.status_code == 200
    queue_body = queue_response.json()
    assert queue_body["job"]["status"] == "failed"
    assert "without extracting any indexable website content" in (
        queue_body["job"]["error_message"] or ""
    )

    crawl_status_response = client.get(
        f"/api/orchestration/websites/{website_id}/crawl-status",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert crawl_status_response.status_code == 200
    crawl_status_body = crawl_status_response.json()
    assert crawl_status_body["crawl_status"] == "failed"
    assert crawl_status_body["indexed_page_count"] == 0
    assert crawl_status_body["indexed_chunk_count"] == 0
    assert "without extracting any indexable website content" in (
        crawl_status_body["last_error"] or ""
    )


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
