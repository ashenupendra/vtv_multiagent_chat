from fastapi import APIRouter, Depends

from app.api.deps import get_current_admin_session
from app.core.config import get_settings
from app.schemas.orchestration import (
    OrchestrationRequest,
    OrchestrationResponse,
    WebsiteListResponse,
    WebsiteDocumentDeleteResponse,
    WebsiteDocumentListResponse,
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
    service = OrchestratorService(get_settings())
    return service.route_conversation(request)


@router.post("/websites", response_model=WebsiteOnboardingResponse)
def provision_website(
    request: WebsiteOnboardingRequest,
    _: AdminSession = Depends(get_current_admin_session),
) -> WebsiteOnboardingResponse:
    service = OrchestratorService(get_settings())
    return service.provision_website(request)


@router.get("/websites", response_model=WebsiteListResponse)
def list_websites() -> WebsiteListResponse:
    service = OrchestratorService(get_settings())
    return service.list_websites()


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
