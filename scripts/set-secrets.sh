#!/usr/bin/env bash
set -euo pipefail

ZULIPRC="${1:-$HOME/.zuliprc}"

if [[ ! -f "$ZULIPRC" ]]; then
  echo "Error: $ZULIPRC not found" >&2
  echo "Usage: $0 [path/to/.zuliprc]" >&2
  exit 1
fi

read_ini() {
  local file="$1" key="$2"
  grep -E "^${key}\s*=" "$file" | head -1 | sed 's/^[^=]*=\s*//'
}

API_KEY=$(read_ini "$ZULIPRC" key)
EMAIL=$(read_ini "$ZULIPRC" email)
SITE=$(read_ini "$ZULIPRC" site)

[[ -z "$API_KEY" ]] && { echo "Error: key not found in $ZULIPRC" >&2; exit 1; }
[[ -z "$EMAIL"   ]] && { echo "Error: email not found in $ZULIPRC" >&2; exit 1; }
[[ -z "$SITE"    ]] && { echo "Error: site not found in $ZULIPRC" >&2; exit 1; }

echo "$API_KEY" | npx wrangler secret put ZULIP_API_KEY
echo "$EMAIL"   | npx wrangler secret put ZULIP_USERNAME
echo "$SITE"    | npx wrangler secret put ZULIP_REALM
