from dataclasses import dataclass, field
import hashlib
import math

import httpx

from app.core.config import Settings


@dataclass(frozen=True)
class RAGCollectionBinding:
    website_id: str
    collection_name: str
    endpoint: str
    status: str
    document_count: int
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RAGDocumentRecord:
    id: str
    document: str
    metadata: dict[str, str] = field(default_factory=dict)


class ChromaRepository:
    _stub_collections: dict[str, dict[str, str]] = {}
    _stub_documents: dict[str, list[RAGDocumentRecord]] = {}

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    @property
    def endpoint(self) -> str:
        protocol = "https" if self._settings.rag.use_ssl else "http"
        return f"{protocol}://{self._settings.rag.host}:{self._settings.rag.port}"

    def collection_for_website(self, website_id: str) -> RAGCollectionBinding:
        collection_name = f"{self._settings.rag.collection_prefix}-{website_id}"
        try:
            collection = self._find_collection(collection_name)
            if collection is None:
                return RAGCollectionBinding(
                    website_id=website_id,
                    collection_name=collection_name,
                    endpoint=self.endpoint,
                    status="missing",
                    document_count=0,
                )

            return RAGCollectionBinding(
                website_id=website_id,
                collection_name=collection_name,
                endpoint=self.endpoint,
                status="connected",
                document_count=0,
                metadata=self._stringify_metadata(collection.get("metadata")),
            )
        except Exception:
            if not self._settings.rag.allow_stub_fallback:
                raise

            metadata = self._stub_collections.setdefault(collection_name, {})
            return RAGCollectionBinding(
                website_id=website_id,
                collection_name=collection_name,
                endpoint=self.endpoint,
                status="offline_stub",
                document_count=0,
                metadata=metadata,
            )

    def ensure_collection(
        self,
        website_id: str,
        metadata: dict[str, str],
    ) -> RAGCollectionBinding:
        collection_name = f"{self._settings.rag.collection_prefix}-{website_id}"
        try:
            collection = self._find_collection(collection_name)
            if collection is None:
                collection = self._create_collection(collection_name, metadata)

            return RAGCollectionBinding(
                website_id=website_id,
                collection_name=collection_name,
                endpoint=self.endpoint,
                status="connected",
                document_count=0,
                metadata=self._stringify_metadata(collection.get("metadata")),
            )
        except Exception:
            if not self._settings.rag.allow_stub_fallback:
                raise

            self._stub_collections[collection_name] = metadata
            self._stub_documents.setdefault(collection_name, [])
            return RAGCollectionBinding(
                website_id=website_id,
                collection_name=collection_name,
                endpoint=self.endpoint,
                status="offline_stub",
                document_count=0,
                metadata=metadata,
            )

    def upsert_documents(
        self,
        website_id: str,
        documents: list[RAGDocumentRecord],
    ) -> RAGCollectionBinding:
        collection_binding = self.ensure_collection(website_id, metadata={})
        if collection_binding.status == "offline_stub":
            stub_documents = self._stub_documents.setdefault(collection_binding.collection_name, [])
            by_id = {document.id: document for document in stub_documents}
            for document in documents:
                by_id[document.id] = document
            self._stub_documents[collection_binding.collection_name] = list(by_id.values())
            return RAGCollectionBinding(
                website_id=website_id,
                collection_name=collection_binding.collection_name,
                endpoint=collection_binding.endpoint,
                status=collection_binding.status,
                document_count=len(self._stub_documents[collection_binding.collection_name]),
                metadata=collection_binding.metadata,
            )

        collection = self._find_collection(collection_binding.collection_name)
        if collection is None:
            raise ValueError("Collection missing during document upsert.")

        embeddings = self._embed_texts(
            [self._prepare_document_text(document.document) for document in documents]
        )

        self._request(
            "POST",
            self._records_path(str(collection["id"]), "upsert"),
            json={
                "ids": [document.id for document in documents],
                "embeddings": embeddings,
                "documents": [document.document for document in documents],
                "metadatas": [document.metadata for document in documents],
            },
        )

        current_documents = self.list_documents(website_id, limit=1000)
        return RAGCollectionBinding(
            website_id=website_id,
            collection_name=collection_binding.collection_name,
            endpoint=collection_binding.endpoint,
            status="connected",
            document_count=len(current_documents),
            metadata=collection_binding.metadata,
        )

    def list_documents(self, website_id: str, limit: int = 20) -> list[RAGDocumentRecord]:
        collection_binding = self.collection_for_website(website_id)
        if collection_binding.status == "offline_stub":
            return self._stub_documents.get(collection_binding.collection_name, [])[:limit]

        collection = self._find_collection(collection_binding.collection_name)
        if collection is None:
            return []

        response = self._request(
            "POST",
            self._records_path(str(collection["id"]), "get"),
            json={
                "limit": limit,
                "offset": 0,
                "include": ["documents", "metadatas"],
            },
        )
        payload = response.json()
        return self._records_from_get_payload(payload)

    def delete_documents(self, website_id: str, ids: list[str]) -> RAGCollectionBinding:
        collection_binding = self.ensure_collection(website_id, metadata={})
        if collection_binding.status == "offline_stub":
            existing_documents = self._stub_documents.get(collection_binding.collection_name, [])
            delete_ids = set(ids)
            self._stub_documents[collection_binding.collection_name] = [
                document for document in existing_documents if document.id not in delete_ids
            ]
            return RAGCollectionBinding(
                website_id=website_id,
                collection_name=collection_binding.collection_name,
                endpoint=collection_binding.endpoint,
                status=collection_binding.status,
                document_count=len(self._stub_documents[collection_binding.collection_name]),
                metadata=collection_binding.metadata,
            )

        collection = self._find_collection(collection_binding.collection_name)
        if collection is None:
            raise ValueError("Collection missing during document delete.")

        self._request(
            "POST",
            self._records_path(str(collection["id"]), "delete"),
            json={"ids": ids},
        )

        current_documents = self.list_documents(website_id, limit=1000)
        return RAGCollectionBinding(
            website_id=website_id,
            collection_name=collection_binding.collection_name,
            endpoint=collection_binding.endpoint,
            status="connected",
            document_count=len(current_documents),
            metadata=collection_binding.metadata,
        )

    def query_documents(
        self,
        website_id: str,
        query: str,
        limit: int = 5,
    ) -> tuple[RAGCollectionBinding, list[RAGDocumentRecord]]:
        collection_binding = self.collection_for_website(website_id)
        if collection_binding.status == "offline_stub":
            matches = self._rank_documents(
                self._stub_documents.get(collection_binding.collection_name, []),
                query,
                limit,
            )
            return collection_binding, matches

        collection = self._find_collection(collection_binding.collection_name)
        if collection is None:
            return collection_binding, []

        query_embedding = self._embed_text(self._prepare_query_text(query))
        response = self._request(
            "POST",
            self._records_path(str(collection["id"]), "query"),
            json={
                "query_embeddings": [query_embedding],
                "n_results": limit,
                "include": ["documents", "metadatas", "distances"],
            },
        )
        payload = response.json()
        return collection_binding, self._records_from_query_payload(payload)

    def _find_collection(self, collection_name: str) -> dict[str, object] | None:
        response = self._request("GET", self._collections_path())
        collections = response.json()
        if not isinstance(collections, list):
            raise ValueError("Unexpected collection list response from Chroma.")

        for collection in collections:
            if isinstance(collection, dict) and collection.get("name") == collection_name:
                return collection
        return None

    def _create_collection(
        self,
        collection_name: str,
        metadata: dict[str, str],
    ) -> dict[str, object]:
        response = self._request(
            "POST",
            self._collections_path(),
            json={"name": collection_name, "metadata": metadata},
        )
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Unexpected collection create response from Chroma.")
        return payload

    def _collections_path(self) -> str:
        return (
            f"/api/v2/tenants/{self._settings.rag.tenant}"
            f"/databases/{self._settings.rag.database}/collections"
        )

    def _records_path(self, collection_id: str, operation: str) -> str:
        return f"{self._collections_path()}/{collection_id}/{operation}"

    def _request(self, method: str, path: str, **kwargs: object) -> httpx.Response:
        with httpx.Client(base_url=self.endpoint, timeout=5.0) as client:
            response = client.request(method, path, **kwargs)
            response.raise_for_status()
            return response

    @staticmethod
    def _stringify_metadata(metadata: object) -> dict[str, str]:
        if not isinstance(metadata, dict):
            return {}
        return {str(key): str(value) for key, value in metadata.items()}

    @classmethod
    def _records_from_get_payload(cls, payload: object) -> list[RAGDocumentRecord]:
        if not isinstance(payload, dict):
            return []

        ids = payload.get("ids") if isinstance(payload.get("ids"), list) else []
        documents = (
            payload.get("documents") if isinstance(payload.get("documents"), list) else []
        )
        metadatas = (
            payload.get("metadatas") if isinstance(payload.get("metadatas"), list) else []
        )

        records: list[RAGDocumentRecord] = []
        for index, record_id in enumerate(ids):
            if not isinstance(record_id, str):
                continue
            document = documents[index] if index < len(documents) else ""
            metadata = metadatas[index] if index < len(metadatas) else {}
            records.append(
                RAGDocumentRecord(
                    id=record_id,
                    document=document if isinstance(document, str) else "",
                    metadata=cls._stringify_metadata(metadata),
                )
            )
        return records

    @staticmethod
    def _rank_documents(
        documents: list[RAGDocumentRecord],
        query: str,
        limit: int,
    ) -> list[RAGDocumentRecord]:
        query_terms = [term for term in query.lower().split() if term]

        def score(document: RAGDocumentRecord) -> tuple[int, int]:
            haystack = f"{document.id} {document.document} {' '.join(document.metadata.values())}".lower()
            term_hits = sum(haystack.count(term) for term in query_terms)
            return (term_hits, len(document.document))

        ranked = sorted(
            (document for document in documents if score(document)[0] > 0),
            key=score,
            reverse=True,
        )
        return ranked[:limit]

    def _embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_text(text) for text in texts]

    def _embed_text(self, text: str) -> list[float]:
        if not self._settings.google_runtime.api_key_configured:
            return self._stub_embedding(text, self._settings.google_runtime.embedding_dimensions)

        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self._settings.google_runtime.embedding_model}:embedContent"
        )
        response = httpx.post(
            url,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": self._settings.google_api_key,
            },
            json={
                "model": f"models/{self._settings.google_runtime.embedding_model}",
                "content": {"parts": [{"text": text}]},
                "output_dimensionality": self._settings.google_runtime.embedding_dimensions,
            },
            timeout=15.0,
        )
        response.raise_for_status()
        payload = response.json()

        embedding = payload.get("embedding") if isinstance(payload, dict) else None
        if isinstance(embedding, dict) and isinstance(embedding.get("values"), list):
            return [float(value) for value in embedding["values"]]

        embeddings = payload.get("embeddings") if isinstance(payload, dict) else None
        if (
            isinstance(embeddings, list)
            and embeddings
            and isinstance(embeddings[0], dict)
            and isinstance(embeddings[0].get("values"), list)
        ):
            return [float(value) for value in embeddings[0]["values"]]

        raise ValueError("Unexpected embedding response from Google embedContent.")

    @staticmethod
    def _stub_embedding(text: str, dimensions: int) -> list[float]:
        if dimensions <= 0:
            raise ValueError("Embedding dimensions must be positive.")

        values: list[float] = []
        cursor = 0
        while len(values) < dimensions:
            digest = hashlib.sha256(f"{text}:{cursor}".encode("utf-8")).digest()
            for byte in digest:
                values.append((byte / 127.5) - 1.0)
                if len(values) >= dimensions:
                    break
            cursor += 1

        norm = math.sqrt(sum(value * value for value in values))
        if norm == 0:
            return values
        return [value / norm for value in values]

    @staticmethod
    def _prepare_document_text(document: str) -> str:
        return f"title: none | text: {document}"

    @staticmethod
    def _prepare_query_text(query: str) -> str:
        return f"task: search result | query: {query}"

    @classmethod
    def _records_from_query_payload(cls, payload: object) -> list[RAGDocumentRecord]:
        if not isinstance(payload, dict):
            return []

        ids = payload.get("ids")
        documents = payload.get("documents")
        metadatas = payload.get("metadatas")

        if not (
            isinstance(ids, list)
            and ids
            and isinstance(ids[0], list)
            and isinstance(documents, list)
            and documents
            and isinstance(documents[0], list)
        ):
            return []

        first_ids = ids[0]
        first_documents = documents[0] if isinstance(documents[0], list) else []
        first_metadatas = metadatas[0] if isinstance(metadatas, list) and metadatas else []

        records: list[RAGDocumentRecord] = []
        for index, record_id in enumerate(first_ids):
            if not isinstance(record_id, str):
                continue
            document = (
                first_documents[index] if index < len(first_documents) else ""
            )
            metadata = first_metadatas[index] if index < len(first_metadatas) else {}
            records.append(
                RAGDocumentRecord(
                    id=record_id,
                    document=document if isinstance(document, str) else "",
                    metadata=cls._stringify_metadata(metadata),
                )
            )
        return records
