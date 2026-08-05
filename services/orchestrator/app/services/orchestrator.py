import hashlib
import logging
import re
from datetime import datetime, timezone
from uuid import uuid4

from app.core.config import Settings
from app.repositories.chroma import ChromaRepository, RAGDocumentRecord
from app.schemas.orchestration import (
    AgentSelection,
    CitationRecord,
    CrawlJobCreateResponse,
    CrawlJobListResponse,
    CrawlJobResponse,
    OrchestrationRequest,
    OrchestrationResponse,
    WebsiteDocumentDeleteResponse,
    WebsiteDocumentListResponse,
    WebsiteDocumentRecord,
    WebsiteCrawlStatusResponse,
    WebsiteDetailsResponse,
    WebsiteListResponse,
    WebsiteDocumentQueryRequest,
    WebsiteDocumentQueryResponse,
    WebsiteDocumentsUpsertRequest,
    WebsiteDocumentsUpsertResponse,
    WebsiteOnboardingRequest,
    WebsiteOnboardingResponse,
    WebsiteSummaryResponse,
)
from app.services.agents import AgentContext, TextChatAgent, VoiceProcessingAgent
from app.services.crawler import WebsiteCrawler
from app.services.prompts import PromptContext, RetrievedSnippet, build_prompt_blueprint
from app.services.sensitive_data import SensitiveDataDetectedError, scan_for_sensitive_data

logger = logging.getLogger(__name__)


class OrchestratorService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._rag_repository = ChromaRepository(settings)
        self._text_agent = TextChatAgent(settings.google_runtime.text_model)
        self._voice_agent = VoiceProcessingAgent(settings.google_runtime.live_model)
        self._crawler = WebsiteCrawler()

    def route_conversation(
        self,
        request: OrchestrationRequest,
        *,
        enforce_sensitive_filter: bool = True,
    ) -> OrchestrationResponse:
        # The sensitive-data filter protects real end-user Voice Chat and Text
        # Chat traffic only. Admin Portal callers (e.g. the route preview tool
        # used to inspect prompt/routing behavior) opt out via
        # enforce_sensitive_filter=False - administrators may intentionally
        # test with content that looks like PII, and that must never be
        # blocked by the runtime conversation filter.
        if enforce_sensitive_filter:
            findings = scan_for_sensitive_data(request.message)
            if findings:
                logger.warning(
                    "Blocked orchestration request containing sensitive data",
                    extra={
                        "website_id": request.website_id,
                        "session_id": request.session_id,
                        "mode": request.mode,
                        "categories": sorted({finding.category for finding in findings}),
                    },
                )
                raise SensitiveDataDetectedError(findings)

        context = AgentContext(
            website_id=request.website_id,
            session_id=request.session_id,
            message=request.message,
            language_hint=request.language_hint,
        )
        rag_binding = self._rag_repository.collection_for_website(request.website_id)
        retrieval_matches = self._load_retrieval_matches(
            website_id=request.website_id,
            query=request.message,
            limit=4,
        )
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
                retrieval_matches=tuple(retrieval_matches),
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
                retrieval_matches=[
                    WebsiteDocumentRecord(
                        id=match.id,
                        document=match.document,
                        metadata={
                            key: value
                            for key, value in {
                                "source": match.source,
                                "page_url": match.page_url,
                                "page_title": match.page_title,
                                "citation_label": self._citation_label(index),
                            }.items()
                            if value
                        },
                    )
                    for index, match in enumerate(retrieval_matches, start=1)
                ],
                citations=self._build_citations(retrieval_matches),
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
        website_state = self._merge_website_state(
            website_id,
            rag_document_count=rag_binding.document_count,
        )
        self._save_website_state(website_state)
        return WebsiteOnboardingResponse(
            status="provisioned",
            website_id=website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=rag_binding.status,
            rag_endpoint=rag_binding.endpoint,
            rag_document_count=rag_binding.document_count,
            crawl_status=website_state["crawl_status"],
            crawl_schedule=website_state["crawl_schedule"],
            indexed_page_count=website_state["indexed_page_count"],
            indexed_chunk_count=website_state["indexed_chunk_count"],
            last_crawled_at=self._parse_datetime(website_state.get("last_crawled_at")),
            last_error=self._as_optional_string(website_state.get("last_error")),
            latest_crawl_job_id=self._as_optional_string(website_state.get("latest_crawl_job_id")),
            recommended_text_model=self._settings.google_runtime.text_model,
            recommended_live_model=self._settings.google_runtime.live_model,
        )

    def get_website_details(self, website_id: str) -> WebsiteDetailsResponse:
        rag_binding = self._rag_repository.collection_for_website(website_id)
        documents = self._rag_repository.list_documents(website_id, limit=1000)
        metadata = rag_binding.metadata
        crawl_depth_raw = metadata.get("crawl_depth", "")
        website_state = self._merge_website_state(website_id, rag_document_count=len(documents))

        return WebsiteDetailsResponse(
            status="loaded",
            website_id=website_id,
            display_name=metadata.get("display_name") or None,
            website_url=metadata.get("website_url") or None,
            allowed_domains=[
                item.strip()
                for item in metadata.get("allowed_domains", "").split(",")
                if item.strip()
            ],
            crawl_depth=int(crawl_depth_raw) if crawl_depth_raw.isdigit() else None,
            prompt_override=metadata.get("prompt_override") or None,
            rag_collection=rag_binding.collection_name,
            rag_status=rag_binding.status,
            rag_endpoint=rag_binding.endpoint,
            rag_document_count=len(documents),
            crawl_status=website_state["crawl_status"],
            crawl_schedule=website_state["crawl_schedule"],
            indexed_page_count=website_state["indexed_page_count"],
            indexed_chunk_count=website_state["indexed_chunk_count"],
            last_crawled_at=self._parse_datetime(website_state.get("last_crawled_at")),
            last_error=self._as_optional_string(website_state.get("last_error")),
            latest_crawl_job_id=self._as_optional_string(website_state.get("latest_crawl_job_id")),
            recommended_text_model=self._settings.google_runtime.text_model,
            recommended_live_model=self._settings.google_runtime.live_model,
        )

    def list_websites(self) -> WebsiteListResponse:
        bindings = self._rag_repository.list_website_collections()
        state_by_website = {
            self._as_optional_string(state.get("website_id")) or "": state
            for state in self._rag_repository.list_state_records("website_state", limit=1000)
        }
        websites: list[WebsiteSummaryResponse] = []

        for binding in bindings:
            crawl_depth_raw = binding.metadata.get("crawl_depth", "")
            persisted_state = state_by_website.get(binding.website_id)
            website_state = self._merge_website_state(
                binding.website_id,
                rag_document_count=self._as_non_negative_int(
                    persisted_state.get("indexed_chunk_count") if persisted_state else None
                ),
                state=persisted_state,
            )
            websites.append(
                WebsiteSummaryResponse(
                    website_id=binding.website_id,
                    display_name=binding.metadata.get("display_name") or None,
                    website_url=binding.metadata.get("website_url") or None,
                    allowed_domains=[
                        item.strip()
                        for item in binding.metadata.get("allowed_domains", "").split(",")
                        if item.strip()
                    ],
                    crawl_depth=int(crawl_depth_raw) if crawl_depth_raw.isdigit() else None,
                    rag_collection=binding.collection_name,
                    rag_status=binding.status,
                    crawl_status=website_state["crawl_status"],
                    indexed_page_count=website_state["indexed_page_count"],
                    indexed_chunk_count=website_state["indexed_chunk_count"],
                    latest_crawl_job_id=self._as_optional_string(
                        website_state.get("latest_crawl_job_id")
                    ),
                )
            )

        return WebsiteListResponse(status="listed", websites=websites)

    def get_website_crawl_status(
        self,
        website_id: str,
        limit: int = 10,
    ) -> WebsiteCrawlStatusResponse:
        website_state = self._merge_website_state(
            website_id,
            rag_document_count=len(self._rag_repository.list_documents(website_id, limit=1000)),
        )
        jobs = self._list_crawl_job_models(website_id, limit=limit)
        return WebsiteCrawlStatusResponse(
            status="loaded",
            website_id=website_id,
            crawl_status=website_state["crawl_status"],
            crawl_schedule=website_state["crawl_schedule"],
            indexed_page_count=website_state["indexed_page_count"],
            indexed_chunk_count=website_state["indexed_chunk_count"],
            last_crawled_at=self._parse_datetime(website_state.get("last_crawled_at")),
            last_error=self._as_optional_string(website_state.get("last_error")),
            latest_crawl_job_id=self._as_optional_string(website_state.get("latest_crawl_job_id")),
            jobs=jobs,
        )

    def queue_crawl_job(self, website_id: str) -> CrawlJobCreateResponse:
        details = self.get_website_details(website_id)
        if not details.website_url:
            raise ValueError("Website URL is required before running a crawl.")

        website_state = self._merge_website_state(
            website_id,
            rag_document_count=len(self._rag_repository.list_documents(website_id, limit=1000)),
        )
        job_id = f"crawl-{uuid4()}"
        now = self._now_iso()
        job_payload: dict[str, object] = {
            "job_id": job_id,
            "website_id": website_id,
            "status": "queued",
            "scheduled_at": now,
            "started_at": None,
            "finished_at": None,
            "pages_discovered": 0,
            "pages_crawled": 0,
            "pages_failed": 0,
            "indexed_page_count": website_state["indexed_page_count"],
            "indexed_chunk_count": website_state["indexed_chunk_count"],
            "error_message": None,
        }
        self._rag_repository.save_state_record(
            f"crawl-job:{job_id}",
            payload=job_payload,
            metadata={
                "record_type": "crawl_job",
                "website_id": website_id,
                "job_id": job_id,
                "status": "queued",
                "scheduled_at": now,
            },
        )

        website_state.update(
            {
                "crawl_status": "queued",
                "latest_crawl_job_id": job_id,
                "last_error": "",
            }
        )
        self._save_website_state(website_state)

        try:
            self._execute_crawl_job(
                website_id=website_id,
                website_url=details.website_url,
                allowed_domains=details.allowed_domains,
                crawl_depth=details.crawl_depth or 1,
                job_payload=job_payload,
            )
        except Exception as error:
            failed_job = {
                **job_payload,
                "status": "failed",
                "finished_at": self._now_iso(),
                "error_message": str(error),
            }
            self._save_crawl_job(failed_job)
            failed_state = self._merge_website_state(
                website_id,
                rag_document_count=len(self._rag_repository.list_documents(website_id, limit=1000)),
            )
            failed_state.update(
                {
                    "crawl_status": "failed",
                    "latest_crawl_job_id": job_id,
                    "last_error": str(error),
                }
            )
            self._save_website_state(failed_state)
            return CrawlJobCreateResponse(
                status="queued",
                website_id=website_id,
                job=self._crawl_job_model_from_state(failed_job),
            )

        return CrawlJobCreateResponse(
            status="queued",
            website_id=website_id,
            job=self._crawl_job_model_from_state(
                self._rag_repository.get_state_record(f"crawl-job:{job_id}") or job_payload
            ),
        )

    def list_crawl_jobs(
        self,
        website_id: str,
        limit: int = 20,
    ) -> CrawlJobListResponse:
        return CrawlJobListResponse(
            status="listed",
            website_id=website_id,
            jobs=self._list_crawl_job_models(website_id, limit=limit),
        )
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
        self._save_website_state(
            self._merge_website_state(
                request.website_id,
                rag_document_count=rag_binding.document_count,
            )
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
        self._save_website_state(
            self._merge_website_state(
                website_id,
                rag_document_count=updated_binding.document_count,
            )
        )
        return WebsiteDocumentDeleteResponse(
            status="deleted",
            website_id=website_id,
            rag_collection=rag_binding.collection_name,
            rag_status=updated_binding.status,
            deleted_count=deleted_count,
            total_document_count=updated_binding.document_count,
        )

    def _merge_website_state(
        self,
        website_id: str,
        rag_document_count: int,
        state: dict[str, object] | None = None,
    ) -> dict[str, object]:
        persisted_state = state or self._rag_repository.get_state_record(f"website-state:{website_id}") or {}
        return {
            "website_id": website_id,
            "crawl_status": self._coerce_status(
                persisted_state.get("crawl_status"),
                default="not_started",
            ),
            "crawl_schedule": self._as_optional_string(persisted_state.get("crawl_schedule"))
            or "daily",
            "indexed_page_count": self._as_non_negative_int(
                persisted_state.get("indexed_page_count")
            ),
            "indexed_chunk_count": self._as_non_negative_int(
                persisted_state.get("indexed_chunk_count"),
                default=rag_document_count,
            ),
            "last_crawled_at": self._as_optional_string(persisted_state.get("last_crawled_at")),
            "last_error": self._as_optional_string(persisted_state.get("last_error")),
            "latest_crawl_job_id": self._as_optional_string(
                persisted_state.get("latest_crawl_job_id")
            ),
        }

    def _save_website_state(self, state: dict[str, object]) -> None:
        website_id = self._as_optional_string(state.get("website_id"))
        if not website_id:
            raise ValueError("Website state requires a website_id.")

        self._rag_repository.save_state_record(
            f"website-state:{website_id}",
            payload=state,
            metadata={
                "record_type": "website_state",
                "website_id": website_id,
                "crawl_status": self._coerce_status(state.get("crawl_status"), default="not_started"),
            },
        )

    def _save_crawl_job(self, payload: dict[str, object]) -> None:
        job_id = self._as_optional_string(payload.get("job_id"))
        website_id = self._as_optional_string(payload.get("website_id"))
        if not job_id or not website_id:
            raise ValueError("Crawl job requires both job_id and website_id.")

        self._rag_repository.save_state_record(
            f"crawl-job:{job_id}",
            payload=payload,
            metadata={
                "record_type": "crawl_job",
                "website_id": website_id,
                "job_id": job_id,
                "status": self._coerce_job_status(payload.get("status"), default="queued"),
                "scheduled_at": self._as_optional_string(payload.get("scheduled_at")) or self._now_iso(),
            },
        )

    def _execute_crawl_job(
        self,
        website_id: str,
        website_url: str,
        allowed_domains: list[str],
        crawl_depth: int,
        job_payload: dict[str, object],
    ) -> None:
        running_job = {
            **job_payload,
            "status": "running",
            "started_at": self._now_iso(),
            "error_message": None,
        }
        self._save_crawl_job(running_job)

        running_state = self._merge_website_state(
            website_id,
            rag_document_count=len(self._rag_repository.list_documents(website_id, limit=1000)),
        )
        running_state.update(
            {
                "crawl_status": "running",
                "latest_crawl_job_id": self._as_optional_string(job_payload.get("job_id")),
                "last_error": "",
            }
        )
        self._save_website_state(running_state)

        result = self._crawler.crawl(
            start_url=website_url,
            allowed_domains=allowed_domains,
            max_depth=crawl_depth,
        )

        crawl_prefix = "crawl:"
        existing_crawl_ids = [
            document.id
            for document in self._rag_repository.list_documents(website_id, limit=1000)
            if document.id.startswith(crawl_prefix)
        ]
        if existing_crawl_ids:
            self._rag_repository.delete_documents(website_id, existing_crawl_ids)

        if result.chunks:
            self._rag_repository.upsert_documents(
                website_id,
                documents=[
                    RAGDocumentRecord(
                        id=chunk.chunk_id,
                        document=chunk.text,
                        metadata={
                            "source": "crawl",
                            "page_url": chunk.page_url,
                            "page_title": chunk.page_title,
                            "depth": str(chunk.depth),
                            "chunk_index": str(chunk.chunk_index),
                            "chunk_count": str(chunk.chunk_count),
                            "content_hash": chunk.content_hash,
                        },
                    )
                    for chunk in result.chunks
                ],
            )

        if not result.pages or not result.chunks:
            raise ValueError(
                "Crawl completed without extracting any indexable website content. "
                "The target site may rely on JavaScript rendering, block basic crawling, "
                "or return markup that does not contain enough readable text for ingestion."
            )

        finished_at = self._now_iso()
        completed_job = {
            **running_job,
            "status": "completed",
            "finished_at": finished_at,
            "pages_discovered": result.pages_discovered,
            "pages_crawled": result.pages_crawled,
            "pages_failed": result.pages_failed,
            "indexed_page_count": len(result.pages),
            "indexed_chunk_count": len(result.chunks),
            "error_message": None,
        }
        self._save_crawl_job(completed_job)

        completed_state = self._merge_website_state(
            website_id,
            rag_document_count=len(self._rag_repository.list_documents(website_id, limit=1000)),
        )
        completed_state.update(
            {
                "crawl_status": "completed",
                "indexed_page_count": len(result.pages),
                "indexed_chunk_count": len(result.chunks),
                "last_crawled_at": finished_at,
                "last_error": "",
                "latest_crawl_job_id": self._as_optional_string(job_payload.get("job_id")),
            }
        )
        self._save_website_state(completed_state)

    def build_retrieval_matches(
        self,
        website_id: str,
        query: str,
        limit: int = 4,
    ) -> list[RetrievedSnippet]:
        return self._load_retrieval_matches(website_id=website_id, query=query, limit=limit)

    def build_background_matches(
        self,
        website_id: str,
        limit: int = 3,
    ) -> list[RetrievedSnippet]:
        documents = self._rag_repository.list_documents(website_id, limit=limit)
        return [self._snippet_from_record(document) for document in documents]

    def build_citations(self, matches: list[RetrievedSnippet]) -> list[CitationRecord]:
        return self._build_citations(matches)

    def _list_crawl_job_models(
        self,
        website_id: str,
        limit: int,
    ) -> list[CrawlJobResponse]:
        jobs = [
            self._crawl_job_model_from_state(job_state)
            for job_state in self._rag_repository.list_state_records(
                "crawl_job",
                website_id=website_id,
                limit=1000,
            )
            if self._as_optional_string(job_state.get("job_id"))
        ]
        jobs.sort(key=lambda item: item.scheduled_at, reverse=True)
        return jobs[:limit]

    def _crawl_job_model_from_state(self, payload: dict[str, object]) -> CrawlJobResponse:
        return CrawlJobResponse(
            job_id=self._as_optional_string(payload.get("job_id")) or "",
            website_id=self._as_optional_string(payload.get("website_id")) or "",
            status=self._coerce_job_status(payload.get("status"), default="queued"),
            scheduled_at=self._parse_datetime(payload.get("scheduled_at")) or datetime.now(timezone.utc),
            started_at=self._parse_datetime(payload.get("started_at")),
            finished_at=self._parse_datetime(payload.get("finished_at")),
            pages_discovered=self._as_non_negative_int(payload.get("pages_discovered")),
            pages_crawled=self._as_non_negative_int(payload.get("pages_crawled")),
            pages_failed=self._as_non_negative_int(payload.get("pages_failed")),
            indexed_page_count=self._as_non_negative_int(payload.get("indexed_page_count")),
            indexed_chunk_count=self._as_non_negative_int(payload.get("indexed_chunk_count")),
            error_message=self._as_optional_string(payload.get("error_message")),
        )

    def _load_retrieval_matches(
        self,
        website_id: str,
        query: str,
        limit: int,
    ) -> list[RetrievedSnippet]:
        if not query.strip():
            return []
        _, matches = self._rag_repository.query_documents(website_id, query, limit)
        return [self._snippet_from_record(match) for match in matches]

    @staticmethod
    def _snippet_from_record(record: RAGDocumentRecord) -> RetrievedSnippet:
        return RetrievedSnippet(
            id=record.id,
            document=record.document,
            source=record.metadata.get("source"),
            page_url=record.metadata.get("page_url"),
            page_title=record.metadata.get("page_title"),
        )

    @classmethod
    def _build_citations(cls, matches: list[RetrievedSnippet]) -> list[CitationRecord]:
        return [
            CitationRecord(
                label=cls._citation_label(index),
                document_id=match.id,
                source=match.source,
                page_title=match.page_title,
                page_url=match.page_url,
                excerpt=cls._truncate(match.document),
            )
            for index, match in enumerate(matches, start=1)
        ]

    @staticmethod
    def _citation_label(index: int) -> str:
        return f"[{index}]"

    @staticmethod
    def _truncate(value: str, limit: int = 280) -> str:
        compact = " ".join(value.split())
        if len(compact) <= limit:
            return compact
        return f"{compact[: limit - 3]}..."

    @staticmethod
    def _coerce_status(value: object, default: str) -> str:
        allowed = {"not_started", "queued", "running", "completed", "failed"}
        return value if isinstance(value, str) and value in allowed else default

    @staticmethod
    def _coerce_job_status(value: object, default: str) -> str:
        allowed = {"queued", "running", "completed", "failed", "cancelled"}
        return value if isinstance(value, str) and value in allowed else default

    @staticmethod
    def _as_non_negative_int(value: object, default: int = 0) -> int:
        if isinstance(value, bool):
            return default
        if isinstance(value, int):
            return max(value, 0)
        if isinstance(value, str) and value.isdigit():
            return int(value)
        return default

    @staticmethod
    def _as_optional_string(value: object) -> str | None:
        if not isinstance(value, str):
            return None
        stripped = value.strip()
        return stripped or None

    @staticmethod
    def _parse_datetime(value: object) -> datetime | None:
        if not isinstance(value, str) or not value.strip():
            return None
        normalized = value.replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(normalized)
        except ValueError:
            return None

    @staticmethod
    def _now_iso() -> str:
        return datetime.now(timezone.utc).isoformat()

    @staticmethod
    def _build_website_id(display_name: str, website_url: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", display_name.lower()).strip("-")
        slug = re.sub(r"-{2,}", "-", slug)
        if not slug:
            slug = "website"

        suffix = hashlib.sha1(website_url.encode("utf-8")).hexdigest()[:6]
        return f"{slug}-{suffix}"
