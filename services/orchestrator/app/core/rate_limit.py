"""Simple in-memory rate limiting for public, unauthenticated endpoints.

Protects the public Text/Voice Chat and login endpoints from a single
client hammering them (accidental loops, scraping, brute-forcing the admin
password). In-memory and per-process by design - this app runs as a single
uvicorn process, so no shared store (Redis, etc.) is needed. If this ever
scales to multiple orchestrator replicas behind a load balancer, swap the
in-memory dict below for a shared store.
"""

from __future__ import annotations

import time
from collections import defaultdict, deque
from threading import Lock

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

DEFAULT_RATE_LIMITED_PATH_PREFIXES = (
    "/api/orchestration/route",
    "/api/orchestration/chat",
    "/api/auth/login",
)


class SlidingWindowRateLimiter:
    def __init__(self, max_requests: int, window_seconds: float = 60.0) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def allow(self, key: str) -> bool:
        if self._max_requests <= 0:
            return True

        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > self._window_seconds:
                hits.popleft()
            if len(hits) >= self._max_requests:
                return False
            hits.append(now)
            return True


class RateLimitMiddleware(BaseHTTPMiddleware):
    def __init__(
        self,
        app,
        limiter: SlidingWindowRateLimiter,
        path_prefixes: tuple[str, ...] = DEFAULT_RATE_LIMITED_PATH_PREFIXES,
    ) -> None:
        super().__init__(app)
        self._limiter = limiter
        self._path_prefixes = path_prefixes

    async def dispatch(self, request: Request, call_next):
        if any(request.url.path.startswith(prefix) for prefix in self._path_prefixes):
            if not self._limiter.allow(_client_key(request)):
                return JSONResponse(
                    {"detail": "Too many requests. Please try again shortly."},
                    status_code=429,
                )
        return await call_next(request)


def _client_key(request: Request) -> str:
    # Behind the production Caddy reverse proxy, the real client address is
    # in X-Forwarded-For rather than request.client (which would be
    # Caddy's own address). Fall back to request.client for local/dev use
    # where there is no proxy in front.
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
