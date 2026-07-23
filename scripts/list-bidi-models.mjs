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

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    method: "GET",
    headers: {
      "X-goog-api-key": apiKey,
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`Request failed: HTTP ${response.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exitCode = 2;
    return;
  }

  const models = Array.isArray(body.models) ? body.models : [];
  const configuredLiveModel = env.GOOGLE_LIVE_MODEL;

  const liveCandidates = models
    .filter((model) => typeof model?.name === "string" && model.name.includes("live"))
    .map((model) => ({
      name: model.name,
      methods: Array.isArray(model.supportedGenerationMethods)
        ? model.supportedGenerationMethods
        : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`Configured GOOGLE_LIVE_MODEL: ${configuredLiveModel || "(not set)"}`);

  if (!liveCandidates.length) {
    console.log('No models with "live" in the name were returned by /v1beta/models for this API key.');
    return;
  }

  console.log('Models with "live" in name:');
  for (const model of liveCandidates) {
    const methods = model.methods.length ? model.methods.join(", ") : "(no methods listed)";
    console.log(`- ${model.name}  methods=${methods}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
