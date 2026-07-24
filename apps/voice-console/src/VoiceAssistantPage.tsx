import { useEffect, useMemo, useRef, useState } from "react";

import { createIraApiClient, type LiveConfigResponse } from "@ira/agents-sdk";
import irasLogo from "./assets/iras-logo.svg";

type ConnectionState = "idle" | "connecting" | "connected" | "closed" | "error";
type ListeningState = "idle" | "listening";
type SensitivityLevel = "low" | "medium" | "high";

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

const fixedWebsiteId = "iras-128e32";
const sensitivityConfig: Record<SensitivityLevel, { threshold: number; frames: number }> = {
  low: { threshold: 0.036, frames: 4 },
  medium: { threshold: 0.028, frames: 3 },
  high: { threshold: 0.02, frames: 2 },
};
const envSensitivityLevel = (import.meta.env.VITE_VOICE_SENSITIVITY_LEVEL as string | undefined)?.toLowerCase();
const defaultSensitivityLevel: SensitivityLevel =
  envSensitivityLevel === "low" || envSensitivityLevel === "high" ? envSensitivityLevel : "medium";

export function VoiceAssistantPage() {
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [listeningState, setListeningState] = useState<ListeningState>("idle");
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [assistantTranscript, setAssistantTranscript] = useState("");
  const [liveConfig, setLiveConfig] = useState<LiveConfigResponse | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [assistantLevel, setAssistantLevel] = useState(0);
  const sensitivityLevel = defaultSensitivityLevel;

  const apiBaseUrl = import.meta.env.VITE_IRA_API_BASE_URL as string | undefined;
  const client = useMemo(() => createIraApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveSessionVersionRef = useRef(0);

  const captureContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

  const playbackContextRef = useRef<AudioContext | null>(null);
  const assistantSpeechTimeoutRef = useRef<number | null>(null);
  const assistantFinalizeTimeoutRef = useRef<number | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const playbackGainRef = useRef<GainNode | null>(null);

  const micLevelTimeoutRef = useRef<number | null>(null);
  const assistantLevelTimeoutRef = useRef<number | null>(null);
  const assistantSpeakingRef = useRef(false);
  const assistantTranscriptBufferRef = useRef("");
  const silenceFrameCountRef = useRef(0);
  const hadUserSpeechRef = useRef(false);
  const audioEndedRef = useRef(false);
  const userSpeechActiveRef = useRef(false);
  useEffect(() => {
    assistantSpeakingRef.current = assistantSpeaking;
  }, [assistantSpeaking]);

  const suppressAssistantAudioRef = useRef(false);
  const bargeInActiveRef = useRef(false);
  const sawInputAfterBargeInRef = useRef(false);
  const consecutiveBargeInFramesRef = useRef(0);
  const { threshold: bargeInThreshold, frames: requiredBargeInFrames } = sensitivityConfig[sensitivityLevel];

  useEffect(() => {
    return () => {
      stopAll();
      if (assistantSpeechTimeoutRef.current) {
        window.clearTimeout(assistantSpeechTimeoutRef.current);
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function resetPlayback() {
    nextStartTimeRef.current = 0;
    void playbackContextRef.current?.close();
    playbackContextRef.current = null;
    playbackGainRef.current = null;
    assistantSpeakingRef.current = false;
    setAssistantSpeaking(false);
    setAssistantLevel(0);
    if (assistantSpeechTimeoutRef.current) {
      window.clearTimeout(assistantSpeechTimeoutRef.current);
      assistantSpeechTimeoutRef.current = null;
    }
    if (assistantFinalizeTimeoutRef.current) {
      window.clearTimeout(assistantFinalizeTimeoutRef.current);
      assistantFinalizeTimeoutRef.current = null;
    }
    if (assistantLevelTimeoutRef.current) {
      window.clearTimeout(assistantLevelTimeoutRef.current);
      assistantLevelTimeoutRef.current = null;
    }
  }

  function commitAssistantReply() {
    const reply = assistantTranscriptBufferRef.current.trim();
    if (looksLikeUsableReply(reply)) {
      setAssistantTranscript(reply);
    }
  }

  function scheduleAssistantReplyFinalize() {
    if (assistantFinalizeTimeoutRef.current) {
      window.clearTimeout(assistantFinalizeTimeoutRef.current);
    }
    assistantFinalizeTimeoutRef.current = window.setTimeout(() => {
      setAwaitingResponse(false);
      commitAssistantReply();
      assistantFinalizeTimeoutRef.current = null;
    }, 1600);
  }

  function stopCapture() {
    processorNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    processorNodeRef.current = null;
    sourceNodeRef.current = null;
    void captureContextRef.current?.close();
    captureContextRef.current = null;
    setMicLevel(0);
    if (micLevelTimeoutRef.current) {
      window.clearTimeout(micLevelTimeoutRef.current);
      micLevelTimeoutRef.current = null;
    }
  }

  function stopSession() {
    const socket = liveSocketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "audio_end" }));
      socket.close(1000, "stopped");
    } else {
      socket?.close();
    }
    liveSocketRef.current = null;
    liveSessionVersionRef.current += 1;
    setConnectionState("closed");
  }

  function stopAll() {
    stopCapture();
    resetPlayback();
    stopSession();
    setListeningState("idle");
    setAwaitingResponse(false);
    silenceFrameCountRef.current = 0;
    hadUserSpeechRef.current = false;
    audioEndedRef.current = false;
    userSpeechActiveRef.current = false;
  }

  function mergeTranscriptChunk(current: string, incoming: string) {
    const trimmedIncoming = incoming.trim();
    if (!trimmedIncoming) return current;
    if (!current) return trimmedIncoming;

    if (trimmedIncoming === current) {
      return current;
    }
    if (trimmedIncoming.includes(current)) {
      return trimmedIncoming;
    }
    if (current.includes(trimmedIncoming)) {
      return current;
    }

    const normalizedCurrent = current.replace(/\s+/g, " ").trim();
    const normalizedIncoming = trimmedIncoming.replace(/\s+/g, " ").trim();
    const maxOverlap = Math.min(normalizedCurrent.length, normalizedIncoming.length);

    for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
      if (
        normalizedCurrent.slice(-overlap).toLowerCase() ===
        normalizedIncoming.slice(0, overlap).toLowerCase()
      ) {
        return `${normalizedCurrent}${normalizedIncoming.slice(overlap)}`.trim();
      }
    }

    return `${normalizedCurrent} ${normalizedIncoming}`.replace(/\s+/g, " ").trim();
  }

  function looksLikeFullSentence(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    return (wordCount >= 4 && /[.!?]$/.test(trimmed)) || wordCount >= 6;
  }

  function looksLikeUsableReply(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    return wordCount >= 2;
  }

  async function ensureMicrophone() {
    if (mediaStreamRef.current) return mediaStreamRef.current;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStreamRef.current = stream;
    return stream;
  }

  function buildLiveWebSocketUrl(websiteIdValue: string, model: string) {
    const url = new URL("/api/live/ws", apiBaseUrl ?? "http://localhost:8000");
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("website_id", websiteIdValue);
    url.searchParams.set("model", model);
    url.searchParams.set("language_hint", "en-US");
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
    if (suppressAssistantAudioRef.current) {
      return;
    }
    if (!playbackContextRef.current) {
      const AudioContextCtor = window.AudioContext || (window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      }).webkitAudioContext;
      if (AudioContextCtor) {
        playbackContextRef.current = new AudioContextCtor({ sampleRate: 24000 });
        const gainNode = playbackContextRef.current.createGain();
        gainNode.connect(playbackContextRef.current.destination);
        playbackGainRef.current = gainNode;
      }
    }
    const ctx = playbackContextRef.current;
    if (!ctx) return;

    const float32Data = base64ToFloat32Array(base64Data);
    const audioBuffer = ctx.createBuffer(1, float32Data.length, 24000);
    audioBuffer.getChannelData(0).set(float32Data);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(playbackGainRef.current ?? ctx.destination);

    const currentTime = ctx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
    let energy = 0;
    for (let i = 0; i < float32Data.length; i += 1) {
      energy += float32Data[i] * float32Data[i];
    }
    const playbackRms = float32Data.length > 0 ? Math.sqrt(energy / float32Data.length) : 0;
    setAssistantLevel(Math.min(1, playbackRms * 8));
    if (assistantLevelTimeoutRef.current) {
      window.clearTimeout(assistantLevelTimeoutRef.current);
    }
    assistantLevelTimeoutRef.current = window.setTimeout(() => {
      setAssistantLevel(0);
      assistantLevelTimeoutRef.current = null;
    }, 120);
    assistantSpeakingRef.current = true;
    setAssistantSpeaking(true);
    if (assistantSpeechTimeoutRef.current) {
      window.clearTimeout(assistantSpeechTimeoutRef.current);
    }
    assistantSpeechTimeoutRef.current = window.setTimeout(() => {
      assistantSpeakingRef.current = false;
      setAssistantSpeaking(false);
      assistantSpeechTimeoutRef.current = null;
    }, 800);
  }

  function handleLiveEvent(event: LiveServerEvent) {
    switch (event.type) {
      case "ready":
        setConnectionState("connected");
        break;
      case "input_transcript":
        if (bargeInActiveRef.current) {
          sawInputAfterBargeInRef.current = true;
        }
        break;
      case "interrupted":
        if (bargeInActiveRef.current) {
          suppressAssistantAudioRef.current = true;
        }
        break;
      case "output_transcript":
        assistantTranscriptBufferRef.current = mergeTranscriptChunk(assistantTranscriptBufferRef.current, event.text);
        if (looksLikeFullSentence(assistantTranscriptBufferRef.current)) {
          setAssistantTranscript(assistantTranscriptBufferRef.current.trim());
        }
        scheduleAssistantReplyFinalize();
        if (bargeInActiveRef.current && sawInputAfterBargeInRef.current) {
          bargeInActiveRef.current = false;
          sawInputAfterBargeInRef.current = false;
          suppressAssistantAudioRef.current = false;
          resetPlayback();
        }
        break;
      case "model_text":
        assistantTranscriptBufferRef.current = mergeTranscriptChunk(assistantTranscriptBufferRef.current, event.text);
        scheduleAssistantReplyFinalize();
        if (bargeInActiveRef.current && sawInputAfterBargeInRef.current) {
          bargeInActiveRef.current = false;
          sawInputAfterBargeInRef.current = false;
          suppressAssistantAudioRef.current = false;
          resetPlayback();
        }
        break;
      case "turn_complete":
        if (assistantFinalizeTimeoutRef.current) {
          window.clearTimeout(assistantFinalizeTimeoutRef.current);
          assistantFinalizeTimeoutRef.current = null;
        }
        setAwaitingResponse(false);
        commitAssistantReply();
        break;
      case "audio_chunk":
        playAudioChunk(event.data);
        scheduleAssistantReplyFinalize();
        break;
      case "error":
        setError(event.message);
        setConnectionState("error");
        setAwaitingResponse(false);
        if (assistantFinalizeTimeoutRef.current) {
          window.clearTimeout(assistantFinalizeTimeoutRef.current);
          assistantFinalizeTimeoutRef.current = null;
        }
        break;
      default:
        break;
    }
  }

  async function ensureSession(targetWebsiteId: string) {
    if (liveSocketRef.current?.readyState === WebSocket.OPEN) return;

    setConnectionState("connecting");
    const response = await client.routeConversation({
      mode: "voice",
      website_id: targetWebsiteId,
      session_id: "voice-assistant-session",
      message: "Start voice session.",
      history: [],
      language_hint: "en-US",
    });

    const config = await client.getLiveConfig(response.route.default_model);
    setLiveConfig(config);
    if (config.status !== "available") {
      throw new Error(config.reason ?? "Gemini Live is unavailable.");
    }

    const sessionVersion = liveSessionVersionRef.current + 1;
    liveSessionVersionRef.current = sessionVersion;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(
        buildLiveWebSocketUrl(response.route.website_id, response.route.default_model),
      );
      liveSocketRef.current = socket;

      socket.onopen = () => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        setConnectionState("connected");
      };

      socket.onmessage = (message) => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        try {
          handleLiveEvent(JSON.parse(message.data) as LiveServerEvent);
          resolve();
        } catch {
          // ignore
        }
      };

      socket.onclose = (event) => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        if (event.code !== 1000 && event.reason) {
          setError(`Gemini Live session closed: ${event.reason}`);
        }
        setConnectionState("closed");
        reject(new Error("Gemini Live session closed."));
      };

      socket.onerror = () => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        setConnectionState("error");
        reject(new Error("Gemini Live proxy connection failed."));
      };
    });
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

  async function startTalking() {
    setError(null);
    setAwaitingResponse(false);
    assistantTranscriptBufferRef.current = "";
    silenceFrameCountRef.current = 0;
    hadUserSpeechRef.current = false;
    audioEndedRef.current = false;
    userSpeechActiveRef.current = false;
    const resolvedWebsiteId = fixedWebsiteId;
    const stream = await ensureMicrophone();
    await ensureSession(resolvedWebsiteId);

    stopCapture();
    resetPlayback();

    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not ready.");
    }

    const AudioContextCtor = window.AudioContext || (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error("This browser does not support Web Audio microphone processing.");
    }

    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
    const lastBargeInAtRef = { value: 0 };
    let chunkCount = 0;
    let lastChunkLogAt = Date.now();

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(input, audioContext.sampleRate, 16000);
      if (downsampled.length === 0) return;
      if (socket.readyState !== WebSocket.OPEN) return;

      let micEnergy = 0;
      for (let i = 0; i < input.length; i += 1) {
        micEnergy += input[i] * input[i];
      }
      const micRms = input.length > 0 ? Math.sqrt(micEnergy / input.length) : 0;
      setMicLevel(Math.min(1, micRms * 10));
      if (micLevelTimeoutRef.current) {
        window.clearTimeout(micLevelTimeoutRef.current);
      }
      micLevelTimeoutRef.current = window.setTimeout(() => {
        setMicLevel(0);
        micLevelTimeoutRef.current = null;
      }, 100);

      chunkCount += 1;
      if (Date.now() - lastChunkLogAt > 1000) {
        lastChunkLogAt = Date.now();
      }

      if (assistantSpeakingRef.current) {
        let energy = 0;
        for (let i = 0; i < input.length; i += 1) {
          energy += input[i] * input[i];
        }
        const rms = Math.sqrt(energy / input.length);
        if (rms > bargeInThreshold) {
          consecutiveBargeInFramesRef.current += 1;
        } else {
          consecutiveBargeInFramesRef.current = 0;
        }
        if (
          consecutiveBargeInFramesRef.current >= requiredBargeInFrames &&
          Date.now() - lastBargeInAtRef.value > 800
        ) {
          lastBargeInAtRef.value = Date.now();
          consecutiveBargeInFramesRef.current = 0;
          bargeInActiveRef.current = true;
          sawInputAfterBargeInRef.current = false;
          suppressAssistantAudioRef.current = true;
          resetPlayback();
        }
      } else {
        consecutiveBargeInFramesRef.current = 0;
      }

      const speechThreshold = 0.012;
      const silenceThreshold = 0.006;
      const requiredSilenceFrames = 14;
      const speechActive = micRms > speechThreshold;

      if (speechActive) {
        if (!userSpeechActiveRef.current) {
          assistantTranscriptBufferRef.current = "";
        }
        userSpeechActiveRef.current = true;
        hadUserSpeechRef.current = true;
        silenceFrameCountRef.current = 0;
        audioEndedRef.current = false;
        setAwaitingResponse(false);
      } else if (userSpeechActiveRef.current && micRms < silenceThreshold) {
        silenceFrameCountRef.current += 1;
      }

      if (userSpeechActiveRef.current) {
        socket.send(
          JSON.stringify({
            type: "audio_chunk",
            data: int16ToBase64(downsampled),
            mimeType: "audio/pcm;rate=16000",
          }),
        );
      }

      if (
        userSpeechActiveRef.current &&
        hadUserSpeechRef.current &&
        silenceFrameCountRef.current >= requiredSilenceFrames
      ) {
        userSpeechActiveRef.current = false;
        silenceFrameCountRef.current = 0;
        audioEndedRef.current = true;
        setAwaitingResponse(true);
        socket.send(JSON.stringify({ type: "audio_end" }));
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    captureContextRef.current = audioContext;
    sourceNodeRef.current = source;
    processorNodeRef.current = processor;

    setListeningState("listening");
  }

  function stopTalking() {
    stopAll();
  }

  async function handleTap() {
    try {
      if (listeningState === "listening") {
        stopTalking();
        return;
      }
      await startTalking();
    } catch (tapError) {
      setError(tapError instanceof Error ? tapError.message : "Unexpected error.");
      setConnectionState("error");
      setListeningState("idle");
    }
  }

  const pulseState =
    listeningState === "listening"
      ? "listening"
      : assistantSpeaking || awaitingResponse
        ? "responding"
        : connectionState === "connected"
          ? "connected"
          : "idle";

  const orbLevel = Math.max(micLevel, assistantLevel);
  const orbStyle = {
    "--va-audio-level": orbLevel.toFixed(3),
  } as React.CSSProperties;

  const stateText =
    assistantSpeaking || awaitingResponse
      ? "Responding..."
      : listeningState === "listening"
        ? "Listening..."
        : "";
  const hintText = listeningState === "listening" || assistantSpeaking || awaitingResponse ? "Tap again to stop" : "";
  const showAssistantReplyInButton = !assistantSpeaking && !awaitingResponse && assistantTranscript.trim().length > 0;
  const isConversationActive = listeningState === "listening" || assistantSpeaking || awaitingResponse;
  const buttonText = assistantTranscript.trim()
    ? assistantTranscript
    : isConversationActive
      ? ""
      : "I'm here to help with your\ntax questions.";

  return (
    <main className="va-root">
      <section className="va-shell">
        <section className="va-card">
          <div className="va-hero">
            <div className="va-wave-panel">
              <div className={`va-orb-stage va-orb-stage--${pulseState}`} style={orbStyle}>
                <div className="va-orb-halo va-orb-halo--outer" />
                <div className="va-orb-halo va-orb-halo--mid" />
                <div className="va-orb-halo va-orb-halo--inner" />
                <div className="va-orb-side va-orb-side--left" aria-hidden="true">
                  <span />
                  <span />
                  <span className="va-orb-side-pill" />
                  <span />
                  <span />
                </div>
                <div className="va-orb-side va-orb-side--right" aria-hidden="true">
                  <span />
                  <span />
                  <span className="va-orb-side-pill" />
                  <span />
                  <span />
                </div>
                <button
                  type="button"
                  className="va-orb-core va-orb-core-button"
                  onClick={handleTap}
                  aria-label={listeningState === "listening" || assistantSpeaking ? "Tap to stop" : "Tap to talk"}
                >
                  <div className="va-orb-badge">
                    <img className="va-orb-badge-logo" src={irasLogo} alt="IRAS logo" />
                  </div>
                </button>
              </div>
              <div className="va-wave-caption">
                <p className="va-state">{stateText}</p>
                {hintText ? <p className="va-hint">{hintText}</p> : null}
              </div>
            </div>
          </div>

          {error || liveConfig?.reason ? (
            <div className="va-errors">
              {error ? <p className="va-error">{error}</p> : null}
              {liveConfig?.reason ? <p className="va-error">{liveConfig.reason}</p> : null}
            </div>
          ) : null}

          <div className="va-footer">
            <button
              type="button"
              className="va-talk-button va-talk-button--reply"
              onClick={handleTap}
            >
              <div className="va-talk-reply">
                <span>{buttonText}</span>
              </div>
            </button>
          </div>
        </section>
      </section>
    </main>
  );
}
