import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  createIraApiClient,
  type RouteConversationResponse,
  type WebsiteDocumentDeleteResponse,
  type WebsiteDocumentListResponse,
  type WebsiteDocumentQueryResponse,
  type WebsiteDocumentsUpsertResponse,
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
      if (!resolvedWebsiteId) {
        throw new Error("Set an active website ID before testing route behavior.");
      }

      const response = await publicClient.routeConversation({
        mode: routeForm.mode as "text" | "voice",
        website_id: resolvedWebsiteId,
        session_id: "admin-portal-test-session",
        message: routeForm.message,
        history: [],
        language_hint: "en-US",
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
            <div className="action-row">
              <PrimaryButton
                type="button"
                onClick={() => void loadDocuments(resolvedWebsiteId)}
                disabled={documentListLoading || !token || !resolvedWebsiteId}
                className="secondary-action"
              >
                {documentListLoading ? "Refreshing..." : "Load Documents"}
              </PrimaryButton>
            </div>

            {result ? (
              <ResultCard title="Provisioning Result">
                <p>
                  <span>Website ID</span>
                  <strong>{result.website_id}</strong>
                </p>
                <p>
                  <span>RAG Collection</span>
                  <strong>{result.rag_collection}</strong>
                </p>
                <p>
                  <span>RAG Status</span>
                  <strong>{result.rag_status}</strong>
                </p>
                <p>
                  <span>RAG Endpoint</span>
                  <strong>{result.rag_endpoint}</strong>
                </p>
                <p>
                  <span>Stored Documents</span>
                  <strong>
                    {deleteResult?.total_document_count ??
                      documentsResult?.total_document_count ??
                      documentListResult?.documents.length ??
                      result.rag_document_count}
                  </strong>
                </p>
                <p>
                  <span>Text Model</span>
                  <strong>{result.recommended_text_model}</strong>
                </p>
                <p>
                  <span>Live Model</span>
                  <strong>{result.recommended_live_model}</strong>
                </p>
              </ResultCard>
            ) : (
              <PlaceholderCopy>
                Provision a website or paste an existing website ID to unlock document management and retrieval checks.
              </PlaceholderCopy>
            )}
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
