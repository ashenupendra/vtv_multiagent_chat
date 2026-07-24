import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  createIraApiClient,
  type CitationRecord,
  type LiveConfigResponse,
  type RouteConversationResponse,
  type WebsiteListResponse,
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
} from "@ira/ui";

import { VoiceAssistantPage } from "./VoiceAssistantPage";

const voiceSessionId = "voice-console-session";

type TranscriptEntry = {
  id: string;
  role: "system" | "user" | "assistant";
  content: string;
};

type LiveServerEvent =
  | { type: "ready" }
  | { type: "status"; state: string }
  | { type: "input_transcript"; text: string }
  | { type: "output_transcript"; text: string }
  | {
      type: "grounding_history";
      entries: Array<{
        type: "grounding";
        source: string;
        query: string;
        turn_id: string;
        recorded_at: string;
        website_id: string;
        session_id: string;
        matches: Array<{
          id: string;
          document: string;
          metadata: Record<string, string>;
        }>;
        citations: CitationRecord[];
      }>;
    }
  | {
      type: "grounding";
      source: string;
      query: string;
      turn_id: string;
      recorded_at: string;
      website_id: string;
      session_id: string;
      matches: Array<{
        id: string;
        document: string;
        metadata: Record<string, string>;
      }>;
      citations: CitationRecord[];
    }
  | { type: "model_text"; text: string }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "goaway"; payload: Record<string, unknown> }
  | { type: "usage"; payload: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "audio_chunk"; data: string; mimeType: string };

function VoiceConsoleDebug() {
  const [loading, setLoading] = useState(false);
  const [micLoading, setMicLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [websiteId, setWebsiteId] = useState("");
  const [websiteList, setWebsiteList] = useState<WebsiteListResponse["websites"]>([]);
  const [websiteListLoading, setWebsiteListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteConversationResponse | null>(null);
  const [transportState, setTransportState] = useState("idle");
  const [liveConfig, setLiveConfig] = useState<LiveConfigResponse | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState(
    "Customer asks about multilingual support and onboarding help.",
  );
  const [transcriptLog, setTranscriptLog] = useState<TranscriptEntry[]>([]);
  const [audioSummary, setAudioSummary] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<string | null>(null);
  const [liveGrounding, setLiveGrounding] = useState<Extract<LiveServerEvent, { type: "grounding" }> | null>(null);
  const [liveGroundingHistory, setLiveGroundingHistory] = useState<
    Extract<LiveServerEvent, { type: "grounding" }>[]
  >([]);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const streamedChunkCountRef = useRef(0);
  const liveSessionVersionRef = useRef(0);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const playbackSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartTimeRef = useRef<number>(0);

  const apiBaseUrl = import.meta.env.VITE_IRA_API_BASE_URL as string | undefined;
  const client = useMemo(() => createIraApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);
  const selectedWebsite = useMemo(
    () => websiteList.find((website) => website.website_id === websiteId) ?? null,
    [websiteId, websiteList],
  );

  useEffect(() => {
    return () => {
      liveSocketRef.current?.close();
      processorNodeRef.current?.disconnect();
      sourceNodeRef.current?.disconnect();
      stopPlayback();
      void audioContextRef.current?.close();
      void playbackContextRef.current?.close();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    void loadWebsiteList();
  }, []);

  function appendTranscript(
    role: TranscriptEntry["role"],
    content: string,
    options?: { mergeConsecutive?: boolean },
  ) {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return;
    }

    setTranscriptLog((current) => {
      const lastEntry = current[current.length - 1];
      if (options?.mergeConsecutive && lastEntry && lastEntry.role === role) {
        return [
          ...current.slice(0, -1),
          {
            ...lastEntry,
            content: joinTranscriptContent(lastEntry.content, normalizedContent),
          },
        ];
      }

      return [
        ...current,
        {
          id: `${role}-${Date.now()}-${current.length}`,
          role,
          content: normalizedContent,
        },
      ];
    });
  }

  function resetPreparedSession() {
    liveSocketRef.current?.close();
    liveSocketRef.current = null;
    liveSessionVersionRef.current += 1;
    stopPlayback();
    setResult(null);
    setLiveConfig(null);
    setTransportState("idle");
    setTranscriptLog([]);
    setAudioSummary(null);
    setUsageSummary(null);
    setLiveGrounding(null);
    setLiveGroundingHistory([]);
    setError(null);
  }

  function resetLiveConversation(options?: { keepTranscript?: boolean }) {
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    void audioContextRef.current?.close();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    audioContextRef.current = null;
    if (recording && liveSocketRef.current?.readyState === WebSocket.OPEN) {
      liveSocketRef.current.send(JSON.stringify({ type: "audio_end" }));
    }
    setRecording(false);
    liveSocketRef.current?.close();
    liveSocketRef.current = null;
    liveSessionVersionRef.current += 1;
    stopPlayback();
    setResult(null);
    setLiveConfig(null);
    setTransportState("idle");
    setAudioSummary(null);
    setUsageSummary(null);
    setLiveGrounding(null);
    setLiveGroundingHistory([]);
    setError(null);
    if (!options?.keepTranscript) {
      setTranscriptLog([]);
    }
  }

  function handleWebsiteSelectionChange(nextWebsiteId: string) {
    setWebsiteId(nextWebsiteId);
    resetPreparedSession();
  }

  async function loadWebsiteList() {
    setWebsiteListLoading(true);

    try {
      const response = await client.listPublicWebsites();
      setWebsiteList(response.websites);
      setWebsiteId((current) => {
        if (current && response.websites.some((website) => website.website_id === current)) {
          return current;
        }
        return response.websites[0]?.website_id ?? "";
      });
    } catch (listError) {
      setError(
        listError instanceof Error
          ? listError.message
          : "Unexpected saved website loading error.",
      );
    } finally {
      setWebsiteListLoading(false);
    }
  }

  function buildLiveWebSocketUrl(
    websiteId: string,
    model: string,
    sessionId: string,
    languageHint?: string,
  ) {
    const url = new URL("/api/live/ws", apiBaseUrl ?? "http://localhost:8000");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("website_id", websiteId);
    url.searchParams.set("model", model);
    url.searchParams.set("session_id", sessionId);
    if (languageHint) {
      url.searchParams.set("language_hint", languageHint);
    }
    return url.toString();
  }

  function base64ToFloat32Array(base64: string): Float32Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const int16Array = new Int16Array(bytes.buffer);
    const float32Array = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768.0;
    }
    return float32Array;
  }

  function playAudioChunk(base64Data: string) {
    if (!playbackContextRef.current) {
      const AudioContextCtor = window.AudioContext || (window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (AudioContextCtor) {
        playbackContextRef.current = new AudioContextCtor({ sampleRate: 24000 });
      }
    }
    const ctx = playbackContextRef.current;
    if (!ctx) return;

    const float32Data = base64ToFloat32Array(base64Data);
    const audioBuffer = ctx.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    playbackSourcesRef.current.add(source);
    source.onended = () => {
      playbackSourcesRef.current.delete(source);
      source.disconnect();
    };

    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
  }

  function stopPlayback() {
    nextStartTimeRef.current = 0;
    for (const source of playbackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Ignore sources that already finished or cannot be stopped twice.
      }
      try {
        source.disconnect();
      } catch {
        // Ignore disconnected sources.
      }
    }
    playbackSourcesRef.current.clear();
  }

  function handleLiveEvent(event: LiveServerEvent) {
    switch (event.type) {
      case "ready":
        setTransportState("live-ready");
        appendTranscript("system", "Gemini Live session is ready for text and audio.");
        break;
      case "status":
        setTransportState(event.state);
        break;
      case "input_transcript":
        appendTranscript("user", event.text, { mergeConsecutive: true });
        break;
      case "output_transcript":
        appendTranscript("assistant", event.text, { mergeConsecutive: true });
        break;
      case "model_text":
        appendTranscript("assistant", event.text, { mergeConsecutive: true });
        setTransportState("responding");
        break;
      case "grounding":
        setLiveGrounding(event);
        setLiveGroundingHistory((current) => {
          const withoutCurrent = current.filter((entry) => entry.turn_id !== event.turn_id);
          return [...withoutCurrent, event];
        });
        appendTranscript(
          "system",
          `Retrieved ${event.matches.length} grounding match(es) for the ${event.source} turn.`,
        );
        break;
      case "grounding_history":
        setLiveGroundingHistory(event.entries);
        if (event.entries.length > 0) {
          setLiveGrounding(event.entries[event.entries.length - 1]);
        }
        break;
      case "turn_complete":
        setTransportState("turn-complete");
        break;
      case "interrupted":
        setTransportState("interrupted");
        appendTranscript("system", "Live response was interrupted by new activity.");
        stopPlayback();
        break;
      case "goaway":
        appendTranscript("system", "Gemini Live signaled that the session will close soon.");
        break;
      case "usage":
        setUsageSummary(JSON.stringify(event.payload));
        break;
      case "error":
        setError(event.message);
        setTransportState("error");
        break;
      case "audio_chunk":
        playAudioChunk(event.data);
        break;
      default:
        break;
    }
  }

  async function ensureMicrophoneAccess() {
    setMicLoading(true);

    try {
      const existingStream = mediaStreamRef.current;
      if (existingStream && existingStream.getAudioTracks().some((track) => track.readyState === "live")) {
        setMicrophoneEnabled(true);
        return existingStream;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support microphone capture.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      setMicrophoneEnabled(true);
      setTransportState("microphone-ready");
      appendTranscript("system", "Microphone access granted. Ready to stream PCM audio.");
      return stream;
    } catch (micError) {
      setMicrophoneEnabled(false);
      throw micError instanceof Error
        ? micError
        : new Error("Unexpected microphone access error.");
    } finally {
      setMicLoading(false);
    }
  }

  function startCapture(stream: MediaStream, socket: WebSocket) {
    const AudioContextCtor = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioContextCtor) {
      setError("This browser does not support Web Audio microphone processing.");
      return;
    }

    stopPlayback();
    streamedChunkCountRef.current = 0;
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
      if (downsampled.length === 0) {
        return;
      }

      streamedChunkCountRef.current += 1;
      socket.send(
        JSON.stringify({
          type: "audio_chunk",
          data: int16ToBase64(downsampled),
          mimeType: "audio/pcm;rate=16000",
        }),
      );
      setAudioSummary(`Streaming ${streamedChunkCountRef.current} PCM audio chunks to Gemini Live.`);
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    audioContextRef.current = audioContext;
    sourceNodeRef.current = source;
    processorNodeRef.current = processor;
    setRecording(true);
    setTransportState("streaming-audio");
    appendTranscript("system", "Audio streaming started.");
  }

  async function prepareLiveSession() {
    if (!websiteId) {
      throw new Error("Select a saved website before starting the conversation.");
    }

    resetLiveConversation();
    const response = await client.routeConversation({
      mode: "voice",
      website_id: websiteId,
      session_id: voiceSessionId,
      message: "Start a multilingual voice support session.",
      history: [],
      language_hint: "en-US",
    });
    setResult(response);
    const historyResponse = await client.getGroundingHistory(
      response.route.website_id,
      voiceSessionId,
    );
    setLiveGroundingHistory(historyResponse.entries);
    if (historyResponse.entries.length > 0) {
      setLiveGrounding(historyResponse.entries[historyResponse.entries.length - 1]);
    }
    appendTranscript("system", `Voice route prepared with ${response.route.default_model}.`);

    const config = await client.getLiveConfig(response.route.default_model);
    setLiveConfig(config);
    if (config.status !== "available") {
      throw new Error(config.reason ?? "Gemini Live is unavailable.");
    }

    setTransportState("connecting-live");
    const sessionVersion = liveSessionVersionRef.current + 1;
    liveSessionVersionRef.current = sessionVersion;
    const socket = new WebSocket(
      buildLiveWebSocketUrl(
        response.route.website_id,
        response.route.default_model,
        voiceSessionId,
        "en-US",
      ),
    );
    liveSocketRef.current = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.onopen = () => {
        if (liveSessionVersionRef.current !== sessionVersion) {
          return;
        }
        settled = true;
        setTransportState("proxy-open");
        appendTranscript("system", "Voice proxy WebSocket is connected.");
        resolve();
      };
      socket.onmessage = (message) => {
        if (liveSessionVersionRef.current !== sessionVersion) {
          return;
        }
        try {
          handleLiveEvent(JSON.parse(message.data) as LiveServerEvent);
        } catch {
          setTransportState("invalid-server-message");
        }
      };
      socket.onclose = (event) => {
        if (liveSessionVersionRef.current !== sessionVersion) {
          return;
        }
        if (!settled) {
          reject(
            new Error(
              event.reason
                ? `Gemini Live session closed: ${event.reason}`
                : `Gemini Live session closed (code ${event.code}).`,
            ),
          );
          return;
        }
        if (!event.wasClean || event.reason) {
          setError(
            event.reason
              ? `Gemini Live session closed: ${event.reason}`
              : `Gemini Live session closed (code ${event.code}).`,
          );
        }
        setTransportState("closed");
      };
      socket.onerror = () => {
        if (liveSessionVersionRef.current !== sessionVersion) {
          return;
        }
        const connectionError = new Error("Gemini Live proxy connection failed.");
        if (!settled) {
          reject(connectionError);
          return;
        }
        setError(connectionError.message);
        setTransportState("error");
      };
    });

    return { response, socket };
  }

  async function handleStartConversation() {
    setLoading(true);
    setError(null);

    try {
      const stream = await ensureMicrophoneAccess();
      const { socket } = await prepareLiveSession();
      startCapture(stream, socket);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected voice session error.",
      );
      setRecording(false);
    } finally {
      setLoading(false);
    }
  }

  function handleStopCapture() {
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    void audioContextRef.current?.close();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    audioContextRef.current = null;
    stopPlayback();
    streamedChunkCountRef.current = 0;

    const socket = liveSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio_end" }));
      socket.close(1000, "capture stopped");
    }
    liveSocketRef.current = null;
    liveSessionVersionRef.current += 1;
    setAudioSummary(`Streamed ${streamedChunkCountRef.current} PCM chunks to Gemini Live.`);
    setTransportState("capture-stopped");
    setRecording(false);
    appendTranscript("system", "Capture stopped. Live session was reset.");
  }

  function handleEndConversation() {
    if (recording) {
      handleStopCapture();
    }
    liveSocketRef.current?.close();
    liveSocketRef.current = null;
    setTransportState("idle");
    appendTranscript("system", "Conversation ended.");
  }

  async function handleSendTranscript(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const socket = liveSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Prepare the live session before sending text turns.");
      }

      stopPlayback();
      socket.send(JSON.stringify({ type: "text", text: transcriptDraft }));
      appendTranscript("user", transcriptDraft);
      setTransportState("text-sent");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected transcript routing error.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell
      eyebrow="IRA Voice Console"
      title="Client Voice Assistant"
      description="Select a website and tap once to grant microphone access, connect the live voice session, and start the conversation with RAG grounding."
    >
      <section className="voice-layout">
        <Panel title="Conversation Controls" className="voice-panel">
          <Field label="Saved Website">
            <select
              className="ira-input"
              value={websiteId}
              onChange={(event) => handleWebsiteSelectionChange(event.target.value)}
              disabled={websiteListLoading}
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
          {websiteList.length === 0 && !websiteListLoading ? (
            <PlaceholderCopy>
              No saved websites are available yet. Add one in the admin portal, then reload this page.
            </PlaceholderCopy>
          ) : null}
          <SummaryBlock
            label="Target Website"
            value={
              selectedWebsite
                ? selectedWebsite.display_name
                  ? `${selectedWebsite.display_name} (${selectedWebsite.website_id})`
                  : selectedWebsite.website_id
                : "Not selected"
            }
          />
          <SummaryBlock label="Mode" value="voice" />
          <SummaryBlock label="Language Hint" value="en-US" />
          <SummaryBlock label="Transport" value={transportState} />
          <SummaryBlock
            label="Live API"
            value={liveConfig?.status === "available" ? "Backend proxy ready" : "Not prepared"}
          />
          <SummaryBlock
            label="Microphone"
            value={microphoneEnabled ? "Granted" : "Not enabled"}
          />

          <PrimaryButton
            onClick={recording ? handleEndConversation : handleStartConversation}
            disabled={loading || !websiteId}
          >
            {loading
              ? "Starting Conversation..."
              : recording
                ? "Tap To Stop Conversation"
                : "Tap To Start Conversation"}
          </PrimaryButton>

          <div className="voice-actions">
            <SummaryBlock
              label="Conversation"
              value={
                recording
                  ? "Live and listening"
                  : micLoading
                    ? "Enabling microphone"
                    : liveSocketRef.current
                      ? "Connected"
                      : "Not started"
              }
            />
          </div>

          <form className="voice-transcript-form" onSubmit={handleSendTranscript}>
            <Field label="Transcript Draft">
              <TextArea
                rows={5}
                value={transcriptDraft}
                onChange={(event) => setTranscriptDraft(event.target.value)}
                placeholder="Transcript or operator notes"
                required
              />
            </Field>
            <PrimaryButton type="submit" disabled={loading}>
              {loading ? "Sending Message..." : "Send Text Message"}
            </PrimaryButton>
          </form>

          {audioSummary ? <SummaryBlock label="Latest Audio Buffer" value={audioSummary} /> : null}
          {usageSummary ? <SummaryBlock label="Usage" value={usageSummary} /> : null}
          {liveGrounding ? (
            <SummaryBlock
              label="Latest Grounding"
              value={`${liveGrounding.source} turn with ${liveGrounding.matches.length} match(es)`}
            />
          ) : null}
          <SummaryBlock
            label="Grounding History"
            value={`${liveGroundingHistory.length} stored turn(s)`}
          />

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </Panel>

        <Panel title="Conversation View" className="voice-panel">
          {result ? (
            <ResultCard title="Voice Route">
              <p>
                <span>Agent</span>
                <strong>{result.route.agent}</strong>
              </p>
              <p>
                <span>Live Model</span>
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
                <span>Transport State</span>
                <strong>{transportState}</strong>
              </p>
              <p>
                <span>Live Proxy</span>
                <strong>{liveConfig?.api_mode ?? "not configured"}</strong>
              </p>
              <p>
                <span>Retrieved Matches</span>
                <strong>{result.route.retrieval_matches?.length ?? 0}</strong>
              </p>
            </ResultCard>
          ) : (
            <PlaceholderCopy>
              No voice session is active yet. Tap the start button to connect the client-facing voice assistant.
            </PlaceholderCopy>
          )}

          {transcriptLog.length > 0 ? (
            <ResultCard title="Transcript Timeline">
              {transcriptLog.map((entry) => (
                <p key={entry.id}>
                  <span>{entry.role}</span>
                  <strong>{entry.content}</strong>
                </p>
              ))}
            </ResultCard>
          ) : null}
          {result?.route.retrieval_matches && result.route.retrieval_matches.length > 0 ? (
            <ResultCard title="Retrieved Context">
              {result.route.retrieval_matches.map((match) => (
                <p key={match.id}>
                  <span>{match.metadata.page_title ?? match.id}</span>
                  <strong>{match.document}</strong>
                </p>
              ))}
            </ResultCard>
          ) : null}
          {result?.route.citations && result.route.citations.length > 0 ? (
            <ResultCard title="Route Citations">
              {result.route.citations.map((citation) => (
                <p key={citation.label}>
                  <span>{`${citation.label} ${citation.page_title ?? citation.document_id}`}</span>
                  <strong>{citation.page_url ?? citation.excerpt}</strong>
                </p>
              ))}
            </ResultCard>
          ) : null}
          {liveGrounding ? (
            <ResultCard title="Live Turn Grounding">
              <p>
                <span>Source</span>
                <strong>{liveGrounding.source}</strong>
              </p>
              <p>
                <span>Query</span>
                <strong>{liveGrounding.query}</strong>
              </p>
              {liveGrounding.matches.length > 0 ? (
                liveGrounding.matches.map((match) => (
                  <p key={match.id}>
                    <span>{match.metadata.page_title ?? match.id}</span>
                    <strong>{match.document}</strong>
                  </p>
                ))
              ) : (
                <p>
                  <span>Matches</span>
                  <strong>No retrieval matches were found for the latest live turn.</strong>
                </p>
              )}
              {liveGrounding.citations.length > 0 ? (
                liveGrounding.citations.map((citation) => (
                  <p key={`${liveGrounding.turn_id}-${citation.label}`}>
                    <span>{`${citation.label} ${citation.page_title ?? citation.document_id}`}</span>
                    <strong>{citation.page_url ?? citation.excerpt}</strong>
                  </p>
                ))
              ) : null}
            </ResultCard>
          ) : null}
          {liveGroundingHistory.length > 0 ? (
            <ResultCard title="Stored Grounding History">
              {liveGroundingHistory.map((entry) => (
                <p key={entry.turn_id}>
                  <span>{`${entry.source} | ${entry.recorded_at}`}</span>
                  <strong>{`${entry.query} (${entry.citations.length} citation(s))`}</strong>
                </p>
              ))}
            </ResultCard>
          ) : null}
        </Panel>
      </section>
    </AppShell>
  );
}

function downsampleBuffer(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Int16Array {
  if (outputSampleRate >= inputSampleRate) {
    return convertFloat32ToInt16(input);
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(input.length / sampleRateRatio);
  const result = new Int16Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < input.length; index += 1) {
      accum += input[index];
      count += 1;
    }

    const averaged = count > 0 ? accum / count : 0;
    result[offsetResult] = floatToInt16Sample(averaged);
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function convertFloat32ToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = floatToInt16Sample(input[index]);
  }
  return output;
}

function floatToInt16Sample(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function int16ToBase64(buffer: Int16Array): string {
  const bytes = new Uint8Array(buffer.buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return window.btoa(binary);
}

function joinTranscriptContent(current: string, next: string): string {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }

  if (/^\s/.test(next) || /[ \n\t]$/.test(current) || /^[,.;:!?)]/.test(next)) {
    return `${current}${next}`;
  }

  return `${current} ${next}`;
}

export default function App() {
  const debug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";
  return debug ? <VoiceConsoleDebug /> : <VoiceAssistantPage />;
}
