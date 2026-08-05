import { FormEvent, useMemo, useState } from "react";

import {
  createIraApiClient,
  type ChatMessagePayload,
  type CitationRecord,
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

type TranscriptEntry = ChatMessagePayload & { id: string; citations?: CitationRecord[] };

const defaultPrompt = "What services does this website provide?";

export default function App() {
  const [websiteId, setWebsiteId] = useState("example-site");
  const [message, setMessage] = useState(defaultPrompt);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traceId, setTraceId] = useState<string | null>(null);

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

    const outgoingMessage = message;
    const history: ChatMessagePayload[] = transcript.map(({ role, content }) => ({ role, content }));

    setTranscript((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: "user", content: outgoingMessage },
    ]);
    setMessage("");
    setLoading(true);

    try {
      const response = await client.sendChatMessage({
        website_id: websiteId,
        session_id: "web-chat-session",
        message: outgoingMessage,
        history,
      });
      setTraceId(response.observability_trace_id);
      setTranscript((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: response.reply,
          citations: response.citations,
        },
      ]);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected chat error.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell
      eyebrow="IRA Web Chat"
      title="Text Chat"
      description="Chat with the website's AI support agent. Messages are checked for sensitive personal information before being sent."
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
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              required
            />
          </Field>

          <PrimaryButton type="submit" disabled={loading}>
            {loading ? "Sending..." : "Send"}
          </PrimaryButton>

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </form>

        <Panel title="Conversation">
          {transcript.length > 0 ? (
            <>
              {transcript.map((entry) => (
                <ResultCard
                  key={entry.id}
                  title={entry.role === "user" ? "You" : "Assistant"}
                >
                  <p>{entry.content}</p>
                  {entry.citations && entry.citations.length > 0 ? (
                    <p>
                      <span>Citations</span>
                      <strong>
                        {entry.citations
                          .map((citation) => `${citation.label} ${citation.page_title ?? citation.document_id}`)
                          .join(", ")}
                      </strong>
                    </p>
                  ) : null}
                </ResultCard>
              ))}
              {traceId ? (
                <p className="ira-placeholder-copy">Trace ID: {traceId}</p>
              ) : null}
            </>
          ) : (
            <PlaceholderCopy>
              No messages yet. Send a message to start the conversation.
            </PlaceholderCopy>
          )}
        </Panel>
      </section>
    </AppShell>
  );
}
