from typing import Literal

from pydantic import BaseModel, Field, HttpUrl


ConversationMode = Literal["text", "voice"]
AgentKind = Literal["text_chat", "voice_processing"]


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


class OrchestrationResponse(BaseModel):
    status: Literal["accepted"]
    route: AgentSelection
    fallback_message: str
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
    crawl_schedule: str
    recommended_text_model: str
    recommended_live_model: str


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
