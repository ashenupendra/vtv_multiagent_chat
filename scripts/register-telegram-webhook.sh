#!/usr/bin/env bash
# Registers (or re-registers) the Telegram webhook against a given public
# base URL. Same command for dev (a cloudflared tunnel URL) or production
# (your real domain) - only the URL argument changes.
#
# Usage:
#   ./scripts/register-telegram-webhook.sh https://your-domain-or-tunnel-url
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <public-base-url>" >&2
  echo "Example (dev tunnel):  $0 https://marsh-arkansas-mount-questions.trycloudflare.com" >&2
  echo "Example (production):  $0 https://api.yoursite.com" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "No .env file found at $ENV_FILE" >&2
  exit 1
fi

BOT_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
WEBHOOK_SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' "$ENV_FILE" | cut -d= -f2-)

if [ -z "$BOT_TOKEN" ]; then
  echo "TELEGRAM_BOT_TOKEN is not set in .env" >&2
  exit 1
fi
if [ -z "$WEBHOOK_SECRET" ]; then
  echo "TELEGRAM_WEBHOOK_SECRET is not set in .env" >&2
  exit 1
fi

BASE_URL="${1%/}"
WEBHOOK_URL="${BASE_URL}/api/telegram/webhook"

echo "Registering Telegram webhook: ${WEBHOOK_URL}"
curl -sS -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=${WEBHOOK_URL}" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}"
echo
