# Deployment: dev vs production

Same codebase, same containers. Switching environments only changes *which
compose files you run* and *which URL you register with Telegram* — nothing
in the app itself needs to change.

## Dev (what you're running now)

```bash
docker compose up -d --build
```

Orchestrator is directly reachable at `http://localhost:8000`. To let
Telegram reach it, use a temporary tunnel:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:8000
```

Then register the URL it prints:

```bash
./scripts/register-telegram-webhook.sh https://<the-tunnel-url>.trycloudflare.com
```

The tunnel URL changes every time you start it — re-run the script after
every restart. Stop `cloudflared` when you're done testing; that kills the
public URL entirely.

## Production

**One-time setup on the server:**

1. Point DNS for your domain (e.g. `api.yoursite.com`) at the server's IP.
2. In `.env` on that server, set `PUBLIC_DOMAIN=api.yoursite.com`.
3. Rotate `TELEGRAM_WEBHOOK_SECRET` to a new value (the dev one was used
   over a public tunnel) and keep the strong `ADMIN_DEFAULT_PASSWORD`.

**Every deploy:**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The `-prod` overlay adds a Caddy reverse proxy (automatic HTTPS via Let's
Encrypt) and stops publishing the orchestrator's port directly to the
internet — only Caddy (ports 80/443) is public.

**Register the webhook once** (stable domain, no need to repeat this on
every restart, unlike dev):

```bash
./scripts/register-telegram-webhook.sh https://api.yoursite.com
```

## WhatsApp (via Twilio)

Same underlying setup as Telegram - same tunnel/domain, same orchestrator,
different webhook path and a different way to register it.

1. In the [Twilio console](https://console.twilio.com), get
   `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` and put them in `.env`, along
   with `WHATSAPP_WEBSITE_ID`.
2. For testing: join the WhatsApp Sandbox (Messaging → Try it out → Send a
   WhatsApp message), then under Sandbox Settings paste your webhook URL
   into **"WHEN A MESSAGE COMES IN"**:
   ```
   https://<your-public-url>/api/whatsapp/webhook
   ```
   (dev: the cloudflared tunnel URL; prod: `https://api.yoursite.com`)
3. There's no API call for this step (unlike Telegram's `setWebhook`) - it's
   set directly in the Twilio console UI, both for the sandbox and later for
   a real approved WhatsApp business number.
4. Production: rotate nothing extra here - `TWILIO_AUTH_TOKEN` is what
   verifies incoming requests are really from Twilio (equivalent to
   Telegram's webhook secret), so just keep it out of source control same as
   the other secrets in `.env`.

## What's different between them

| | Dev | Production |
|---|---|---|
| Public URL | temporary tunnel (`cloudflared`) | your real domain via Caddy |
| Orchestrator port 8000 | published to host | bound to `127.0.0.1` only |
| HTTPS | tunnel provides it | Caddy auto-provisions via Let's Encrypt |
| Webhook re-registration | every tunnel restart | once |

## Already in place for both

- `restart: unless-stopped` on every service — containers come back after a
  reboot or crash without manual intervention.
- Rate limiting (`RATE_LIMIT_REQUESTS_PER_MINUTE` in `.env`) on the public
  chat/route/login endpoints, to limit abuse cost once a URL is public.
- The sensitive-data filter on all Text/Voice Chat, Telegram, and WhatsApp
  traffic (never on Admin Portal).

## Not yet covered (only matters if you scale beyond one server)

- Admin Portal / Web Chat / Voice Console aren't behind Caddy/HTTPS yet —
  only the orchestrator API is, since that's what Telegram needs. Same
  pattern (another site block in the Caddyfile) extends to them later.
- Rate limiting is in-memory and per-process; if the orchestrator ever runs
  as multiple replicas behind a load balancer, that needs a shared store
  (e.g. Redis) instead.
