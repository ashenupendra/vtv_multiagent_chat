import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  type CrawlJobCreateResponse,
  createIraApiClient,
  type RouteConversationResponse,
  type WebsiteCrawlStatusResponse,
  type WebsiteDocumentDeleteResponse,
  type WebsiteDetailsResponse,
  type WebsiteDocumentListResponse,
  type WebsiteDocumentQueryResponse,
  type WebsiteDocumentsUpsertResponse,
  type WebsiteListResponse,
  type WebsiteOnboardingResponse,
} from "@ira/agents-sdk";
import {
  AppShell,
  ErrorBanner,
  Field,
  Panel,
  PlaceholderCopy,
  PrimaryButton,
  ResultCard,
  SummaryBlock,
  TextArea,
  TextInput,
} from "@ira/ui";

const sessionStorageKey = "ira-admin-token";

const defaultPayload = {
  websiteUrl: "https://example.com",
  displayName: "Example Site",
  allowedDomains: "example.com",
  crawlDepth: 2,
  promptOverride: "",
};

const defaultAuthForm = {
  username: "admin",
  password: "change-me",
};

const defaultDocumentForm = {
  id: "home-page",
  document:
    "IRA helps website visitors discover services, pricing, onboarding guidance, and support options.",
  source: "seed",
};

const defaultRouteForm = {
  mode: "text",
  message: "How can IRA help with onboarding and pricing questions?",
};

export default function App() {
  const [authForm, setAuthForm] = useState(defaultAuthForm);
  const [form, setForm] = useState(defaultPayload);
  const [documentForm, setDocumentForm] = useState(defaultDocumentForm);
  const [routeForm, setRouteForm] = useState(defaultRouteForm);
  const [queryText, setQueryText] = useState("support pricing");
  const [activeWebsiteId, setActiveWebsiteId] = useState("");
  const [authLoading, setAuthLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [documentListLoading, setDocumentListLoading] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [queryLoading, setQueryLoading] = useState(false);
  const [crawlActionLoading, setCrawlActionLoading] = useState(false);
  const [sessionChecking, setSessionChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [result, setResult] = useState<WebsiteOnboardingResponse | null>(null);
  const [documentsResult, setDocumentsResult] = useState<WebsiteDocumentsUpsertResponse | null>(
    null,
  );
  const [documentListResult, setDocumentListResult] = useState<WebsiteDocumentListResponse | null>(
    null,
  );
  const [deleteResult, setDeleteResult] = useState<WebsiteDocumentDeleteResponse | null>(null);
  const [queryResult, setQueryResult] = useState<WebsiteDocumentQueryResponse | null>(null);
  const [routeResult, setRouteResult] = useState<RouteConversationResponse | null>(null);
  const [websiteDetails, setWebsiteDetails] = useState<WebsiteDetailsResponse | null>(null);
  const [crawlStatus, setCrawlStatus] = useState<WebsiteCrawlStatusResponse | null>(null);
  const [latestCrawlJob, setLatestCrawlJob] = useState<CrawlJobCreateResponse | null>(null);
  const [websiteList, setWebsiteList] = useState<WebsiteListResponse["websites"]>([]);
  const [websiteListLoading, setWebsiteListLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [sessionUsername, setSessionUsername] = useState<string | null>(null);

  const apiBaseUrl = import.meta.env.VITE_IRA_API_BASE_URL as string | undefined;
  const publicClient = createIraApiClient({ baseUrl: apiBaseUrl });
  const authenticatedClient = useMemo(
    () => createIraApiClient({ baseUrl: apiBaseUrl, token }),
    [apiBaseUrl, token],
  );

  const recommendedDomains = useMemo(
    () =>
      form.allowedDomains
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    [form.allowedDomains],
  );
  const resolvedWebsiteId = activeWebsiteId || result?.website_id || "";

  function applyWebsiteDetails(details: WebsiteDetailsResponse) {
    setWebsiteDetails(details);
    setActiveWebsiteId(details.website_id);
    setForm({
      websiteUrl: details.website_url ?? defaultPayload.websiteUrl,
      displayName: details.display_name ?? defaultPayload.displayName,
      allowedDomains:
        details.allowed_domains.length > 0
          ? details.allowed_domains.join(", ")
          : defaultPayload.allowedDomains,
      crawlDepth: details.crawl_depth ?? defaultPayload.crawlDepth,
      promptOverride: details.prompt_override ?? "",
    });
  }

  function applyCrawlStatus(status: WebsiteCrawlStatusResponse) {
    setCrawlStatus(status);
  }

  useEffect(() => {
    async function restoreSession() {
      const storedToken = window.localStorage.getItem(sessionStorageKey);
      if (!storedToken) {
        setSessionChecking(false);
        return;
      }

      try {
        const session = await createIraApiClient({
          baseUrl: apiBaseUrl,
          token: storedToken,
        }).getSession();
        setToken(storedToken);
        setSessionUsername(session.username);
      } catch {
        window.localStorage.removeItem(sessionStorageKey);
      } finally {
        setSessionChecking(false);
      }
    }

    void restoreSession();
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!token) {
      setWebsiteList([]);
      return;
    }

    void loadWebsiteList();
  }, [token]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthLoading(true);
    setAuthError(null);

    try {
      const login = await publicClient.login(authForm.username, authForm.password);
      window.localStorage.setItem(sessionStorageKey, login.access_token);
      setToken(login.access_token);
      setSessionUsername(login.username);
    } catch (loginError) {
      setAuthError(
        loginError instanceof Error ? loginError.message : "Unexpected login error.",
      );
    } finally {
      setAuthLoading(false);
    }
  }

  function handleLogout() {
    window.localStorage.removeItem(sessionStorageKey);
    setToken(null);
    setSessionUsername(null);
    setResult(null);
    setDocumentsResult(null);
    setDocumentListResult(null);
    setDeleteResult(null);
    setQueryResult(null);
    setRouteResult(null);
    setWebsiteDetails(null);
    setCrawlStatus(null);
    setLatestCrawlJob(null);
    setActiveWebsiteId("");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      if (!token) {
        throw new Error("Login is required before provisioning a website.");
      }

      const body = await authenticatedClient.provisionWebsite({
        website_url: form.websiteUrl,
        display_name: form.displayName,
        allowed_domains: recommendedDomains,
        crawl_depth: form.crawlDepth,
        prompt_override: form.promptOverride || null,
      });
      setResult(body);
      setActiveWebsiteId(body.website_id);
      setWebsiteDetails({
        status: "loaded",
        website_id: body.website_id,
        display_name: form.displayName,
        website_url: form.websiteUrl,
        allowed_domains: recommendedDomains,
        crawl_depth: form.crawlDepth,
        prompt_override: form.promptOverride || null,
        rag_collection: body.rag_collection,
        rag_status: body.rag_status,
        rag_endpoint: body.rag_endpoint,
        rag_document_count: body.rag_document_count,
        crawl_status: body.crawl_status,
        crawl_schedule: body.crawl_schedule,
        indexed_page_count: body.indexed_page_count,
        indexed_chunk_count: body.indexed_chunk_count,
        last_crawled_at: body.last_crawled_at,
        last_error: body.last_error,
        latest_crawl_job_id: body.latest_crawl_job_id,
        recommended_text_model: body.recommended_text_model,
        recommended_live_model: body.recommended_live_model,
      });
      setCrawlStatus({
        status: "loaded",
        website_id: body.website_id,
        crawl_status: body.crawl_status,
        crawl_schedule: body.crawl_schedule,
        indexed_page_count: body.indexed_page_count,
        indexed_chunk_count: body.indexed_chunk_count,
        last_crawled_at: body.last_crawled_at,
        last_error: body.last_error,
        latest_crawl_job_id: body.latest_crawl_job_id,
        jobs: [],
      });
      await loadWebsiteList();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unexpected onboarding error.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadWebsiteDetails(websiteId: string) {
    setLoading(true);
    setError(null);

    try {
      if (!token) {
        throw new Error("Login is required before loading saved website details.");
      }
      if (!websiteId) {
        throw new Error("Set an active website ID before loading saved website details.");
      }

      const details = await authenticatedClient.getWebsiteDetails(websiteId);
      const status = await authenticatedClient.getWebsiteCrawlStatus(websiteId, 10);
      applyWebsiteDetails(details);
      applyCrawlStatus(status);
    } catch (detailsError) {
      setError(
        detailsError instanceof Error
          ? detailsError.message
          : "Unexpected website detail loading error.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function loadWebsiteCrawlStatus(websiteId: string) {
    setCrawlActionLoading(true);
    setError(null);

    try {
      if (!token) {
        throw new Error("Login is required before loading crawl status.");
      }
      if (!websiteId) {
        throw new Error("Set an active website ID before loading crawl status.");
      }

      const status = await authenticatedClient.getWebsiteCrawlStatus(websiteId, 10);
      applyCrawlStatus(status);
    } catch (crawlError) {
      setError(
        crawlError instanceof Error ? crawlError.message : "Unexpected crawl status loading error.",
      );
    } finally {
      setCrawlActionLoading(false);
    }
  }

  async function queueCrawlJob(websiteId: string) {
    setCrawlActionLoading(true);
    setError(null);

    try {
      if (!token) {
        throw new Error("Login is required before running a crawl job.");
      }
      if (!websiteId) {
        throw new Error("Set an active website ID before running a crawl job.");
      }

      const response = await authenticatedClient.queueWebsiteCrawlJob(websiteId);
      setLatestCrawlJob(response);
      await loadWebsiteCrawlStatus(websiteId);
      await loadWebsiteDetails(websiteId);
      await loadWebsiteList();
    } catch (crawlError) {
      setError(crawlError instanceof Error ? crawlError.message : "Unexpected crawl execution error.");
    } finally {
      setCrawlActionLoading(false);
    }
  }

  async function loadWebsiteList() {
    setWebsiteListLoading(true);

    try {
      if (!token) {
        return;
      }

      const response = await authenticatedClient.listWebsites();
      setWebsiteList(response.websites);
    } catch (listError) {
      setError(
        listError instanceof Error ? listError.message : "Unexpected website listing error.",
      );
    } finally {
      setWebsiteListLoading(false);
    }
  }

  async function handleDocumentUpsert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setDocumentLoading(true);
    setDocumentError(null);
    setDocumentsResult(null);

    try {
      if (!token) {
        throw new Error("Login is required before managing knowledge base content.");
      }
      if (!resolvedWebsiteId) {
        throw new Error("Set an active website ID before managing knowledge base content.");
      }

      const response = await authenticatedClient.upsertWebsiteDocuments({
        website_id: resolvedWebsiteId,
        documents: [
          {
            id: documentForm.id,
            document: documentForm.document,
            metadata: {
              source: documentForm.source,
            },
          },
        ],
      });
      setDocumentsResult(response);
      await loadDocuments(resolvedWebsiteId);
      await loadWebsiteDetails(resolvedWebsiteId);
      await loadWebsiteList();
    } catch (upsertError) {
      setDocumentError(
        upsertError instanceof Error
          ? upsertError.message
          : "Unexpected document upsert error.",
      );
    } finally {
      setDocumentLoading(false);
    }
  }

  async function handleDocumentQuery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQueryLoading(true);
    setDocumentError(null);
    setQueryResult(null);

    try {
      if (!token) {
        throw new Error("Login is required before querying the knowledge base.");
      }
      if (!resolvedWebsiteId) {
        throw new Error("Set an active website ID before querying seeded documents.");
      }

      const response = await authenticatedClient.queryWebsiteDocuments({
        website_id: resolvedWebsiteId,
        query: queryText,
        limit: 5,
      });
      setQueryResult(response);
    } catch (queryError) {
      setDocumentError(
        queryError instanceof Error
          ? queryError.message
          : "Unexpected document query error.",
      );
    } finally {
      setQueryLoading(false);
    }
  }

  async function loadDocuments(websiteId: string) {
    setDocumentListLoading(true);
    setDocumentError(null);

    try {
      if (!token) {
        throw new Error("Login is required before browsing the knowledge base.");
      }
      if (!websiteId) {
        throw new Error("Set an active website ID before loading documents.");
      }

      const response = await authenticatedClient.listWebsiteDocuments(websiteId, 50);
      setDocumentListResult(response);
    } catch (listError) {
      setDocumentError(
        listError instanceof Error ? listError.message : "Unexpected document listing error.",
      );
    } finally {
      setDocumentListLoading(false);
    }
  }

  async function handleDeleteDocument(documentId: string) {
    setDocumentError(null);
    setDeleteResult(null);

    try {
      if (!token) {
        throw new Error("Login is required before deleting documents.");
      }
      if (!resolvedWebsiteId) {
        throw new Error("Set an active website ID before deleting documents.");
      }

      const response = await authenticatedClient.deleteWebsiteDocument(
        resolvedWebsiteId,
        documentId,
      );
      setDeleteResult(response);
      await loadDocuments(resolvedWebsiteId);
      await loadWebsiteDetails(resolvedWebsiteId);
      await loadWebsiteList();
    } catch (deleteError) {
      setDocumentError(
        deleteError instanceof Error ? deleteError.message : "Unexpected document delete error.",
      );
    }
  }

  async function handleRouteTest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRouteLoading(true);
    setError(null);
    setRouteResult(null);

    try {
      if (!token) {
        throw new Error("Login is required before testing route behavior.");
      }
      if (!resolvedWebsiteId) {
        throw new Error("Set an active website ID before testing route behavior.");
      }

      // Admin Portal is exempt from the runtime sensitive-data filter (it
      // protects end-user Voice/Text Chat only), so this intentionally goes
      // through the admin-authenticated preview endpoint rather than the
      // public routeConversation used by real chat traffic.
      const response = await authenticatedClient.previewRouteConversation({
        mode: routeForm.mode as "text" | "voice",
        website_id: resolvedWebsiteId,
        session_id: "admin-portal-test-session",
        message: routeForm.message,
        history: [],
      });
      setRouteResult(response);
    } catch (routeError) {
      setError(routeError instanceof Error ? routeError.message : "Unexpected route test error.");
    } finally {
      setRouteLoading(false);
    }
  }

  return (
    <AppShell
      eyebrow="IRA Admin Portal"
      title="Website Onboarding"
      description="Configure a website and let IRA provision crawl settings, RAG storage, model recommendations, and observability defaults automatically."
    >
      <section className="content-grid">
        <div className="admin-column">
          <form className="ira-panel admin-form" onSubmit={handleSubmit}>
            <h2>Setup Details</h2>

            <Field label="Website URL">
              <TextInput
                type="url"
                value={form.websiteUrl}
                onChange={(event) =>
                  setForm((current) => ({ ...current, websiteUrl: event.target.value }))
                }
                required
              />
            </Field>

            <Field label="Display Name">
              <TextInput
                type="text"
                value={form.displayName}
                onChange={(event) =>
                  setForm((current) => ({ ...current, displayName: event.target.value }))
                }
                required
              />
            </Field>

            <Field label="Allowed Domains">
              <TextInput
                type="text"
                value={form.allowedDomains}
                onChange={(event) =>
                  setForm((current) => ({ ...current, allowedDomains: event.target.value }))
                }
                placeholder="example.com, docs.example.com"
              />
            </Field>

            <Field label="Crawl Depth">
              <TextInput
                type="number"
                min={1}
                max={10}
                value={form.crawlDepth}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    crawlDepth: Number(event.target.value),
                  }))
                }
              />
            </Field>

            <Field label="Prompt Override">
              <TextArea
                rows={5}
                value={form.promptOverride}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    promptOverride: event.target.value,
                  }))
                }
                placeholder="Optional website-specific prompt guidance"
              />
            </Field>

            <PrimaryButton type="submit" disabled={loading || !token}>
              {loading ? "Provisioning..." : "Provision Website"}
            </PrimaryButton>

            {error ? <ErrorBanner>{error}</ErrorBanner> : null}
          </form>

          <form className="ira-panel admin-form" onSubmit={handleDocumentUpsert}>
            <h2>Knowledge Base Seed</h2>

            <Field label="Document ID">
              <TextInput
                type="text"
                value={documentForm.id}
                onChange={(event) =>
                  setDocumentForm((current) => ({ ...current, id: event.target.value }))
                }
                required
              />
            </Field>

            <Field label="Document Content">
              <TextArea
                rows={6}
                value={documentForm.document}
                onChange={(event) =>
                  setDocumentForm((current) => ({
                    ...current,
                    document: event.target.value,
                  }))
                }
                required
              />
            </Field>

            <Field label="Source">
              <TextInput
                type="text"
                value={documentForm.source}
                onChange={(event) =>
                  setDocumentForm((current) => ({ ...current, source: event.target.value }))
                }
                required
              />
            </Field>

            <PrimaryButton type="submit" disabled={documentLoading || !token}>
              {documentLoading ? "Saving..." : "Upsert Document"}
            </PrimaryButton>

            {documentError ? <ErrorBanner>{documentError}</ErrorBanner> : null}
          </form>
        </div>

        <div className="admin-column">
          <Panel title="Admin Session">
            {sessionChecking ? (
              <PlaceholderCopy>Checking existing admin session...</PlaceholderCopy>
            ) : token ? (
              <>
                <SummaryBlock label="Session User" value={sessionUsername ?? "admin"} />
                <SummaryBlock label="Browser Session" value="Persisted in local storage" />
                <div className="action-row">
                  <PrimaryButton type="button" onClick={handleLogout} className="secondary-action">
                    Logout
                  </PrimaryButton>
                </div>
              </>
            ) : (
              <form className="admin-form" onSubmit={handleLogin}>
                <Field label="Username">
                  <TextInput
                    type="text"
                    value={authForm.username}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, username: event.target.value }))
                    }
                    required
                  />
                </Field>

                <Field label="Password">
                  <TextInput
                    type="password"
                    value={authForm.password}
                    onChange={(event) =>
                      setAuthForm((current) => ({ ...current, password: event.target.value }))
                    }
                    required
                  />
                </Field>

                <PrimaryButton type="submit" disabled={authLoading}>
                  {authLoading ? "Signing In..." : "Login"}
                </PrimaryButton>

                {authError ? <ErrorBanner>{authError}</ErrorBanner> : null}
              </form>
            )}
          </Panel>

          <Panel title="Provisioning Preview">
            <SummaryBlock
              label="Allowed domains"
              value={recommendedDomains.join(", ") || "No restriction entered"}
            />
            <SummaryBlock
              label="Provisioning behavior"
              value="Creates crawl, RAG, agent, and observability defaults"
            />
            <SummaryBlock label="Initial crawl schedule" value="Daily" />
            <SummaryBlock
              label="Admin session"
              value={token ? "Authenticated" : "Login required before changes"}
            />
            <Field label="Active Website ID">
              <TextInput
                type="text"
                value={activeWebsiteId}
                onChange={(event) => setActiveWebsiteId(event.target.value)}
                placeholder="example-site-123abc"
              />
            </Field>
            <Field label="Saved Websites">
              <select
                className="ira-input"
                value={resolvedWebsiteId}
                onChange={(event) => {
                  const nextWebsiteId = event.target.value;
                  setActiveWebsiteId(nextWebsiteId);
                  if (nextWebsiteId) {
                    void loadWebsiteDetails(nextWebsiteId);
                  }
                }}
                disabled={!token || websiteListLoading}
              >
                <option value="">
                  {websiteListLoading ? "Loading saved websites..." : "Select a saved website"}
                </option>
                {websiteList.map((website) => (
                  <option key={website.website_id} value={website.website_id}>
                    {website.display_name
                      ? `${website.display_name} (${website.website_id})`
                      : website.website_id}
                  </option>
                ))}
              </select>
            </Field>
            <div className="action-row">
              <PrimaryButton
                type="button"
                onClick={() => void loadWebsiteList()}
                disabled={websiteListLoading || !token}
                className="secondary-action"
              >
                {websiteListLoading ? "Refreshing Websites..." : "Refresh Website List"}
              </PrimaryButton>
              <PrimaryButton
                type="button"
                onClick={() => void loadWebsiteDetails(resolvedWebsiteId)}
                disabled={loading || !token || !resolvedWebsiteId}
                className="secondary-action"
              >
                {loading ? "Loading Details..." : "Load Website Details"}
              </PrimaryButton>
              <PrimaryButton
                type="button"
                onClick={() => void loadWebsiteCrawlStatus(resolvedWebsiteId)}
                disabled={crawlActionLoading || !token || !resolvedWebsiteId}
                className="secondary-action"
              >
                {crawlActionLoading ? "Loading Crawl..." : "Load Crawl Status"}
              </PrimaryButton>
              <PrimaryButton
                type="button"
                onClick={() => void queueCrawlJob(resolvedWebsiteId)}
                disabled={crawlActionLoading || !token || !resolvedWebsiteId}
                className="secondary-action"
              >
                {crawlActionLoading ? "Running Crawl..." : "Run Crawl Now"}
              </PrimaryButton>
              <PrimaryButton
                type="button"
                onClick={() => void loadDocuments(resolvedWebsiteId)}
                disabled={documentListLoading || !token || !resolvedWebsiteId}
                className="secondary-action"
              >
                {documentListLoading ? "Refreshing..." : "Load Documents"}
              </PrimaryButton>
            </div>

            <div className="website-table-block">
              <div className="website-table-header">
                <h3>Saved Websites</h3>
                <span>{websiteList.length} total</span>
              </div>
              {websiteList.length > 0 ? (
                <div className="website-table-scroll">
                  <table className="website-table">
                    <thead>
                      <tr>
                        <th>Website ID</th>
                        <th>Display Name</th>
                        <th>URL</th>
                        <th>RAG Collection</th>
                      </tr>
                    </thead>
                    <tbody>
                      {websiteList.map((website) => (
                        <tr
                          key={website.website_id}
                          className={
                            resolvedWebsiteId === website.website_id ? "website-row-active" : ""
                          }
                        >
                          <td>
                            <button
                              type="button"
                              className="table-link-button"
                              onClick={() => {
                                setActiveWebsiteId(website.website_id);
                                void loadWebsiteDetails(website.website_id);
                              }}
                            >
                              {website.website_id}
                            </button>
                          </td>
                          <td>{website.display_name ?? "Not saved"}</td>
                          <td>{website.website_url ?? "Not saved"}</td>
                          <td>{website.rag_collection}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <PlaceholderCopy>
                  {websiteListLoading
                    ? "Loading saved websites from storage..."
                    : "No saved websites found yet."}
                </PlaceholderCopy>
              )}
            </div>

            {websiteDetails ? (
              <ResultCard title="Saved Website Details">
                <p>
                  <span>Website ID</span>
                  <strong>{websiteDetails.website_id}</strong>
                </p>
                <p>
                  <span>Display Name</span>
                  <strong>{websiteDetails.display_name ?? "Not saved"}</strong>
                </p>
                <p>
                  <span>Website URL</span>
                  <strong>{websiteDetails.website_url ?? "Not saved"}</strong>
                </p>
                <p>
                  <span>Allowed Domains</span>
                  <strong>
                    {websiteDetails.allowed_domains.length > 0
                      ? websiteDetails.allowed_domains.join(", ")
                      : "Not saved"}
                  </strong>
                </p>
                <p>
                  <span>Crawl Depth</span>
                  <strong>{websiteDetails.crawl_depth ?? "Not saved"}</strong>
                </p>
                <p>
                  <span>Prompt Override</span>
                  <strong>{websiteDetails.prompt_override || "Not saved"}</strong>
                </p>
                <p>
                  <span>RAG Collection</span>
                  <strong>{websiteDetails.rag_collection}</strong>
                </p>
                <p>
                  <span>RAG Status</span>
                  <strong>{websiteDetails.rag_status}</strong>
                </p>
                <p>
                  <span>RAG Endpoint</span>
                  <strong>{websiteDetails.rag_endpoint}</strong>
                </p>
                <p>
                  <span>Stored Documents</span>
                  <strong>
                    {deleteResult?.total_document_count ??
                      documentsResult?.total_document_count ??
                      documentListResult?.documents.length ??
                      websiteDetails.rag_document_count}
                  </strong>
                </p>
                <p>
                  <span>Crawl Status</span>
                  <strong>{websiteDetails.crawl_status}</strong>
                </p>
                <p>
                  <span>Indexed Pages</span>
                  <strong>{websiteDetails.indexed_page_count}</strong>
                </p>
                <p>
                  <span>Indexed Chunks</span>
                  <strong>{websiteDetails.indexed_chunk_count}</strong>
                </p>
                <p>
                  <span>Latest Crawl Job</span>
                  <strong>{websiteDetails.latest_crawl_job_id ?? "Not run yet"}</strong>
                </p>
                <p>
                  <span>Last Crawled At</span>
                  <strong>{websiteDetails.last_crawled_at ?? "Not crawled yet"}</strong>
                </p>
                <p>
                  <span>Last Crawl Error</span>
                  <strong>{websiteDetails.last_error ?? "None"}</strong>
                </p>
                <p>
                  <span>Text Model</span>
                  <strong>{websiteDetails.recommended_text_model}</strong>
                </p>
                <p>
                  <span>Live Model</span>
                  <strong>{websiteDetails.recommended_live_model}</strong>
                </p>
              </ResultCard>
            ) : (
              <PlaceholderCopy>
                Provision a website or paste an existing website ID, then load the saved website details from storage.
              </PlaceholderCopy>
            )}

            {crawlStatus ? (
              <ResultCard title="Crawl Status">
                <p>
                  <span>Status</span>
                  <strong>{crawlStatus.crawl_status}</strong>
                </p>
                <p>
                  <span>Schedule</span>
                  <strong>{crawlStatus.crawl_schedule}</strong>
                </p>
                <p>
                  <span>Indexed Pages</span>
                  <strong>{crawlStatus.indexed_page_count}</strong>
                </p>
                <p>
                  <span>Indexed Chunks</span>
                  <strong>{crawlStatus.indexed_chunk_count}</strong>
                </p>
                <p>
                  <span>Latest Job</span>
                  <strong>{crawlStatus.latest_crawl_job_id ?? "Not run yet"}</strong>
                </p>
                <p>
                  <span>Last Error</span>
                  <strong>{crawlStatus.last_error ?? "None"}</strong>
                </p>
                {crawlStatus.jobs.length > 0 ? (
                  crawlStatus.jobs.map((job) => (
                    <p key={job.job_id}>
                      <span>{job.job_id}</span>
                      <strong>
                        {job.status} | queued {job.scheduled_at}
                      </strong>
                    </p>
                  ))
                ) : (
                  <p>
                    <span>Jobs</span>
                    <strong>No crawl jobs have run yet.</strong>
                  </p>
                )}
              </ResultCard>
            ) : null}
            {latestCrawlJob ? (
              <SummaryBlock label="Latest Crawl Job" value={latestCrawlJob.job.job_id} />
            ) : null}
          </Panel>

          <form className="ira-panel admin-form" onSubmit={handleDocumentQuery}>
            <h2>Knowledge Base Query</h2>

            <Field label="Query">
              <TextInput
                type="text"
                value={queryText}
                onChange={(event) => setQueryText(event.target.value)}
                placeholder="support pricing"
                required
              />
            </Field>

            <PrimaryButton type="submit" disabled={queryLoading || !token}>
              {queryLoading ? "Searching..." : "Query Documents"}
            </PrimaryButton>

            {queryResult ? (
              <ResultCard title="Query Matches">
                {queryResult.matches.length > 0 ? (
                  queryResult.matches.map((match) => (
                    <p key={match.id}>
                      <span>{match.id}</span>
                      <strong>{match.document}</strong>
                    </p>
                  ))
                ) : (
                  <p>
                    <span>Matches</span>
                    <strong>No documents matched the current query.</strong>
                  </p>
                )}
              </ResultCard>
            ) : null}
          </form>

          <Panel title="Current Documents">
            {documentListResult ? (
              <ResultCard title="Stored Documents">
                {documentListResult.documents.length > 0 ? (
                  documentListResult.documents.map((document) => (
                    <div key={document.id} className="document-row">
                      <p>
                        <span>{document.id}</span>
                        <strong>{document.document}</strong>
                      </p>
                      <div className="action-row">
                        <PrimaryButton
                          type="button"
                          className="secondary-action"
                          onClick={() => void handleDeleteDocument(document.id)}
                        >
                          Delete
                        </PrimaryButton>
                      </div>
                    </div>
                  ))
                ) : (
                  <p>
                    <span>Documents</span>
                    <strong>No documents are stored for the current website.</strong>
                  </p>
                )}
              </ResultCard>
            ) : (
              <PlaceholderCopy>
                Load the active website documents to inspect or delete corpus entries.
              </PlaceholderCopy>
            )}

            {deleteResult ? (
              <SummaryBlock
                label="Latest Delete"
                value={`${deleteResult.deleted_count} removed, ${deleteResult.total_document_count} remaining`}
              />
            ) : null}
            {documentError ? <ErrorBanner>{documentError}</ErrorBanner> : null}
          </Panel>

          <form className="ira-panel admin-form" onSubmit={handleRouteTest}>
            <h2>Conversation Route Tester</h2>

            <Field label="Mode">
              <select
                className="ira-input"
                value={routeForm.mode}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, mode: event.target.value }))
                }
              >
                <option value="text">text</option>
                <option value="voice">voice</option>
              </select>
            </Field>

            <Field label="Message">
              <TextArea
                rows={4}
                value={routeForm.message}
                onChange={(event) =>
                  setRouteForm((current) => ({ ...current, message: event.target.value }))
                }
                required
              />
            </Field>

            <PrimaryButton type="submit" disabled={routeLoading || !resolvedWebsiteId}>
              {routeLoading ? "Routing..." : "Test Route"}
            </PrimaryButton>

            {routeResult ? (
              <ResultCard title="Route Result">
                <p>
                  <span>Agent</span>
                  <strong>{routeResult.route.agent}</strong>
                </p>
                <p>
                  <span>Model</span>
                  <strong>{routeResult.route.default_model}</strong>
                </p>
                <p>
                  <span>RAG Collection</span>
                  <strong>{routeResult.route.rag_collection}</strong>
                </p>
                <p>
                  <span>Fallback</span>
                  <strong>{routeResult.fallback_message}</strong>
                </p>
                <p>
                  <span>Prompt Override</span>
                  <strong>
                    {routeResult.route.website_prompt_override_applied ? "Applied" : "Not applied"}
                  </strong>
                </p>
                {routeResult.route.system_prompt ? (
                  <p>
                    <span>System Prompt</span>
                    <strong>{routeResult.route.system_prompt}</strong>
                  </p>
                ) : null}
              </ResultCard>
            ) : null}
          </form>
        </div>
      </section>
    </AppShell>
  );
}
