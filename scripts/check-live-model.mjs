import fs from "node:fs";
import path from "node:path";

function parseDotEnv(raw) {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) continue;
    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    env[key] = value;
  }
  return env;
}

function getCandidates(env) {
  const defaults = [
    "gemini-live-2.5-flash-native-audio",
    "gemini-3.1-flash-live-preview",
    "gemini-3.1-flash-live",
    "gemini-2.0-flash-live-001",
  ];

  const raw = process.env.GOOGLE_LIVE_MODEL_CANDIDATES;
  const fromEnv = raw
    ? raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  const configured = env.GOOGLE_LIVE_MODEL ? [env.GOOGLE_LIVE_MODEL.trim()] : [];

  return Array.from(new Set([...fromEnv, ...configured, ...defaults])).filter(Boolean);
}

function tryModel({ apiKey, model, timeoutMs }) {
  return new Promise((resolve) => {
    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
      `?key=${encodeURIComponent(apiKey)}`;

    const socket = new WebSocket(url);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore
      }
      resolve({ model, ok: false, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    socket.onopen = () => {
      const modality = process.env.LIVE_RESPONSE_MODALITY || "TEXT";
      const voiceName = process.env.GOOGLE_TTS_VOICE
        ? process.env.GOOGLE_TTS_VOICE.split("-").at(-1)
        : undefined;
      socket.send(
        JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: [modality],
              ...(modality === "AUDIO" && voiceName
                ? {
                    speechConfig: {
                      voiceConfig: {
                        prebuiltVoiceConfig: {
                          voiceName,
                        },
                      },
                    },
                  }
                : {}),
            },
            systemInstruction: {
              parts: [{ text: "Say OK." }],
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        }),
      );
    };

    function handleRawMessage(raw) {
      if (settled) return;
      if (process.env.LIVE_LOG_FIRST_MESSAGE === "1") {
        console.log(`MESSAGE(${model}): ${raw.slice(0, 400)}`);
      }
      try {
        const payload = JSON.parse(raw);
        if (payload?.setupComplete) {
          settled = true;
          clearTimeout(timeout);
          socket.close();
          resolve({ model, ok: true });
        }
      } catch {
        // ignore
      }
    }

    socket.onmessage = (event) => {
      if (settled) return;
      const data = event.data;
      if (data && typeof data === "object" && typeof data.text === "function") {
        data
          .text()
          .then((text) => handleRawMessage(text))
          .catch(() => {});
        return;
      }
      handleRawMessage(String(data));
    };

    socket.onclose = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        model,
        ok: false,
        error: `closed code=${event.code} reason=${event.reason || "no reason provided"}`,
      });
    };

    socket.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ model, ok: false, error: "websocket error" });
    };
  });
}

async function main() {
  const envPath = path.resolve(process.cwd(), ".env");
  const envRaw = fs.readFileSync(envPath, "utf-8");
  const env = parseDotEnv(envRaw);

  const apiKey = env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error("GOOGLE_API_KEY is missing in .env");
    process.exitCode = 1;
    return;
  }

  if (typeof WebSocket === "undefined") {
    console.error("This Node.js runtime does not provide a global WebSocket.");
    process.exitCode = 1;
    return;
  }

  const candidates = getCandidates(env);
  const timeoutMs = Number(process.env.LIVE_TIMEOUT_MS || 8000);
  for (const model of candidates) {
    const result = await tryModel({ apiKey, model, timeoutMs });
    if (result.ok) {
      console.log(`OK: Live model works: ${model}`);
      return;
    }
    console.log(`FAIL: ${model} -> ${result.error}`);
  }

  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
