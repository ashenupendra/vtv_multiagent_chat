import { useEffect, useMemo, useRef, useState } from "react";

import { createIraApiClient, type LiveConfigResponse } from "@ira/agents-sdk";
import {
  logSensitiveDataBlocked,
  scanForSensitiveData,
  SENSITIVE_DATA_BLOCK_MESSAGE,
} from "@ira/sensitive-data";
import irasLogo from "./assets/iras-logo.svg";

// The Web Speech API (used below purely as a local, best-effort safety net)
// isn't part of TypeScript's DOM lib, so it's typed minimally here rather
// than pulling in a third-party types package for a handful of members.
type SpeechRecognitionResultLike = {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string };
};
type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};
type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionConstructor | null {
  const globalWindow = window as typeof window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return globalWindow.SpeechRecognition ?? globalWindow.webkitSpeechRecognition ?? null;
}

type ConnectionState = "idle" | "connecting" | "connected" | "closed" | "error";
type ListeningState = "idle" | "listening";
type SensitivityLevel = "low" | "medium" | "high";

type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
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
  | { type: "audio_chunk"; data: string; mimeType: string }
  | { type: "blocked"; source: string; message: string; categories: string[] };

const fixedWebsiteId = "iras-128e32";
const sensitivityConfig: Record<SensitivityLevel, { threshold: number; frames: number }> = {
  low: { threshold: 0.036, frames: 4 },
  medium: { threshold: 0.028, frames: 3 },
  high: { threshold: 0.02, frames: 2 },
};
const envSensitivityLevel = (import.meta.env.VITE_VOICE_SENSITIVITY_LEVEL as string | undefined)?.toLowerCase();
const defaultSensitivityLevel: SensitivityLevel =
  envSensitivityLevel === "low" || envSensitivityLevel === "high" ? envSensitivityLevel : "medium";
const sessionGreetingText = "Hello! I’m the IRAS Tax Agent virtual assistant. How can I help you today?";
const inactivityFollowUpText =    "If you don't have any more questions, I'll end our conversation here in a few seconds. If there's anything else you'd like to ask, just start speaking and I'll be happy to help.";
// Silence after the assistant finishes speaking, before it asks the follow-up prompt.
const INACTIVITY_TIMEOUT_MS = 10_000;
// Visible countdown after the follow-up prompt finishes speaking, before the session ends.
const FOLLOW_UP_COUNTDOWN_SECONDS = 9;
// Small buffer added after the last scheduled audio buffer finishes playing,
// to account for scheduling/output latency before declaring speech "settled".
const PLAYBACK_SETTLE_TAIL_MS = 150;
// Hard ceiling from when the follow-up prompt is triggered to when the
// closing countdown must have started. Guarantees the session still ends
// (or recovers to ask again next idle period) instead of hanging open with
// a live microphone if some unforeseen event ordering ever leaves the
// countdown un-started.
const FOLLOW_UP_COUNTDOWN_CEILING_MS = 15_000;
export function VoiceAssistantPage() {
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [listeningState, setListeningState] = useState<ListeningState>("idle");
  const [assistantSpeaking, setAssistantSpeaking] = useState(false);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const awaitingResponseRef = useRef(false);
  const [transcriptLog, setTranscriptLog] = useState<TranscriptEntry[]>([]);
  const [liveConfig, setLiveConfig] = useState<LiveConfigResponse | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [assistantLevel, setAssistantLevel] = useState(0);
  const [countdownSeconds, setCountdownSeconds] = useState<number | null>(null);
  const sensitivityLevel = defaultSensitivityLevel;

  const apiBaseUrl = import.meta.env.VITE_IRA_API_BASE_URL as string | undefined;
  const client = useMemo(() => createIraApiClient({ baseUrl: apiBaseUrl }), [apiBaseUrl]);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const liveSocketRef = useRef<WebSocket | null>(null);
  const liveSessionVersionRef = useRef(0);

  const captureContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorNodeRef = useRef<ScriptProcessorNode | null>(null);

  // Best-effort, client-side safety net: a local speech recognizer runs
  // alongside the raw mic stream purely to catch sensitive-looking speech
  // early. It cannot guarantee zero audio bytes reach Gemini before it
  // fires (recognition lags the live stream by roughly its own latency),
  // but the moment it does fire, further audio_chunk sends for this
  // session stop. The backend also re-checks Gemini's own transcript as a
  // second, more reliable backstop (see the "blocked" server event).
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const sensitiveBlockedRef = useRef(false);

  const playbackContextRef = useRef<AudioContext | null>(null);
  const assistantSpeechTimeoutRef = useRef<number | null>(null);
  const assistantFinalizeTimeoutRef = useRef<number | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const playbackGainRef = useRef<GainNode | null>(null);

  const micLevelTimeoutRef = useRef<number | null>(null);
  const assistantLevelTimeoutRef = useRef<number | null>(null);
  const assistantSpeakingRef = useRef(false);
  const greetingTurnActiveRef = useRef(false);
  const silenceFrameCountRef = useRef(0);
  const hadUserSpeechRef = useRef(false);
  const userSpeechActiveRef = useRef(false);
  const consecutiveSpeechFramesRef = useRef(0);
  const followUpPromptActiveRef = useRef(false);
  // True from the moment the follow-up prompt is triggered until its audio
  // finishes playing, marking that the next "assistant done speaking" event
  // should start the closing countdown rather than just settle silently.
  const followUpAwaitingCountdownRef = useRef(false);
  const followUpAttemptCountRef = useRef(0);
  const followUpCountdownCeilingTimerRef = useRef<number | null>(null);
  const inactivityTimerRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  useEffect(() => {
    assistantSpeakingRef.current = assistantSpeaking;
  }, [assistantSpeaking]);
  useEffect(() => {
    awaitingResponseRef.current = awaitingResponse;
  }, [awaitingResponse]);

  const suppressAssistantAudioRef = useRef(false);
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
    // Playback was cut short (barge-in/interrupt); the follow-up prompt, if
    // any was in flight, never finished, so don't start a countdown for it.
    followUpAwaitingCountdownRef.current = false;
    clearFollowUpCountdownCeiling();
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

  function appendTranscript(role: TranscriptEntry["role"], content: string) {
    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return;
    }
    setTranscriptLog((current) => {
      const lastEntry = current[current.length - 1];
      if (lastEntry && lastEntry.role === role) {
        return [
          ...current.slice(0, -1),
          { ...lastEntry, content: joinTranscriptContent(lastEntry.content, normalizedContent) },
        ];
      }
      return [
        ...current,
        { id: `${role}-${Date.now()}-${current.length}`, role, content: normalizedContent },
      ];
    });
  }

  function scheduleAssistantReplyFinalize() {
    if (assistantFinalizeTimeoutRef.current) {
      window.clearTimeout(assistantFinalizeTimeoutRef.current);
    }
    assistantFinalizeTimeoutRef.current = window.setTimeout(() => {
      setAwaitingResponse(false);
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
    stopSensitiveSpeechMonitor();
  }

  function startSensitiveSpeechMonitor() {
    const RecognitionCtor = getSpeechRecognitionCtor();
    if (!RecognitionCtor) {
      logVoiceState("sensitive-data voice monitor unavailable: browser lacks SpeechRecognition");
      return;
    }
    try {
      const recognition = new RecognitionCtor();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        let combined = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          combined += event.results[index][0]?.transcript ?? "";
        }
        if (!combined.trim() || sensitiveBlockedRef.current) {
          return;
        }
        const findings = scanForSensitiveData(combined);
        if (findings.length > 0) {
          sensitiveBlockedRef.current = true;
          logSensitiveDataBlocked(findings, { app: "voice-console", channel: "voice" });
          setError(SENSITIVE_DATA_BLOCK_MESSAGE);
        }
      };
      recognition.onerror = () => {
        // Local safety net only - failures here don't affect the live
        // session; the backend transcript gate remains as defense in depth.
      };
      recognition.start();
      speechRecognitionRef.current = recognition;
    } catch {
      logVoiceState("failed to start sensitive-data voice monitor");
    }
  }

  function stopSensitiveSpeechMonitor() {
    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        // ignore
      }
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

  function stopAll(options: { releaseMicrophone?: boolean } = {}) {
    clearInactivityTimer();
    clearFollowUpCountdown();
    clearFollowUpCountdownCeiling();
    followUpAwaitingCountdownRef.current = false;
    stopCapture();
    resetPlayback();
    stopSession();
    setListeningState("idle");
    setAwaitingResponse(false);
    resetTurnDetection();
    greetingTurnActiveRef.current = false;
    followUpPromptActiveRef.current = false;
    followUpAttemptCountRef.current = 0;
    suppressAssistantAudioRef.current = false;
    consecutiveBargeInFramesRef.current = 0;
    if (options.releaseMicrophone) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
  }

  function resetTurnDetection() {
    silenceFrameCountRef.current = 0;
    hadUserSpeechRef.current = false;
    userSpeechActiveRef.current = false;
    consecutiveSpeechFramesRef.current = 0;
  }

  function logVoiceState(label: string, detail?: Record<string, unknown>) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug(`[voice-state] ${label}`, detail ?? {});
    }
  }

  function isIdleListeningNow() {
    return (
      liveSocketRef.current?.readyState === WebSocket.OPEN &&
      !assistantSpeakingRef.current &&
      !awaitingResponseRef.current &&
      !greetingTurnActiveRef.current &&
      !followUpPromptActiveRef.current
    );
  }

  function clearInactivityTimer() {
    if (inactivityTimerRef.current) {
      window.clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }
  }

  function clearFollowUpCountdown() {
    if (countdownIntervalRef.current) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setCountdownSeconds(null);
  }

  function clearFollowUpCountdownCeiling() {
    if (followUpCountdownCeilingTimerRef.current) {
      window.clearTimeout(followUpCountdownCeilingTimerRef.current);
      followUpCountdownCeilingTimerRef.current = null;
    }
  }

  // True while a follow-up cycle is currently in flight: the prompt is being
  // spoken, or the closing countdown is ticking. Re-arming the pre-prompt
  // timer during this window would race the countdown/close flow.
  function isFollowUpCycleInFlight() {
    return followUpAwaitingCountdownRef.current || countdownIntervalRef.current !== null;
  }

  // Arms the single 10s pre-prompt timer. Guarded by inactivityTimerRef so at
  // most one such timer exists at a time. Not a one-shot: if the user responds
  // and later goes idle again, or a prior follow-up cycle somehow never closed
  // the session, this fires again - the follow-up prompt is always allowed to
  // recover and retry closing rather than leaving the session stuck open.
  function armInactivityTimerIfIdle() {
    if (inactivityTimerRef.current || isFollowUpCycleInFlight() || !isIdleListeningNow()) {
      return;
    }
    logVoiceState("inactivity: 10s pre-prompt timer armed", { timeoutMs: INACTIVITY_TIMEOUT_MS });
    inactivityTimerRef.current = window.setTimeout(() => {
      inactivityTimerRef.current = null;
      triggerInactivityPrompt();
    }, INACTIVITY_TIMEOUT_MS);
  }

  // Any user interaction cancels whichever timer is currently pending: the
  // pre-prompt wait, or the post-prompt closing countdown.
  function registerUserInteraction(reason: string) {
    if (inactivityTimerRef.current || countdownIntervalRef.current) {
      logVoiceState("inactivity: user interaction detected, cancelling countdown", { reason });
    }
    clearInactivityTimer();
    clearFollowUpCountdown();
    // While the follow-up prompt is still playing, only a confirmed signal
    // (real barge-in, an "interrupted" event, or server-confirmed transcript
    // text) may cancel it. Plain mic-energy is too easily false-triggered by
    // background noise or the assistant's own voice bleeding into the mic
    // (no headphones/echo cancellation) during that window, and a false
    // cancel here would leave the follow-up cycle stranded with the
    // countdown never starting.
    if (reason !== "mic-energy") {
      followUpAwaitingCountdownRef.current = false;
      clearFollowUpCountdownCeiling();
    }
    if (reason === "input_transcript" || reason === "barge-in" || reason === "interrupted") {
      followUpAttemptCountRef.current = 0;
    }
  }

  function triggerInactivityPrompt() {
    if (isFollowUpCycleInFlight()) {
      return;
    }
    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      logVoiceState("inactivity: prompt skipped, socket not open");
      return;
    }
    followUpAttemptCountRef.current = Math.min(2, followUpAttemptCountRef.current + 1);
    logVoiceState(
      `inactivity: 10s idle elapsed, asking follow-up prompt attempt ${followUpAttemptCountRef.current}`,
    );
    followUpAwaitingCountdownRef.current = true;
    followUpPromptActiveRef.current = true;
    assistantSpeakingRef.current = true;
    setAssistantSpeaking(true);
    socket.send(
      JSON.stringify({
        type: "text",
        text:
          `Say "${inactivityFollowUpText}" and then wait for the user response. ` +
          "Say this in whatever language the conversation has been using so far, not English, " +
          "unless the conversation has genuinely been in English.",
      }),
    );
    clearFollowUpCountdownCeiling();
    followUpCountdownCeilingTimerRef.current = window.setTimeout(() => {
      followUpCountdownCeilingTimerRef.current = null;
      if (followUpAwaitingCountdownRef.current) {
        logVoiceState("inactivity: countdown ceiling reached, forcing countdown start");
        followUpAwaitingCountdownRef.current = false;
        startFollowUpCountdown();
      }
    }, FOLLOW_UP_COUNTDOWN_CEILING_MS);
  }

  // Starts the single visible countdown once the follow-up prompt has
  // actually finished playing. Ending at zero closes the session.
  function startFollowUpCountdown() {
    clearFollowUpCountdown();
    if (followUpAttemptCountRef.current >= 2) {
      logVoiceState("inactivity: second follow-up attempt finished, closing session immediately");
      followUpAwaitingCountdownRef.current = false;
      clearFollowUpCountdownCeiling();
      endConversationDueToInactivity();
      return;
    }
    logVoiceState("inactivity: follow-up finished, starting closing countdown", {
      seconds: FOLLOW_UP_COUNTDOWN_SECONDS,
    });
    let remaining = FOLLOW_UP_COUNTDOWN_SECONDS;
    setCountdownSeconds(remaining);
    countdownIntervalRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearFollowUpCountdown();
        endConversationDueToInactivity();
        return;
      }
      setCountdownSeconds(remaining);
    }, 1000);
  }

  function endConversationDueToInactivity() {
    logVoiceState("inactivity: countdown elapsed with no response, ending session");
    stopAll({ releaseMicrophone: true });
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
    greetingTurnActiveRef.current = false;
    followUpPromptActiveRef.current = false;
    assistantSpeakingRef.current = true;
    setAssistantSpeaking(true);
    if (assistantSpeechTimeoutRef.current) {
      window.clearTimeout(assistantSpeechTimeoutRef.current);
    }
    // Chunks are scheduled ahead of real-time (nextStartTimeRef can sit
    // several seconds in the future for a long sentence), so "settled" must
    // wait for the actual scheduled playback to finish, not just a fixed
    // delay after this chunk's data arrived over the socket.
    const remainingPlaybackMs = Math.max(0, (nextStartTimeRef.current - ctx.currentTime) * 1000);
    const settleDelayMs = remainingPlaybackMs + PLAYBACK_SETTLE_TAIL_MS;
    assistantSpeechTimeoutRef.current = window.setTimeout(() => {
      assistantSpeakingRef.current = false;
      setAssistantSpeaking(false);
      assistantSpeechTimeoutRef.current = null;
      logVoiceState("assistant audio playback settled");
      if (followUpAwaitingCountdownRef.current) {
        followUpAwaitingCountdownRef.current = false;
        clearFollowUpCountdownCeiling();
        startFollowUpCountdown();
      }
    }, settleDelayMs);
  }

  function handleLiveEvent(event: LiveServerEvent) {
    logVoiceState("live event", { type: event.type });
    switch (event.type) {
      case "ready":
        setConnectionState("connected");
        break;
      case "interrupted":
        suppressAssistantAudioRef.current = false;
        resetPlayback();
        greetingTurnActiveRef.current = false;
        followUpPromptActiveRef.current = false;
        registerUserInteraction("interrupted");
        setListeningState("listening");
        setAwaitingResponse(false);
        break;
      case "input_transcript":
        appendTranscript("user", event.text);
        if (event.text.trim()) {
          if (!hadUserSpeechRef.current) {
            logVoiceState("server confirmed real speech via input_transcript");
          }
          hadUserSpeechRef.current = true;
          silenceFrameCountRef.current = 0;
          registerUserInteraction("input_transcript");
        }
        break;
      case "output_transcript":
        appendTranscript("assistant", sanitizeAssistantText(event.text));
        scheduleAssistantReplyFinalize();
        if (suppressAssistantAudioRef.current) {
          suppressAssistantAudioRef.current = false;
          resetPlayback();
        }
        break;
      case "model_text":
        appendTranscript("assistant", sanitizeAssistantText(event.text));
        scheduleAssistantReplyFinalize();
        if (suppressAssistantAudioRef.current) {
          suppressAssistantAudioRef.current = false;
          resetPlayback();
        }
        break;
      case "turn_complete":
        greetingTurnActiveRef.current = false;
        followUpPromptActiveRef.current = false;
        if (assistantFinalizeTimeoutRef.current) {
          window.clearTimeout(assistantFinalizeTimeoutRef.current);
          assistantFinalizeTimeoutRef.current = null;
        }
        setAwaitingResponse(false);
        resetTurnDetection();
        // Safety net: if the follow-up turn completed without ever producing
        // audio, the playback-settle callback will never fire to start the
        // countdown. Start it here instead so the session still closes.
        if (followUpAwaitingCountdownRef.current && !assistantSpeechTimeoutRef.current) {
          followUpAwaitingCountdownRef.current = false;
          clearFollowUpCountdownCeiling();
          startFollowUpCountdown();
        }
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
      case "blocked":
        // Server-side backstop: catches sensitive speech the local
        // best-effort recognizer missed before Gemini transcribed it.
        setError(event.message);
        setAwaitingResponse(false);
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
      let opened = false;

      socket.onopen = () => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        opened = true;
        setConnectionState("connected");
        resolve();
      };

      socket.onmessage = (message) => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        try {
          handleLiveEvent(JSON.parse(message.data) as LiveServerEvent);
        } catch {
          // ignore
        }
      };

      socket.onclose = (event) => {
        if (liveSessionVersionRef.current !== sessionVersion) return;
        if (!opened) {
          reject(new Error("Gemini Live session closed before the connection opened."));
          return;
        }
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
    setConnectionState("connecting");
    setListeningState("listening");
    setAwaitingResponse(false);
    setTranscriptLog([]);
    resetTurnDetection();
    sensitiveBlockedRef.current = false;
    const resolvedWebsiteId = fixedWebsiteId;
    const stream = await ensureMicrophone();
    await ensureSession(resolvedWebsiteId);

    stopCapture();
    resetPlayback();

    const socket = liveSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Gemini Live session is not ready.");
    }

    socket.send(
      JSON.stringify({
        type: "text",
        text:
          `Say "${sessionGreetingText}" and then wait for the user response. ` +
          "This greeting is in English only for branding reasons and does not set or lock the " +
          "conversation's language - the moment the user replies, detect the language of that " +
          "reply on its own merits and respond in that language from then on, even though the " +
          "greeting was in English, and keep switching languages on every later turn to match " +
          "whatever the user speaks.",
      }),
    );
    greetingTurnActiveRef.current = true;
    assistantSpeakingRef.current = true;
    setAssistantSpeaking(true);

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

      if (assistantSpeakingRef.current || greetingTurnActiveRef.current || followUpPromptActiveRef.current) {
        if (micRms > bargeInThreshold) {
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
          suppressAssistantAudioRef.current = true;
          resetPlayback();
          const wasFollowUpPrompt = followUpPromptActiveRef.current;
          greetingTurnActiveRef.current = false;
          followUpPromptActiveRef.current = false;
          logVoiceState("barge-in detected, cutting assistant audio", { wasFollowUpPrompt });
          registerUserInteraction("barge-in");
          setListeningState("listening");
          setAwaitingResponse(false);
        }
      } else {
        consecutiveBargeInFramesRef.current = 0;
      }

      const speechThreshold = 0.012;
      const silenceThreshold = 0.006;
      const requiredSilenceFrames = 14;
      const requiredSpeechFrames = 3;
      const speechFrameActive = micRms > speechThreshold;

      if (speechFrameActive) {
        consecutiveSpeechFramesRef.current += 1;
      } else {
        consecutiveSpeechFramesRef.current = 0;
      }
      const speechActive = consecutiveSpeechFramesRef.current >= requiredSpeechFrames;

      if (speechActive) {
        userSpeechActiveRef.current = true;
        silenceFrameCountRef.current = 0;
        setAwaitingResponse(false);
        registerUserInteraction("mic-energy");
      } else if (userSpeechActiveRef.current && micRms < silenceThreshold) {
        silenceFrameCountRef.current += 1;
        if (hadUserSpeechRef.current && silenceFrameCountRef.current >= requiredSilenceFrames) {
          userSpeechActiveRef.current = false;
          silenceFrameCountRef.current = 0;
          logVoiceState("silence after real speech, awaiting response");
          setAwaitingResponse(true);
        }
      } else {
        armInactivityTimerIfIdle();
      }

      // Stream continuously for the whole session, like the debug console does.
      // Gemini Live's own server-side voice activity detection segments turns and
      // drives interruption; sending audio_end mid-conversation would close its
      // input stream early and silently drop audio sent right after a barge-in.
      // Skipped once the local sensitive-data monitor has fired, so no further
      // audio for this session reaches Gemini.
      if (!sensitiveBlockedRef.current) {
        socket.send(
          JSON.stringify({
            type: "audio_chunk",
            data: int16ToBase64(downsampled),
            mimeType: "audio/pcm;rate=16000",
          }),
        );
      }
    };

    source.connect(processor);
    processor.connect(audioContext.destination);

    captureContextRef.current = audioContext;
    sourceNodeRef.current = source;
    processorNodeRef.current = processor;

    startSensitiveSpeechMonitor();
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
        ? connectionState === "connecting"
          ? "Connecting..."
          : "Listening..."
        : "";
  const hintText = listeningState === "listening" || assistantSpeaking || awaitingResponse ? "Tap again to stop" : "";
  const isConversationActive = listeningState === "listening" || assistantSpeaking || awaitingResponse;
  const latestTranscriptEntry = transcriptLog[transcriptLog.length - 1];
  const buttonText = isConversationActive
    ? (latestTranscriptEntry?.content.trim() ?? "")
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
                  <div className="va-orb-wave" aria-hidden="true">
                    <div className="va-orb-wave-layer va-orb-wave-layer--back" />
                    <div className="va-orb-wave-layer va-orb-wave-layer--front" />
                  </div>
                  <div className="va-orb-badge">
                    <img className="va-orb-badge-logo" src={irasLogo} alt="IRAS logo" />
                  </div>
                </button>
              </div>
              <div className="va-wave-caption">
                <p className="va-state">{stateText}</p>
                {hintText ? <p className="va-hint">{hintText}</p> : null}
                {countdownSeconds !== null ? (
                  <p className="va-countdown" role="status" aria-live="assertive">
                    {`Session closing in ${countdownSeconds}...`}
                  </p>
                ) : null}
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

function sanitizeAssistantText(text: string) {
  return text.replace(/\s*\[\d+\]/g, "");
}

function joinTranscriptContent(current: string, next: string) {
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
