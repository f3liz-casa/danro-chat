# danro-chat

Async web chat widget that bridges website visitors to your team's
[Zulip](https://zulip.com/) or [Discord](https://discord.com/) — with
Japanese and Korean UI, designed for community sites that can't (or don't
want to) be online 24/7.

Drop one `<script>` and one `<danro-talk>` element into a page; replies show
up in your team chat as a topic / thread. Your team replies there, the
visitor sees it in the widget. No third-party SaaS, no per-seat pricing.

```html
<!-- Zulip-backed widget (ws-url auto-detected when loaded from the same Worker) -->
<script type="module" src="https://danro-api.atfedi.de/widget.js"></script>
<danro-talk site-id="zl_xxxxxxxxxxxx" lang="ja"></danro-talk>

<!-- Discord-backed widget -->
<danro-talk site-id="dc_xxxxxxxxxxxx" lang="ko" target="discord"></danro-talk>
```

## What's in the box

- **Web Component widget** (vanilla, Shadow DOM, ~9 KB minified) — embeds anywhere
- **Bilingual UI** — `lang="ja"` / `lang="ko"`, with culturally adapted phrasing
- **Async-first UX** — encourages bundled questions, sets honest expectations about reply time
- **Visitor identity** — nickname required at entry, optional email for future notifications
- **Resume** — past conversation history loaded from the backing platform on reconnect
- **Custom emoji** — Zulip realm emoji and Discord guild emoji render inline in the widget
- **Topic naming** — `MM-DD [locale] nickname`; visitor ID posted as first message for traceability
- **Topic rename** — rename from Zulip / Discord side; widget updates in real-time

## Why

Existing chat widgets (Intercom, Crisp, etc.) assume an agent is always
on. For a small community site — a fediverse instance, a personal project —
that's a poor fit. You want visitor messages to land somewhere your team
already hangs out (Zulip / Discord), and you want the widget to set
expectations that replies take hours, not seconds. That's what this is.

## Architecture

```
widget (browser, Web Component)
   ↓  WebSocket
Cloudflare Worker → Durable Object (ChatServer)
   ├── ZulipAdapter  — event-queue polling, DM bot commands
   └── DiscordAdapter — Gateway WebSocket, slash commands, webhook send
         ↓
Zulip topic  /  Discord thread  (one per conversation)
```

Conversations and config are persisted in Durable Object storage.
The Discord Gateway connection is kept alive via a Durable Object Alarm
chain (20-second interval).

## Deploy your own

### Prerequisites

- Cloudflare account (free plan works)
- Zulip bot credentials and/or Discord bot token

### 1. Clone & install

```sh
git clone https://github.com/yourname/danro-talk
cd danro-talk
npm install
```

### 2. Configure Cloudflare

```sh
# Zulip credentials (read from ~/.zuliprc)
./scripts/set-secrets.sh

# Discord bot token (optional)
./scripts/set-discord-secret.sh
```

### 3. Deploy

```sh
npm run deploy
```

The worker is deployed to `your-worker.workers.dev`. To use a custom domain,
add it to `wrangler.toml`:

```toml
[[routes]]
pattern = "your-domain.example.com"
custom_domain = true
```

### 4. Configure via bot DM (Zulip)

Send DMs to your Zulip bot (admin only):

| Command | What it does |
|---|---|
| `set-stream <name>` | Set the stream for visitor messages |
| `show` | Display current config and siteId |
| `set-origin <domains>` | Comma-separated origin allowlist; empty to clear |
| `rotate-id` | Issue a new siteId; old widgets stop working |

On first start the bot auto-generates a siteId. Run `show` to retrieve it.

### 5. Configure via slash command (Discord)

Run `/danro set-channel #your-channel` in your server (requires Manage Server).
The bot responds with the siteId and embed snippet.

| Command | What it does |
|---|---|
| `/danro set-channel <channel>` | Set parent channel; issues siteId |
| `/danro show` | Display current channel, siteId, allowed origins |
| `/danro set-origin <domains>` | Comma-separated allowlist; empty to clear |
| `/danro rotate-id` | Issue a new siteId; old widgets break, sessions close |
| `/danro disable` | Remove configuration; active sessions close |

### 6. Embed the widget

```html
<script type="module" src="https://your-worker.workers.dev/widget.js"></script>

<!-- Zulip -->
<danro-talk site-id="zl_xxxxxxxxxxxx" lang="ja"></danro-talk>

<!-- Discord -->
<danro-talk site-id="dc_xxxxxxxxxxxx" lang="ko" target="discord"></danro-talk>
```

`ws-url` is optional — the widget auto-connects to the origin it was loaded from.

## Local development

```sh
cp .env .dev.vars   # or: ln -s .env .dev.vars
npm run dev         # wrangler dev on :8787
npm run dev:widget  # rebuild widget on change
open widget/demo.html
```

## Security model

The siteId is **public** (it lives in your site's HTML), so think of it as a
routing token, not a secret:

1. **Origin allowlist** (strongest) — once set, the server checks the
   browser-supplied `Origin` header on every WebSocket handshake. Browsers
   can't forge `Origin`, blocking casual embedding abuse.
2. **siteId** — filters out misconfigured clients and accidental embeds.
3. **Rotate** — incident response: rotate the siteId and old copies stop
   working immediately.
4. **Disable** (Discord) — kill switch; configuration deleted, sessions closed.

## Roadmap

- **Email notification + resume tokens** — send the visitor a mail when an
  agent replies, with a signed link to resume the session.
- **Rate limiting / abuse controls** — per-IP throttling, agent-side block
  command, and an audit log.
- **Self-hosted Twemoji** — remove the jsDelivr CDN dependency.

## License

MIT. See [LICENSE](LICENSE).
