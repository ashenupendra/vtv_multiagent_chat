from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl


ConversationMode = Literal["text", "voice"]
AgentKind = Literal["text_chat", "voice_processing"]
CrawlStatus = Literal["not_started", "queued", "running", "completed", "failed"]
CrawlJobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(min_length=1)


class OrchestrationRequest(BaseModel):
    mode: ConversationMode
    website_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    message: str = Field(min_length=1)
    history: list[ChatMessage] = Field(default_factory=list)
    language_hint: str | None = None


class AgentSelection(BaseModel):
    agent: AgentKind
    default_model: str
    website_id: str
    rag_collection: str
    rag_status: str | None = None
    system_prompt: str | None = None
    router_prompt: str | None = None
    grounding_prompt: str | None = None
    website_prompt: str | None = None
    website_prompt_override_applied: bool = False
    retrieval_matches: list["WebsiteDocumentRecord"] = Field(default_factory=list)
    citations: list["CitationRecord"] = Field(default_factory=list)


class CitationRecord(BaseModel):
    label: str
    document_id: str
    source: str | None = None
    page_title: str | None = None
    page_url: str | None = None
    excerpt: str


class OrchestrationResponse(BaseModel):
    status: Literal["accepted"]
    route: AgentSelection
    fallback_message: str
    observability_trace_id: str


class ChatRequest(BaseModel):
    website_id: str = Field(min_length=1)
    session_id: str = Field(min_length=1)
    message: str = Field(min_length=1)
    history: list[ChatMessage] = Field(default_factory=list)


class ChatResponse(BaseModel):
    status: Literal["answered"]
    reply: str
    citations: list[CitationRecord] = Field(default_factory=list)
    observability_trace_id: str


class WebsiteOnboardingRequest(BaseModel):
    website_url: HttpUrl
    display_name: str = Field(min_length=2)
    allowed_domains: list[str] = Field(default_factory=list)
    crawl_depth: int = Field(default=2, ge=1, le=10)
    prompt_override: str | None = None


class WebsiteOnboardingResponse(BaseModel):
    status: Literal["provisioned"]
    website_id: str
    rag_collection: str
    rag_status: str
    rag_endpoint: str
    rag_document_count: int
    crawl_status: CrawlStatus
    crawl_schedule: str
    indexed_page_count: int
    indexed_chunk_count: int
    last_crawled_at: datetime | None = None
    last_error: str | None = None
    latest_crawl_job_id: str | None = None
    recommended_text_model: str
    recommended_live_model: str


class WebsiteDetailsResponse(BaseModel):
    status: Literal["loaded"]
    website_id: str
    display_name: str | None = None
    website_url: str | None = None
    allowed_domains: list[str] = Field(default_factory=list)
    crawl_depth: int | None = None
    prompt_override: str | None = None
    rag_collection: str
    rag_status: str
    rag_endpoint: str
    rag_document_count: int
    crawl_status: CrawlStatus
    crawl_schedule: str
    indexed_page_count: int
    indexed_chunk_count: int
    last_crawled_at: datetime | None = None
    last_error: str | None = None
    latest_crawl_job_id: str | None = None
    recommended_text_model: str
    recommended_live_model: str


class WebsiteSummaryResponse(BaseModel):
    website_id: str
    display_name: str | None = None
    website_url: str | None = None
    allowed_domains: list[str] = Field(default_factory=list)
    crawl_depth: int | None = None
    rag_collection: str
    rag_status: str
    crawl_status: CrawlStatus
    indexed_page_count: int
    indexed_chunk_count: int
    latest_crawl_job_id: str | None = None


class WebsiteListResponse(BaseModel):
    status: Literal["listed"]
    websites: list[WebsiteSummaryResponse] = Field(default_factory=list)


class CrawlJobResponse(BaseModel):
    job_id: str
    website_id: str
    status: CrawlJobStatus
    scheduled_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    pages_discovered: int = 0
    pages_crawled: int = 0
    pages_failed: int = 0
    indexed_page_count: int = 0
    indexed_chunk_count: int = 0
    error_message: str | None = None


class WebsiteCrawlStatusResponse(BaseModel):
    status: Literal["loaded"]
    website_id: str
    crawl_status: CrawlStatus
    crawl_schedule: str
    indexed_page_count: int
    indexed_chunk_count: int
    last_crawled_at: datetime | None = None
    last_error: str | None = None
    latest_crawl_job_id: str | None = None
    jobs: list[CrawlJobResponse] = Field(default_factory=list)


class CrawlJobListResponse(BaseModel):
    status: Literal["listed"]
    website_id: str
    jobs: list[CrawlJobResponse] = Field(default_factory=list)


class CrawlJobCreateResponse(BaseModel):
    status: Literal["queued"]
    website_id: str
    job: CrawlJobResponse


class WebsiteDocumentRecord(BaseModel):
    id: str
    document: str
    metadata: dict[str, str] = Field(default_factory=dict)


class WebsiteDocumentUpsertItem(BaseModel):
    id: str = Field(min_length=1)
    document: str = Field(min_length=1)
    metadata: dict[str, str] = Field(default_factory=dict)


class WebsiteDocumentsUpsertRequest(BaseModel):
    website_id: str = Field(min_length=1)
    documents: list[WebsiteDocumentUpsertItem] = Field(min_length=1)


class WebsiteDocumentsUpsertResponse(BaseModel):
    status: Literal["upserted"]
    website_id: str
    rag_collection: str
    rag_status: str
    upserted_count: int
    total_document_count: int


class WebsiteDocumentQueryRequest(BaseModel):
    website_id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    limit: int = Field(default=5, ge=1, le=20)


class WebsiteDocumentQueryResponse(BaseModel):
    status: Literal["queried"]
    website_id: str
    rag_collection: str
    rag_status: str
    matches: list[WebsiteDocumentRecord] = Field(default_factory=list)


class WebsiteDocumentListResponse(BaseModel):
    status: Literal["listed"]
    website_id: str
    rag_collection: str
    rag_status: str
    documents: list[WebsiteDocumentRecord] = Field(default_factory=list)


class WebsiteDocumentDeleteResponse(BaseModel):
    status: Literal["deleted"]
    website_id: str
    rag_collection: str
    rag_status: str
    deleted_count: int
    total_document_count: int
