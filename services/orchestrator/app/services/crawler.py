from __future__ import annotations

import hashlib
import re
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass
from urllib.parse import urljoin, urlparse, urlunparse

from bs4 import BeautifulSoup
from playwright.sync_api import Browser, Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


@dataclass(frozen=True)
class CrawlPage:
    url: str
    title: str
    text: str
    depth: int
    content_hash: str


@dataclass(frozen=True)
class CrawlChunk:
    chunk_id: str
    page_url: str
    page_title: str
    depth: int
    chunk_index: int
    chunk_count: int
    text: str
    content_hash: str


@dataclass(frozen=True)
class CrawlResult:
    pages: list[CrawlPage]
    chunks: list[CrawlChunk]
    pages_discovered: int
    pages_crawled: int
    pages_failed: int


@dataclass(frozen=True)
class RenderedPage:
    html: str
    content_type: str


class WebsiteCrawler:
    def __init__(
        self,
        user_agent: str = "IRA Crawler/0.1",
        timeout_seconds: float = 15.0,
        max_pages: int = 25,
        chunk_size: int = 1000,
        chunk_overlap: int = 150,
        page_load_state: str = "load",
        post_load_wait_ms: int = 1500,
    ) -> None:
        self._user_agent = user_agent
        self._timeout_seconds = timeout_seconds
        self._max_pages = max_pages
        self._chunk_size = chunk_size
        self._chunk_overlap = chunk_overlap
        self._page_load_state = page_load_state
        self._post_load_wait_ms = post_load_wait_ms

    def crawl(
        self,
        start_url: str,
        allowed_domains: list[str],
        max_depth: int,
    ) -> CrawlResult:
        normalized_start = self._normalize_url(start_url)
        queue: deque[tuple[str, int]] = deque([(normalized_start, 0)])
        visited: set[str] = set()
        discovered: set[str] = {normalized_start}
        pages: list[CrawlPage] = []
        chunks: list[CrawlChunk] = []
        pages_failed = 0

        with self._open_browser() as browser:
            page = self._new_page(browser)
            while queue and len(pages) < self._max_pages:
                url, depth = queue.popleft()
                if url in visited:
                    continue
                visited.add(url)

                try:
                    rendered = self._render_page(page, url)
                    if "text/html" not in rendered.content_type:
                        continue

                    crawled_page = self._extract_page(url, rendered.html, depth)
                    if not crawled_page.text.strip():
                        continue

                    pages.append(crawled_page)
                    chunks.extend(self._chunk_page(crawled_page))

                    if depth >= max_depth:
                        continue

                    for link in self._extract_links(url, rendered.html):
                        if link in discovered:
                            continue
                        if not self._is_allowed(link, allowed_domains):
                            continue
                        discovered.add(link)
                        queue.append((link, depth + 1))
                except Exception:
                    pages_failed += 1

        return CrawlResult(
            pages=pages,
            chunks=chunks,
            pages_discovered=len(discovered),
            pages_crawled=len(pages),
            pages_failed=pages_failed,
        )

    def _extract_page(self, url: str, html: str, depth: int) -> CrawlPage:
        soup = BeautifulSoup(html, "html.parser")

        for tag_name in ("script", "style", "svg"):
            for element in soup.find_all(tag_name):
                element.decompose()

        for selector in ("nav", "footer", "aside", "form"):
            for element in soup.select(selector):
                element.decompose()

        title = self._clean_text(soup.title.get_text(" ", strip=True) if soup.title else "")
        text = self._extract_primary_text(soup)
        content_hash = hashlib.sha1(text.encode("utf-8")).hexdigest()
        return CrawlPage(
            url=url,
            title=title or url,
            text=text,
            depth=depth,
            content_hash=content_hash,
        )

    @contextmanager
    def _open_browser(self):
        playwright = sync_playwright().start()
        browser = playwright.chromium.launch(headless=True)
        try:
            yield browser
        finally:
            browser.close()
            playwright.stop()

    def _new_page(self, browser: Browser) -> Page:
        context = browser.new_context(user_agent=self._user_agent)
        page = context.new_page()
        page.set_default_navigation_timeout(int(self._timeout_seconds * 1000))
        page.set_default_timeout(int(self._timeout_seconds * 1000))
        return page

    def _render_page(self, page: Page, url: str) -> RenderedPage:
        response = page.goto(url, wait_until="domcontentloaded")
        if self._page_load_state and self._page_load_state != "domcontentloaded":
            try:
                page.wait_for_load_state(self._page_load_state, timeout=int(self._timeout_seconds * 1000))
            except PlaywrightTimeoutError:
                # Some sites keep analytics or polling requests open, so fall back to the current DOM.
                pass
        if self._post_load_wait_ms > 0:
            page.wait_for_timeout(self._post_load_wait_ms)
        html = page.content()
        content_type = ""
        if response is not None:
            content_type = response.header_value("content-type") or ""
        return RenderedPage(html=html, content_type=content_type or "text/html")

    def _chunk_page(self, page: CrawlPage) -> list[CrawlChunk]:
        segments = self._split_into_segments(page.text)
        if not segments:
            return []

        chunks: list[str] = []
        current = ""
        for segment in segments:
            candidate = segment if not current else f"{current}\n\n{segment}"
            if len(candidate) <= self._chunk_size:
                current = candidate
                continue

            if current:
                chunks.append(current)
            if len(segment) <= self._chunk_size:
                current = segment
                continue

            chunks.extend(self._slice_long_segment(segment))
            current = ""

        if current:
            chunks.append(current)

        result: list[CrawlChunk] = []
        chunk_count = len(chunks)
        for index, text in enumerate(chunks):
            chunk_text = f"title: {page.title}\nurl: {page.url}\ntext: {text}"
            chunk_id = f"crawl:{page.content_hash}:{index}"
            result.append(
                CrawlChunk(
                    chunk_id=chunk_id,
                    page_url=page.url,
                    page_title=page.title,
                    depth=page.depth,
                    chunk_index=index,
                    chunk_count=chunk_count,
                    text=chunk_text,
                    content_hash=page.content_hash,
                )
            )
        return result

    def _extract_links(self, current_url: str, html: str) -> list[str]:
        soup = BeautifulSoup(html, "html.parser")
        links: list[str] = []
        for element in soup.find_all("a", href=True):
            href = str(element.get("href", "")).strip()
            if not href or href.startswith("#") or href.startswith("mailto:") or href.startswith("tel:"):
                continue
            normalized = self._normalize_url(urljoin(current_url, href))
            if normalized:
                links.append(normalized)
        return links

    @staticmethod
    def _split_into_segments(text: str) -> list[str]:
        blocks = [block.strip() for block in re.split(r"\n\s*\n+", text) if block.strip()]
        return blocks

    def _extract_primary_text(self, soup: BeautifulSoup) -> str:
        candidates = [
            soup.find("main"),
            soup.find("article"),
            soup.find(attrs={"role": "main"}),
            soup.select_one("[data-testid='main-content']"),
            soup.select_one(".main-content"),
            soup.select_one("#main-content"),
            soup.select_one(".content"),
            soup.select_one("#content"),
            soup.body,
            soup,
        ]

        best_text = ""
        for candidate in candidates:
            if candidate is None:
                continue
            text = self._clean_text(candidate.get_text("\n", strip=True))
            if len(text) > len(best_text):
                best_text = text
            if self._has_meaningful_text(text):
                return text

        return best_text

    @staticmethod
    def _has_meaningful_text(text: str, minimum_length: int = 160) -> bool:
        if len(text) < minimum_length:
            return False
        word_count = len(re.findall(r"\w+", text))
        return word_count >= 25

    def _slice_long_segment(self, text: str) -> list[str]:
        pieces: list[str] = []
        start = 0
        while start < len(text):
            end = min(start + self._chunk_size, len(text))
            pieces.append(text[start:end].strip())
            if end >= len(text):
                break
            start = max(end - self._chunk_overlap, start + 1)
        return [piece for piece in pieces if piece]

    @staticmethod
    def _clean_text(value: str) -> str:
        normalized = re.sub(r"\s+", " ", value).strip()
        return normalized

    @staticmethod
    def _normalize_url(url: str) -> str:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return ""
        normalized_path = parsed.path or "/"
        cleaned = parsed._replace(fragment="", params="", query="", path=normalized_path)
        return urlunparse(cleaned).rstrip("/") or urlunparse(cleaned)

    @staticmethod
    def _is_allowed(url: str, allowed_domains: list[str]) -> bool:
        hostname = (urlparse(url).hostname or "").lower()
        if not hostname:
            return False
        normalized_allowed = [domain.lower().strip() for domain in allowed_domains if domain.strip()]
        if not normalized_allowed:
            return True
        return any(hostname == domain or hostname.endswith(f".{domain}") for domain in normalized_allowed)
