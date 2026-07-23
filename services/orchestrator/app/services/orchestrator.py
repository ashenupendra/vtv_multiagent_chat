import hashlib
import re
from uuid import uuid4

from app.core.config import Settings
from app.repositories.chroma import ChromaRepository, RAGDocumentRecord
from app.schemas.orchestration import (
    AgentSelection,
    OrchestrationRequest,
    OrchestrationResponse,
    WebsiteListResponse,
    WebsiteSummary,
    WebsiteDocumentQueryRequest,
    WebsiteDocumentQueryResponse,
    WebsiteDocumentDeleteResponse,
    WebsiteDocumentListResponse,
    WebsiteDocumentRecord,
    WebsiteDocumentsUpsertRequest,
    WebsiteDocumentsUpsertResponse,
    WebsiteOnboardingRequest,
    WebsiteOnboardingResponse,
)
from app.services.agents import AgentContext, TextChatAgent, VoiceProcessingAgent
from app.services.prompts import PromptContext, build_prompt_blueprint


class OrchestratorService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rag_repository = ChromaRepository(settings)
        self._text_agent = TextChatAgent(settings.google_runtime.text_model)
        self._voice_agent = VoiceProcessingAgent(settings.google_runtime.live_model)

    def route_conversation(self, request: OrchestrationRequest) -> OrchestrationResponse:
        context = AgentContext(
            website_id=request.website_id,
            session_id=request.session_id,
            message=request.message,
            language_hint=request.language_hint,
        )
        rag_binding = self._rag_repository.collection_for_website(request.website_id)
        prompt_blueprint = build_prompt_blueprint(
            PromptContext(
                agent="voice_processing" if request.mode == "voice" else "text_chat",
                website_id=request.website_id,
                session_id=request.session_id,
                message=request.message,
                model=(
                    self._settings.google_runtime.live_model
                    if request.mode == "voice"
                    else self._settings.google_runtime.text_model
                ),
                rag_collection=rag_binding.collection_name,
                rag_status=rag_binding.status,
                display_name=rag_binding.metadata.get("display_name"),
                website_url=rag_binding.metadata.get("website_url"),
                allowed_domains=tuple(
                    item.strip()
                    for item in rag_binding.metadata.get("allowed_domains", "").split(",")
                    if item.strip()
                ),
                crawl_depth=(
                    int(rag_binding.metadata["crawl_depth"])
                    if rag_binding.metadata.get("crawl_depth", "").isdigit()
                    else None
                ),
                prompt_override=rag_binding.metadata.get("prompt_override") or None,
                language_hint=request.language_hint,
            )
        )
        plan = (
            self._voice_agent.build_plan(context, prompt_blueprint)
            if request.mode == "voice"
            else self._text_agent.build_plan(context, prompt_blueprint)
        )

        return OrchestrationResponse(
            status="accepted",
            route=AgentSelection(
                agent=plan.agent_name,
                default_model=plan.default_model,
                website_id=request.website_id,
                rag_collection=rag_binding.collection_name,
                rag_status=rag_binding.status,
                system_prompt=plan.prompt_blueprint.composed_system_prompt,
                router_prompt=plan.prompt_blueprint.router_prompt,
                grounding_prompt=plan.prompt_blueprint.grounding_prompt,
                website_prompt=plan.prompt_blueprint.website_prompt,
                website_prompt_override_applied=(
                    plan.prompt_blueprint.website_prompt_override_applied
                ),
            ),
            fallback_message=plan.fallback_message,
            observability_trace_id=f"trace-{uuid4()}",
        )

    def provision_website(
        self,
        request: WebsiteOnboardingRequest,
    ) -> WebsiteOnboardingResponse:
        website_id = self._build_website_id(request.display_name, str(request.website_url))
        rag_binding = self._rag_repository.ensure_collection(
            website_id,
            metadata={
                "website_url": str(request.website_url),
                "display_name": request.display_name,
                "allowed_domains": ",".join(request.allowed_domains),
                "crawl_depth": str(request.crawl_depth),
                "prompt_override": request.prompt_override or "",
            },
        )
        return WebsiteOnboardingResponse(
            status="provisioned",
            website_id=website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=rag_binding.status,
            rag_endpoint=rag_binding.endpoint,
            rag_document_count=rag_binding.document_count,
            crawl_schedule="daily",
            recommended_text_model=self._settings.google_runtime.text_model,
            recommended_live_model=self._settings.google_runtime.live_model,
        )

    def list_websites(self) -> WebsiteListResponse:
        bindings = self._rag_repository.list_website_collections()
        websites = [
            WebsiteSummary(
                website_id=binding.website_id,
                display_name=binding.metadata.get("display_name") or None,
                website_url=binding.metadata.get("website_url") or None,
                rag_collection=binding.collection_name,
                rag_status=binding.status,
                rag_endpoint=binding.endpoint,
                rag_document_count=binding.document_count,
            )
            for binding in sorted(bindings, key=lambda item: item.website_id)
        ]
        return WebsiteListResponse(status="listed", websites=websites)

    def list_website_documents(
        self,
        website_id: str,
        limit: int = 20,
    ) -> WebsiteDocumentListResponse:
        rag_binding = self._rag_repository.collection_for_website(website_id)
        documents = self._rag_repository.list_documents(website_id, limit=limit)
        return WebsiteDocumentListResponse(
            status="listed",
            website_id=website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=rag_binding.status,
            documents=[
                WebsiteDocumentRecord(
                    id=document.id,
                    document=document.document,
                    metadata=document.metadata,
                )
                for document in documents
            ],
        )

    def upsert_website_documents(
        self,
        request: WebsiteDocumentsUpsertRequest,
    ) -> WebsiteDocumentsUpsertResponse:
        rag_binding = self._rag_repository.upsert_documents(
            request.website_id,
            documents=[
                RAGDocumentRecord(
                    id=document.id,
                    document=document.document,
                    metadata=document.metadata,
                )
                for document in request.documents
            ],
        )
        return WebsiteDocumentsUpsertResponse(
            status="upserted",
            website_id=request.website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=rag_binding.status,
            upserted_count=len(request.documents),
            total_document_count=rag_binding.document_count,
        )

    def query_website_documents(
        self,
        request: WebsiteDocumentQueryRequest,
    ) -> WebsiteDocumentQueryResponse:
        rag_binding, matches = self._rag_repository.query_documents(
            request.website_id,
            request.query,
            request.limit,
        )
        return WebsiteDocumentQueryResponse(
            status="queried",
            website_id=request.website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=rag_binding.status,
            matches=[
                WebsiteDocumentRecord(
                    id=document.id,
                    document=document.document,
                    metadata=document.metadata,
                )
                for document in matches
            ],
        )

    def delete_website_document(
        self,
        website_id: str,
        document_id: str,
    ) -> WebsiteDocumentDeleteResponse:
        rag_binding = self._rag_repository.collection_for_website(website_id)
        existing_documents = self._rag_repository.list_documents(website_id, limit=1000)
        existing_ids = {document.id for document in existing_documents}
        updated_binding = self._rag_repository.delete_documents(website_id, [document_id])
        deleted_count = 1 if document_id in existing_ids else 0
        return WebsiteDocumentDeleteResponse(
            status="deleted",
            website_id=website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=updated_binding.status,
            deleted_count=deleted_count,
            total_document_count=updated_binding.document_count,
        )

    @staticmethod
    def _build_website_id(display_name: str, website_url: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", display_name.lower()).strip("-")
        slug = re.sub(r"-{2,}", "-", slug)
        if not slug:
            slug = "website"

        suffix = hashlib.sha1(website_url.encode("utf-8")).hexdigest()[:6]
        return f"{slug}-{suffix}"
