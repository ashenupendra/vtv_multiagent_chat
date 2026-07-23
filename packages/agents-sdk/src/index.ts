export type LoginResponse = {
  status: string;
  access_token: string;
  token_type: string;
  username: string;
  expires_in: number;
};

export type SessionResponse = {
  status: string;
  username: string;
};

export type LiveConfigResponse = {
  status: "available" | "unavailable";
  websocket_path: string;
  default_model: string;
  api_mode: "backend_proxy";
  input_audio_mime_type: string;
  output_mode: "text";
  reason?: string | null;
};

export type WebsiteOnboardingPayload = {
  website_url: string;
  display_name: string;
  allowed_domains: string[];
  crawl_depth: number;
  prompt_override?: string | null;
};

export type WebsiteOnboardingResponse = {
  status: string;
  website_id: string;
  rag_collection: string;
  rag_status: string;
  rag_endpoint: string;
  rag_document_count: number;
  crawl_status: "not_started" | "queued" | "running" | "completed" | "failed";
  crawl_schedule: string;
  indexed_page_count: number;
  indexed_chunk_count: number;
  last_crawled_at: string | null;
  last_error: string | null;
  latest_crawl_job_id: string | null;
  recommended_text_model: string;
  recommended_live_model: string;
};

export type WebsiteDetailsResponse = {
  status: "loaded";
  website_id: string;
  display_name: string | null;
  website_url: string | null;
  allowed_domains: string[];
  crawl_depth: number | null;
  prompt_override: string | null;
  rag_collection: string;
  rag_status: string;
  rag_endpoint: string;
  rag_document_count: number;
  crawl_status: "not_started" | "queued" | "running" | "completed" | "failed";
  crawl_schedule: string;
  indexed_page_count: number;
  indexed_chunk_count: number;
  last_crawled_at: string | null;
  last_error: string | null;
  latest_crawl_job_id: string | null;
  recommended_text_model: string;
  recommended_live_model: string;
};

export type WebsiteSummaryResponse = {
  website_id: string;
  display_name: string | null;
  website_url: string | null;
  allowed_domains: string[];
  crawl_depth: number | null;
  rag_collection: string;
  rag_status: string;
  crawl_status: "not_started" | "queued" | "running" | "completed" | "failed";
  indexed_page_count: number;
  indexed_chunk_count: number;
  latest_crawl_job_id: string | null;
};

export type WebsiteListResponse = {
  status: "listed";
  websites: WebsiteSummaryResponse[];
};

export type CrawlJobResponse = {
  job_id: string;
  website_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  scheduled_at: string;
  started_at: string | null;
  finished_at: string | null;
  pages_discovered: number;
  pages_crawled: number;
  pages_failed: number;
  indexed_page_count: number;
  indexed_chunk_count: number;
  error_message: string | null;
};

export type WebsiteCrawlStatusResponse = {
  status: "loaded";
  website_id: string;
  crawl_status: "not_started" | "queued" | "running" | "completed" | "failed";
  crawl_schedule: string;
  indexed_page_count: number;
  indexed_chunk_count: number;
  last_crawled_at: string | null;
  last_error: string | null;
  latest_crawl_job_id: string | null;
  jobs: CrawlJobResponse[];
};

export type CrawlJobListResponse = {
  status: "listed";
  website_id: string;
  jobs: CrawlJobResponse[];
};

export type CrawlJobCreateResponse = {
  status: "queued";
  website_id: string;
  job: CrawlJobResponse;
};

export type WebsiteDocumentRecord = {
  id: string;
  document: string;
  metadata: Record<string, string>;
};

export type CitationRecord = {
  label: string;
  document_id: string;
  source?: string | null;
  page_title?: string | null;
  page_url?: string | null;
  excerpt: string;
};

export type GroundingHistoryEntryResponse = {
  type: "grounding";
  source: string;
  query: string;
  turn_id: string;
  recorded_at: string;
  website_id: string;
  session_id: string;
  matches: WebsiteDocumentRecord[];
  citations: CitationRecord[];
};

export type GroundingHistoryResponse = {
  status: "loaded";
  website_id: string;
  session_id: string | null;
  entries: GroundingHistoryEntryResponse[];
};

export type WebsiteDocumentsUpsertPayload = {
  website_id: string;
  documents: WebsiteDocumentRecord[];
};

export type WebsiteDocumentsUpsertResponse = {
  status: string;
  website_id: string;
  rag_collection: string;
  rag_status: string;
  upserted_count: number;
  total_document_count: number;
};

export type WebsiteDocumentQueryPayload = {
  website_id: string;
  query: string;
  limit?: number;
};

export type WebsiteDocumentQueryResponse = {
  status: string;
  website_id: string;
  rag_collection: string;
  rag_status: string;
  matches: WebsiteDocumentRecord[];
};

export type WebsiteDocumentListResponse = {
  status: string;
  website_id: string;
  rag_collection: string;
  rag_status: string;
  documents: WebsiteDocumentRecord[];
};

export type WebsiteDocumentDeleteResponse = {
  status: string;
  website_id: string;
  rag_collection: string;
  rag_status: string;
  deleted_count: number;
  total_document_count: number;
};

export type RouteConversationPayload = {
  mode: "text" | "voice";
  website_id: string;
  session_id: string;
  message: string;
  history: Array<{
    role: "user" | "assistant" | "system";
    content: string;
  }>;
  language_hint?: string;
};

export type RouteConversationResponse = {
  status: string;
  route: {
    agent: "text_chat" | "voice_processing";
    default_model: string;
    website_id: string;
    rag_collection: string;
    rag_status?: string | null;
    system_prompt?: string | null;
    router_prompt?: string | null;
    grounding_prompt?: string | null;
    website_prompt?: string | null;
    website_prompt_override_applied?: boolean;
    retrieval_matches?: WebsiteDocumentRecord[];
    citations?: CitationRecord[];
  };
  fallback_message: string;
  observability_trace_id: string;
};

type ClientOptions = {
  baseUrl?: string;
  token?: string | null;
};

async function request<T>(
  path: string,
  init: RequestInit,
  options: ClientOptions,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(`${options.baseUrl ?? "http://localhost:8000"}${path}`, {
    ...init,
    headers,
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: string };
      if (body.detail) {
        message = body.detail;
      }
    } catch {
      // Keep the default error message when the response body is not JSON.
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export function createIraApiClient(options: ClientOptions = {}) {
  return {
    login(username: string, password: string) {
      return request<LoginResponse>(
        "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username, password }),
        },
        options,
      );
    },
    getSession() {
      return request<SessionResponse>(
        "/api/auth/session",
        {
          method: "GET",
        },
        options,
      );
    },
    getLiveConfig(model?: string) {
      const suffix = model ? `?model=${encodeURIComponent(model)}` : "";
      return request<LiveConfigResponse>(
        `/api/live/config${suffix}`,
        {
          method: "GET",
        },
        options,
      );
    },
    getGroundingHistory(websiteId: string, sessionId?: string, limit = 20) {
      const query = new URLSearchParams({
        website_id: websiteId,
        limit: String(limit),
      });
      if (sessionId) {
        query.set("session_id", sessionId);
      }
      return request<GroundingHistoryResponse>(
        `/api/live/grounding-history?${query.toString()}`,
        {
          method: "GET",
        },
        options,
      );
    },
    provisionWebsite(payload: WebsiteOnboardingPayload) {
      return request<WebsiteOnboardingResponse>(
        "/api/orchestration/websites",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        options,
      );
    },
    listWebsites() {
      return request<WebsiteListResponse>(
        "/api/orchestration/websites",
        {
          method: "GET",
        },
        options,
      );
    },
    listPublicWebsites() {
      return request<WebsiteListResponse>(
        "/api/orchestration/websites/public",
        {
          method: "GET",
        },
        options,
      );
    },
    getWebsiteDetails(websiteId: string) {
      return request<WebsiteDetailsResponse>(
        `/api/orchestration/websites/${encodeURIComponent(websiteId)}`,
        {
          method: "GET",
        },
        options,
      );
    },
    getWebsiteCrawlStatus(websiteId: string, limit = 10) {
      const query = new URLSearchParams({
        limit: String(limit),
      });
      return request<WebsiteCrawlStatusResponse>(
        `/api/orchestration/websites/${encodeURIComponent(websiteId)}/crawl-status?${query.toString()}`,
        {
          method: "GET",
        },
        options,
      );
    },
    queueWebsiteCrawlJob(websiteId: string) {
      return request<CrawlJobCreateResponse>(
        `/api/orchestration/websites/${encodeURIComponent(websiteId)}/crawl-jobs`,
        {
          method: "POST",
        },
        options,
      );
    },
    listWebsiteCrawlJobs(websiteId: string, limit = 20) {
      const query = new URLSearchParams({
        limit: String(limit),
      });
      return request<CrawlJobListResponse>(
        `/api/orchestration/websites/${encodeURIComponent(websiteId)}/crawl-jobs?${query.toString()}`,
        {
          method: "GET",
        },
        options,
      );
    },
    upsertWebsiteDocuments(payload: WebsiteDocumentsUpsertPayload) {
      return request<WebsiteDocumentsUpsertResponse>(
        "/api/orchestration/documents",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        options,
      );
    },
    queryWebsiteDocuments(payload: WebsiteDocumentQueryPayload) {
      return request<WebsiteDocumentQueryResponse>(
        "/api/orchestration/documents/query",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        options,
      );
    },
    listWebsiteDocuments(websiteId: string, limit = 20) {
      const query = new URLSearchParams({
        website_id: websiteId,
        limit: String(limit),
      });
      return request<WebsiteDocumentListResponse>(
        `/api/orchestration/documents?${query.toString()}`,
        {
          method: "GET",
        },
        options,
      );
    },
    deleteWebsiteDocument(websiteId: string, documentId: string) {
      const query = new URLSearchParams({
        website_id: websiteId,
      });
      return request<WebsiteDocumentDeleteResponse>(
        `/api/orchestration/documents/${encodeURIComponent(documentId)}?${query.toString()}`,
        {
          method: "DELETE",
        },
        options,
      );
    },
    routeConversation(payload: RouteConversationPayload) {
      return request<RouteConversationResponse>(
        "/api/orchestration/route",
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
        options,
      );
    },
  };
}
