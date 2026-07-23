import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  createIraApiClient,
  type LiveConfigResponse,
  type RouteConversationResponse,
  type WebsiteSummary,
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
  | { type: "model_text"; text: string }
  | { type: "turn_complete" }
  | { type: "interrupted" }
  | { type: "goaway"; payload: Record<string, unknown> }
  | { type: "usage"; payload: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "audio_chunk"; data: string; mimeType: string };

const websiteIdStorageKey = "ira-voice-console-website-id";

function VoiceConsoleDebug() {
  const [loading, setLoading] = useState(false);
  const [micLoading, setMicLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RouteConversationResponse | null>(null);
  const [websiteId, setWebsiteId] = useState("iras-singapore-128e32");
  const [knownWebsites, setKnownWebsites] = useState<WebsiteSummary[]>([]);
  const [websiteLoading, setWebsiteLoading] = useState(false);
  const [transportState, setTransportState] = useState("idle");
  const [liveConfig, setLiveConfig] = useState<LiveConfigResponse | null>(null);
  const [transcriptDraft, setTranscriptDraft] = useState(
    "Customer asks about multilingual support and onboarding help.",
  );
  const [transcriptLog, setTranscriptLog] = useState<TranscriptEntry[]>([]);
  const [audioSummary, setAudioSummary] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<string | null>(null);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);
  const streamedChunkCountRef = useRef(0);
  const liveSessionVersionRef = useRef(0);
  const playbackContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);

  const apiBaseUrl = import.meta.env.VITE_IRA_API_BASE_URL as string | undefined;
  const client = useMemo(() => createIraApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);

  useEffect(() => {
    return () => {
      liveSocketRef.current?.close();
      processorNodeRef.current?.disconnect();
      sourceNodeRef.current?.disconnect();
      void audioContextRef.current?.close();
      void playbackContextRef.current?.close();
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const storedWebsiteId = window.localStorage.getItem(websiteIdStorageKey);
    if (storedWebsiteId) {
      setWebsiteId(storedWebsiteId);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setWebsiteLoading(true);
    client
      .listWebsites()
      .then((response) => {
        if (!active) return;
        setKnownWebsites(response.websites ?? []);
        const storedWebsiteId = window.localStorage.getItem(websiteIdStorageKey);
        if (!storedWebsiteId && response.websites?.length) {
          setWebsiteId(response.websites[0].website_id);
        }
      })
      .catch(() => {
        if (!active) return;
        setKnownWebsites([]);
      })
      .finally(() => {
        if (!active) return;
        setWebsiteLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client]);

  useEffect(() => {
    const trimmedWebsiteId = websiteId.trim();
    if (trimmedWebsiteId) {
      window.localStorage.setItem(websiteIdStorageKey, trimmedWebsiteId);
    } else {
      window.localStorage.removeItem(websiteIdStorageKey);
    }
  }, [websiteId]);

  function appendTranscript(role: TranscriptEntry["role"], content: string) {
    setTranscriptLog((current) => [
      ...current,
      {
        id: `${role}-${Date.now()}-${current.length}`,
        role,
        content,
      },
    ]);
  }

  function buildLiveWebSocketUrl(websiteId: string, model: string, languageHint?: string) {
    const url = new URL("/api/live/ws", apiBaseUrl ?? "http://localhost:8000");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("website_id", websiteId);
    url.searchParams.set("model", model);
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

    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
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
        appendTranscript("user", event.text);
        break;
      case "output_transcript":
        appendTranscript("assistant", event.text);
        break;
      case "model_text":
        appendTranscript("assistant", event.text);
        setTransportState("responding");
        break;
      case "turn_complete":
        setTransportState("turn-complete");
        break;
      case "interrupted":
        setTransportState("interrupted");
        appendTranscript("system", "Live response was interrupted by new activity.");
        nextStartTimeRef.current = 0;
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

  async function handleStartSession() {
    setLoading(true);
    setError(null);

    try {
      if (!websiteId.trim()) {
        throw new Error("Enter a website ID before starting the voice session.");
      }

      liveSocketRef.current?.close();
      liveSessionVersionRef.current += 1;
      const response = await client.routeConversation({
        mode: "voice",
        website_id: websiteId.trim(),
        session_id: "voice-console-session",
        message: "Start a multilingual voice support session.",
        history: [],
        language_hint: "en-US",
      });
      setResult(response);
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
          "en-US",
        ),
      );
      liveSocketRef.current = socket;

      socket.onopen = () => {
        if (liveSessionVersionRef.current !== sessionVersion) {
          return;
        }
        setTransportState("proxy-open");
        appendTranscript("system", "Voice proxy WebSocket is connected.");
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
        if (event.code !== 1000 && (!event.wasClean || event.reason)) {
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
        setError("Gemini Live proxy connection failed.");
        setTransportState("error");
      };
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unexpected voice session error.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleEnableMicrophone() {
    setMicLoading(true);
    setError(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support microphone capture.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      setTransportState("microphone-ready");
      appendTranscript("system", "Microphone access granted. Ready to stream PCM audio.");
    } catch (micError) {
      setError(
        micError instanceof Error ? micError.message : "Unexpected microphone access error.",
      );
    } finally {
      setMicLoading(false);
    }
  }

  function resetPlayback() {
    nextStartTimeRef.current = 0;
    void playbackContextRef.current?.close();
    playbackContextRef.current = null;
  }

  async function handleStartCapture() {
    const stream = mediaStreamRef.current;
    if (!stream) {
      setError("Enable microphone access before starting capture.");
      return;
    }

    if (!liveSocketRef.current || liveSocketRef.current.readyState !== WebSocket.OPEN) {
      await handleStartSession();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (liveSocketRef.current?.readyState === WebSocket.OPEN) {
          break;
        }
        await sleep(100);
      }
    }

    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setError("Gemini Live session is not ready. Try Prepare Voice Session again.");
      setTransportState("error");
      return;
    }

    const AudioContextCtor = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioContextCtor) {
      setError("This browser does not support Web Audio microphone processing.");
      return;
    }

    resetPlayback();
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

  function handleStopCapture() {
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    void audioContextRef.current?.close();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    audioContextRef.current = null;
    resetPlayback();
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

  async function handleSendTranscript(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const socket = liveSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Prepare the live session before sending text turns.");
      }

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
      title="Voice Session Console"
      description="Prepare the full-screen voice experience with routing previews, live model selection, and session placeholders before real audio streaming is connected."
    >
      <section className="voice-layout">
        <Panel title="Session Controls" className="voice-panel">
          {knownWebsites.length ? (
            <Field label="Select Website">
              <select
                value={websiteId.trim()}
                onChange={(event) => setWebsiteId(event.target.value)}
              >
                {knownWebsites.map((website) => (
                  <option key={website.website_id} value={website.website_id}>
                    {website.display_name
                      ? `${website.display_name} (${website.website_id})`
                      : website.website_id}
                  </option>
                ))}
              </select>
            </Field>
          ) : websiteLoading ? (
            <SummaryBlock label="Websites" value="Loading..." />
          ) : null}
          <Field label="Website ID">
            <input
              type="text"
              value={websiteId}
              onChange={(event) => setWebsiteId(event.target.value)}
              placeholder="Enter provisioned website ID"
              required
            />
          </Field>
          <SummaryBlock label="Target Website" value={websiteId.trim() || "Not set"} />
          <SummaryBlock label="Mode" value="voice" />
          <SummaryBlock label="Language Hint" value="en-US" />
          <SummaryBlock label="Transport" value={transportState} />
          <SummaryBlock
            label="Live API"
            value={liveConfig?.status === "available" ? "Backend proxy ready" : "Not prepared"}
          />
          <SummaryBlock
            label="Microphone"
            value={mediaStreamRef.current ? "Granted" : "Not enabled"}
          />

          <PrimaryButton onClick={handleStartSession} disabled={loading}>
            {loading ? "Preparing Session..." : "Prepare Voice Session"}
          </PrimaryButton>

          <div className="voice-actions">
            <PrimaryButton
              type="button"
              onClick={handleEnableMicrophone}
              disabled={micLoading || Boolean(mediaStreamRef.current)}
              className="secondary-action"
            >
              {micLoading ? "Requesting Mic..." : "Enable Microphone"}
            </PrimaryButton>
            <PrimaryButton
              type="button"
              onClick={recording ? handleStopCapture : handleStartCapture}
              disabled={!mediaStreamRef.current}
              className="secondary-action"
            >
              {recording ? "Stop Capture" : "Start Capture"}
            </PrimaryButton>
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
              {loading ? "Routing Transcript..." : "Send Transcript To Orchestrator"}
            </PrimaryButton>
          </form>

          {audioSummary ? <SummaryBlock label="Latest Audio Buffer" value={audioSummary} /> : null}
          {usageSummary ? <SummaryBlock label="Usage" value={usageSummary} /> : null}

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </Panel>

        <Panel title="Console Preview" className="voice-panel">
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
            </ResultCard>
          ) : (
            <PlaceholderCopy>
              No voice session prepared yet. Start a session to preview how the orchestrator will route voice traffic.
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function App() {
  const debug =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("debug") === "1";
  return debug ? <VoiceConsoleDebug /> : <VoiceAssistantPage />;
}
