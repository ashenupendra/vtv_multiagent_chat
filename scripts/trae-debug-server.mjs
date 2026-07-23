import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) {
      args.set(key.slice(2), value);
      i += 1;
    } else {
      args.set(key.slice(2), "1");
    }
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowMs() {
  return Date.now();
}

function writeEnvFile(outdir, sessionId, apiUrl) {
  ensureDir(outdir);
  const envFile = path.join(outdir, `${sessionId}.env`);
  fs.writeFileSync(
    envFile,
    `DEBUG_SERVER_URL=${apiUrl}\nDEBUG_SESSION_ID=${sessionId}\n`,
    "utf8",
  );
  return envFile;
}

function detectHost(remote) {
  if (remote) return "0.0.0.0";
  return "127.0.0.1";
}

function detectLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const [, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET, DELETE",
    "Access-Control-Allow-Headers": "Content-Type",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function main() {
  const args = parseArgs(process.argv);
  const sessionId = args.get("session");
  if (!sessionId) {
    // eslint-disable-next-line no-console
    console.error("Missing required --session <sessionId>");
    process.exit(1);
  }

  const outdir = args.get("outdir") ?? ".dbg";
  const clean = args.get("clean") === "1";
  const idleSeconds = Number(args.get("idle") ?? "0");
  const remote = args.get("remote") === "1";
  const startPort = Number(args.get("port") ?? "7777");

  ensureDir(outdir);
  const logFile = path.resolve(outdir, `trae-debug-log-${sessionId}.ndjson`);

  if (clean && fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, "", "utf8");
  }

  let lastEventAt = nowMs();
  let logCount = 0;

  const host = detectHost(remote);

  function tryListen(port, attempt = 0) {
    const server = http.createServer((req, res) => {
      if (req.method === "OPTIONS" && req.url === "/event") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/event") {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          lastEventAt = nowMs();
          try {
            const event = JSON.parse(raw || "{}");
            if (!event.ts) event.ts = nowMs();
            if (!event.sessionId) event.sessionId = sessionId;
            fs.appendFileSync(logFile, `${JSON.stringify(event)}\n`, "utf8");
            logCount += 1;
            sendJson(res, 200, { ok: true });
          } catch (error) {
            sendJson(res, 400, { ok: false, error: "invalid_json" });
          }
        });
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/health")) {
        sendJson(res, 200, {
          ok: true,
          sessionId,
          logCount,
          uptimeMs: process.uptime() * 1000,
        });
        return;
      }

      if (req.method === "GET" && req.url?.startsWith("/logs")) {
        const text = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
        sendJson(res, 200, {
          ok: true,
          sessionId,
          logFile,
          lines: text ? text.trimEnd().split("\n") : [],
        });
        return;
      }

      if (req.method === "DELETE" && req.url?.startsWith("/logs")) {
        fs.writeFileSync(logFile, "", "utf8");
        logCount = 0;
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not_found" });
    });

    server.on("error", (error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
        if (attempt >= 9) {
          // eslint-disable-next-line no-console
          console.error(`Port probing failed starting from ${startPort}`);
          process.exit(1);
        }
        tryListen(port + 1, attempt + 1);
        return;
      }
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    });

    server.listen(port, host, () => {
      const publicHost = remote ? detectLocalIp() : host;
      const apiUrl = `http://${publicHost}:${port}/event`;
      const envFile = writeEnvFile(outdir, sessionId, apiUrl);

      // eslint-disable-next-line no-console
      console.log("@@DEBUG_SERVER_INFO");
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            api_url: apiUrl,
            session_id: sessionId,
            log_dir: path.resolve(outdir),
            log_file: logFile,
            env_file: path.resolve(envFile),
          },
          null,
          2,
        ),
      );
      // eslint-disable-next-line no-console
      console.log("@@END_DEBUG_SERVER_INFO");

      if (idleSeconds > 0) {
        const timer = setInterval(() => {
          if (nowMs() - lastEventAt > idleSeconds * 1000) {
            clearInterval(timer);
            server.close(() => process.exit(0));
          }
        }, 1000);
        timer.unref();
      }
    });
  }

  tryListen(startPort);
}

main();

