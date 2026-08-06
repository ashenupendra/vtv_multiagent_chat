from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.rate_limit import RateLimitMiddleware, SlidingWindowRateLimiter


def _build_test_app(max_requests: int) -> FastAPI:
    app = FastAPI()

    @app.get("/api/orchestration/route")
    def limited_route() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/health")
    def unlimited_route() -> dict[str, str]:
        return {"status": "ok"}

    app.add_middleware(
        RateLimitMiddleware,
        limiter=SlidingWindowRateLimiter(max_requests=max_requests),
    )
    return app


def test_rate_limit_blocks_after_threshold() -> None:
    client = TestClient(_build_test_app(max_requests=3))

    for _ in range(3):
        assert client.get("/api/orchestration/route").status_code == 200

    response = client.get("/api/orchestration/route")
    assert response.status_code == 429
    assert "too many requests" in response.json()["detail"].lower()


def test_rate_limit_does_not_apply_to_unlisted_paths() -> None:
    client = TestClient(_build_test_app(max_requests=1))

    client.get("/api/orchestration/route")  # uses up the one allowed slot

    for _ in range(5):
        assert client.get("/api/health").status_code == 200


def test_rate_limit_uses_forwarded_for_when_behind_proxy() -> None:
    client = TestClient(_build_test_app(max_requests=1))

    first = client.get(
        "/api/orchestration/route",
        headers={"X-Forwarded-For": "203.0.113.1"},
    )
    assert first.status_code == 200

    # Same forwarded client -> blocked, even though TestClient's own
    # transport-level address is identical for every request.
    second = client.get(
        "/api/orchestration/route",
        headers={"X-Forwarded-For": "203.0.113.1"},
    )
    assert second.status_code == 429

    # A different forwarded client is a separate bucket.
    third = client.get(
        "/api/orchestration/route",
        headers={"X-Forwarded-For": "203.0.113.2"},
    )
    assert third.status_code == 200
