from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_admin_session
from app.core.config import get_settings
from app.services.sensitive_data import BLOCK_MESSAGE, SensitiveDataDetectedError
from app.schemas.orchestration import (
    ChatRequest,
    ChatResponse,
    CrawlJobCreateResponse,
    CrawlJobListResponse,
    OrchestrationRequest,
    OrchestrationResponse,
    WebsiteCrawlStatusResponse,
    WebsiteDocumentDeleteResponse,
    WebsiteDocumentListResponse,
    WebsiteDetailsResponse,
    WebsiteListResponse,
    WebsiteDocumentQueryRequest,
    WebsiteDocumentQueryResponse,
    WebsiteDocumentsUpsertRequest,
    WebsiteDocumentsUpsertResponse,
    WebsiteOnboardingRequest,
    WebsiteOnboardingResponse,
)
from app.services.auth import AdminSession
from app.services.orchestrator import OrchestratorService

router = APIRouter(prefix="/orchestration", tags=["orchestration"])


@router.post("/route", response_model=OrchestrationResponse)
def route_conversation(request: OrchestrationRequest) -> OrchestrationResponse:
    """Real end-user Voice Chat / Text Chat entry point. The sensitive-data
    filter always runs here."""
    service = OrchestratorService(get_settings())
    try:
        return service.route_conversation(request)
    except SensitiveDataDetectedError as error:
        raise HTTPException(status_code=422, detail=BLOCK_MESSAGE) from error


@router.post("/route/admin-preview", response_model=OrchestrationResponse)
def preview_route_conversation(
    request: OrchestrationRequest,
    _: AdminSession = Depends(get_current_admin_session),
) -> OrchestrationResponse:
    """Admin Portal's routing/prompt preview tool. Requires an admin session
    and intentionally skips the sensitive-data filter: administrators may
    test with content that looks like PII and that must not be blocked."""
    service = OrchestratorService(get_settings())
    return service.route_conversation(request, enforce_sensitive_filter=False)


@router.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest) -> ChatResponse:
    """Real end-user Text Chat entry point that returns an actual AI reply
    (unlike /route, which only returns the prompt/routing plan). The
    sensitive-data filter always runs here, via route_conversation."""
    service = OrchestratorService(get_settings())
    try:
        return service.generate_reply(request)
    except SensitiveDataDetectedError as error:
        raise HTTPException(status_code=422, detail=BLOCK_MESSAGE) from error


@router.post("/websites", response_model=WebsiteOnboardingResponse)
def provision_website(
    request: WebsiteOnboardingRequest,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteOnboardingResponse:
    service = OrchestratorService(get_settings())
    return service.provision_website(request)


@router.get("/websites", response_model=WebsiteListResponse)
def list_websites(
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteListResponse:
    service = OrchestratorService(get_settings())
    return service.list_websites()


@router.get("/websites/public", response_model=WebsiteListResponse)
def list_public_websites() -> WebsiteListResponse:
    service = OrchestratorService(get_settings())
    return service.list_websites()


@router.get("/websites/{website_id}", response_model=WebsiteDetailsResponse)
def get_website_details(
    website_id: str,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteDetailsResponse:
    service = OrchestratorService(get_settings())
    return service.get_website_details(website_id)


@router.get("/websites/{website_id}/crawl-status", response_model=WebsiteCrawlStatusResponse)
def get_website_crawl_status(
    website_id: str,
    limit: int = 10,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteCrawlStatusResponse:
    service = OrchestratorService(get_settings())
    return service.get_website_crawl_status(website_id, limit=limit)


@router.post("/websites/{website_id}/crawl-jobs", response_model=CrawlJobCreateResponse)
def queue_crawl_job(
    website_id: str,
    _: AdminSession = Depends(get_current_admin_session),
) -> CrawlJobCreateResponse:
    service = OrchestratorService(get_settings())
    return service.queue_crawl_job(website_id)


@router.get("/websites/{website_id}/crawl-jobs", response_model=CrawlJobListResponse)
def list_crawl_jobs(
    website_id: str,
    limit: int = 20,
    _: AdminSession = Depends(get_current_admin_session),
) -> CrawlJobListResponse:
    service = OrchestratorService(get_settings())
    return service.list_crawl_jobs(website_id, limit=limit)


@router.post("/documents", response_model=WebsiteDocumentsUpsertResponse)
def upsert_website_documents(
    request: WebsiteDocumentsUpsertRequest,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteDocumentsUpsertResponse:
    service = OrchestratorService(get_settings())
    return service.upsert_website_documents(request)


@router.post("/documents/query", response_model=WebsiteDocumentQueryResponse)
def query_website_documents(
    request: WebsiteDocumentQueryRequest,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteDocumentQueryResponse:
    service = OrchestratorService(get_settings())
    return service.query_website_documents(request)


@router.get("/documents", response_model=WebsiteDocumentListResponse)
def list_website_documents(
    website_id: str,
    limit: int = 20,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteDocumentListResponse:
    service = OrchestratorService(get_settings())
    return service.list_website_documents(website_id, limit=limit)


@router.delete("/documents/{document_id}", response_model=WebsiteDocumentDeleteResponse)
def delete_website_document(
    document_id: str,
    website_id: str,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteDocumentDeleteResponse:
    service = OrchestratorService(get_settings())
    return service.delete_website_document(website_id, document_id)
