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

  const model = process.env.GOOGLE_TEXT_MODEL || env.GOOGLE_TEXT_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: "Say OK." }] }],
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    console.error(`Request failed: HTTP ${response.status}`);
    console.error(bodyText);
    if (
      response.status === 404 &&
      bodyText.includes("no longer available") &&
      bodyText.includes("update your code")
    ) {
      console.error(
        'Your API key responded, but the configured model is deprecated for your account. Try: GOOGLE_TEXT_MODEL="gemini-flash-latest"',
      );
    }
    process.exitCode = 2;
    return;
  }

  console.log(`OK: connected to Google Generative Language API using model "${model}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
