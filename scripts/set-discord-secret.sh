#!/usr/bin/env bash
set -euo pipefail

if [[ -t 0 ]]; then
  read -rsp "Discord bot token: " TOKEN
  echo
else
  TOKEN=$(cat)
fi

[[ -z "$TOKEN" ]] && { echo "Error: token is empty" >&2; exit 1; }

echo "$TOKEN" | npx wrangler secret put DISCORD_BOT_TOKEN
