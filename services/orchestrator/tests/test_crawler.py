from contextlib import contextmanager
from unittest.mock import patch

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

from app.services.crawler import RenderedPage, WebsiteCrawler


@contextmanager
def fake_browser_context() -> object:
    yield object()


def test_website_crawler_extracts_links_and_chunks() -> None:
    crawler = WebsiteCrawler(max_pages=10, chunk_size=120, chunk_overlap=20)
    html_map = {
        "https://example.com/start": """
        <html>
          <head><title>Start</title></head>
          <body>
            <nav>Navigation should be removed</nav>
            <main>
              <h1>Start Page</h1>
              <p>IRA helps customers with onboarding, pricing, and support.</p>
              <a href="/pricing">Pricing</a>
            </main>
          </body>
        </html>
        """,
        "https://example.com/pricing": """
        <html>
          <head><title>Pricing</title></head>
          <body>
            <main>
              <h1>Pricing</h1>
              <p>IRA offers starter, growth, and enterprise plans for websites.</p>
            </main>
          </body>
        </html>
        """,
    }

    def fake_render_page(self: WebsiteCrawler, page: object, url: str) -> RenderedPage:
        normalized_url = url.rstrip("/")
        if normalized_url not in html_map:
            raise RuntimeError(f"Unexpected crawl URL: {url}")
        return RenderedPage(html=html_map[normalized_url], content_type="text/html; charset=utf-8")

    with (
        patch.object(WebsiteCrawler, "_open_browser", new=lambda self: fake_browser_context()),
        patch.object(WebsiteCrawler, "_new_page", new=lambda self, browser: object()),
        patch.object(WebsiteCrawler, "_render_page", new=fake_render_page),
    ):
        result = crawler.crawl(
            start_url="https://example.com/start",
            allowed_domains=["example.com"],
            max_depth=2,
        )

    assert result.pages_crawled == 2
    assert result.pages_discovered == 2
    assert result.pages_failed == 0
    assert len(result.chunks) >= 2
    assert all(chunk.page_url.startswith("https://example.com") for chunk in result.chunks)
    assert any("pricing" in chunk.text.lower() for chunk in result.chunks)


def test_website_crawler_falls_back_to_body_text_when_main_is_missing() -> None:
    crawler = WebsiteCrawler(max_pages=5, chunk_size=400, chunk_overlap=50)
    html_map = {
        "https://example.com/start": """
        <html>
          <head><title>Body Content</title></head>
          <body>
            <div class="hero">
              IRA helps businesses understand tax filing, payments, and support options across multiple services.
              This content is rendered in a generic container instead of a main tag, but should still be extracted
              as meaningful text for crawl ingestion and chunk creation.
            </div>
          </body>
        </html>
        """,
    }

    def fake_render_page(self: WebsiteCrawler, page: object, url: str) -> RenderedPage:
        normalized_url = url.rstrip("/")
        if normalized_url not in html_map:
            raise RuntimeError(f"Unexpected crawl URL: {url}")
        return RenderedPage(html=html_map[normalized_url], content_type="text/html; charset=utf-8")

    with (
        patch.object(WebsiteCrawler, "_open_browser", new=lambda self: fake_browser_context()),
        patch.object(WebsiteCrawler, "_new_page", new=lambda self, browser: object()),
        patch.object(WebsiteCrawler, "_render_page", new=fake_render_page),
    ):
        result = crawler.crawl(
            start_url="https://example.com/start",
            allowed_domains=["example.com"],
            max_depth=1,
        )

    assert result.pages_crawled == 1
    assert len(result.chunks) >= 1
    assert any("tax filing" in chunk.text.lower() for chunk in result.chunks)


def test_render_page_tolerates_load_state_timeout() -> None:
    crawler = WebsiteCrawler(page_load_state="networkidle", post_load_wait_ms=0)

    class FakeResponse:
        def header_value(self, name: str) -> str:
            return "text/html; charset=utf-8"

    class FakePage:
        def goto(self, url: str, wait_until: str) -> FakeResponse:
            assert url == "https://example.com"
            assert wait_until == "domcontentloaded"
            return FakeResponse()

        def wait_for_load_state(self, state: str, timeout: int) -> None:
            raise PlaywrightTimeoutError("network never idle")

        def wait_for_timeout(self, timeout: int) -> None:
            raise AssertionError("post-load wait should be skipped")

        def content(self) -> str:
            return "<html><body><main><p>Rendered text survives timeout fallback.</p></main></body></html>"

    rendered = crawler._render_page(FakePage(), "https://example.com")

    assert rendered.content_type == "text/html; charset=utf-8"
    assert "Rendered text survives timeout fallback." in rendered.html
