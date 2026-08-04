import { FormEvent, useMemo, useState } from "react";

import {
  createIraApiClient,
  type RouteConversationResponse,
} from "@ira/agents-sdk";
import {
  AppShell,
  ErrorBanner,
  Field,
  Panel,
  PlaceholderCopy,
  PrimaryButton,
  ResultCard,
  TextArea,
  TextInput,
} from "@ira/ui";
import {
  logSensitiveDataBlocked,
  scanForSensitiveData,
  SENSITIVE_DATA_BLOCK_MESSAGE,
} from "@ira/sensitive-data";

const defaultPrompt = "What services does this website provide?";

export default function App() {
  const [websiteId, setWebsiteId] = useState("example-site");
  const [message, setMessage] = useState(defaultPrompt);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteConversationResponse | null>(null);

  const apiBaseUrl = import.meta.env.VITE_IRA_API_BASE_URL as string | undefined;
  const client = useMemo(() => createIraApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const findings = scanForSensitiveData(message);
    if (findings.length > 0) {
      logSensitiveDataBlocked(findings, { app: "web-chat", websiteId });
      setError(SENSITIVE_DATA_BLOCK_MESSAGE);
      return;
    }

    setLoading(true);

    try {
      const response = await client.routeConversation({
        mode: "text",
        website_id: websiteId,
        session_id: "web-chat-session",
        message,
        history: [],
      });
      setResult(response);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected routing error.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell
      eyebrow="IRA Web Chat"
      title="Text Chat Playground"
      description="Send a text request through the orchestration layer and inspect the selected agent, default model, RAG collection, and trace identifier."
    >
      <section className="chat-layout">
        <form className="ira-panel web-chat-form" onSubmit={handleSubmit}>
          <Field label="Website ID">
            <TextInput
              value={websiteId}
              onChange={(event) => setWebsiteId(event.target.value)}
              required
            />
          </Field>

          <Field label="Message">
            <TextArea
              rows={6}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              required
            />
          </Field>

          <PrimaryButton type="submit" disabled={loading}>
            {loading ? "Routing..." : "Send To Orchestrator"}
          </PrimaryButton>

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </form>

        <Panel title="Route Preview">
          {result ? (
            <ResultCard title="Orchestration Result">
              <p>
                <span>Agent</span>
                <strong>{result.route.agent}</strong>
              </p>
              <p>
                <span>Default Model</span>
                <strong>{result.route.default_model}</strong>
              </p>
              <p>
                <span>RAG Collection</span>
                <strong>{result.route.rag_collection}</strong>
              </p>
              <p>
                <span>RAG Status</span>
                <strong>{result.route.rag_status ?? "unknown"}</strong>
              </p>
              <p>
                <span>Trace ID</span>
                <strong>{result.observability_trace_id}</strong>
              </p>
              <p>
                <span>Fallback Message</span>
                <strong>{result.fallback_message}</strong>
              </p>
              <p>
                <span>Prompt Override</span>
                <strong>{result.route.website_prompt_override_applied ? "Applied" : "Not applied"}</strong>
              </p>
              <p>
                <span>Retrieved Matches</span>
                <strong>{result.route.retrieval_matches?.length ?? 0}</strong>
              </p>
              <p>
                <span>Citations</span>
                <strong>{result.route.citations?.length ?? 0}</strong>
              </p>
              {result.route.system_prompt ? (
                <p>
                  <span>System Prompt</span>
                  <strong>{result.route.system_prompt}</strong>
                </p>
              ) : null}
              {result.route.retrieval_matches && result.route.retrieval_matches.length > 0 ? (
                result.route.retrieval_matches.map((match) => (
                  <p key={match.id}>
                    <span>{match.metadata.page_title ?? match.id}</span>
                    <strong>{match.document}</strong>
                  </p>
                ))
              ) : null}
              {result.route.citations && result.route.citations.length > 0 ? (
                result.route.citations.map((citation) => (
                  <p key={citation.label}>
                    <span>{`${citation.label} ${citation.page_title ?? citation.document_id}`}</span>
                    <strong>{citation.page_url ?? citation.excerpt}</strong>
                  </p>
                ))
              ) : null}
            </ResultCard>
          ) : (
            <PlaceholderCopy>
              No response yet. Submit a chat request to inspect the orchestration result.
            </PlaceholderCopy>
          )}
        </Panel>
      </section>
    </AppShell>
  );
}
