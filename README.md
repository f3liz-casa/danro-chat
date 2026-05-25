# danro-chat

Async web chat widget that bridges website visitors to your team's
[Zulip](https://zulip.com/) or [Discord](https://discord.com/) — with
Japanese and Korean UI, designed for community sites that can't (or don't
want to) be online 24/7.

Drop one `<script>` and one `<danro-talk>` element into a page; replies show
up in your team chat as a topic / thread. Your team replies there, the
visitor sees it in the widget. No third-party SaaS, no per-seat pricing.

```html
<danro-talk ws-url="wss://chat.example.org" lang="ja"></danro-talk>
<script type="module" src="https://cdn.example.org/chat-widget.js"></script>
```

## What's in the box

- **Web Component widget** (vanilla, Shadow DOM, ~9KB minified) — embeds anywhere
- **Bilingual UI** — `lang="ja"` / `lang="ko"`, with culturally adapted phrasing (not literal translation)
- **Adapter abstraction** — `target="zulip"` or `target="discord"`, picked per-site
- **Async-first UX** — encourages bundled questions, sets honest expectations about reply time
- **Visitor identity** — nickname required at entry, optional email for future notifications
- **Resume** — past conversation history loaded from the backing platform on reconnect
- **Custom emoji** — Zulip realm emoji and Discord guild emoji render inline in the widget

## Why

Existing chat widgets (Intercom, Crisp, etc.) assume an agent is always
on. For a small community site — a fediverse instance, a personal project —
that's a poor fit. You want visitor messages to land somewhere your team
already hangs out (Zulip / Discord), and you want the widget to set
expectations that replies take hours, not seconds. That's what this is.

## Quick start (development)

```sh
cp .env.example .env  # fill in ZULIP_* (and DISCORD_* if you want that adapter)
npm install
npm run dev           # starts WS server on :3000
npm run build:widget  # bundles widget/chat-widget.js
python3 -m http.server -d widget 8080   # serve widget/demo.html
open http://localhost:8080/demo.html
```

The demo shows side-by-side JP (→ Zulip) and KO (→ Discord) widgets.

### Zulip setup

1. Create a Generic Bot in your Zulip realm; download its `zuliprc`
2. Create a stream (the env default is `web-相談`); subscribe the bot
3. Put `ZULIP_REALM` / `ZULIP_USERNAME` / `ZULIP_API_KEY` / `ZULIP_STREAM` into `.env`

### Discord setup

1. Create a Discord application + bot; **enable the MESSAGE CONTENT privileged intent**
2. Invite the bot with scopes `bot applications.commands` and the following
   permissions: `View Channels`, `Send Messages`, `Send Messages in Threads`,
   `Create Public Threads`, `Manage Threads`, `Read Message History`,
   `Manage Webhooks`
3. Put `DISCORD_BOT_TOKEN` into `.env` and start the server
4. In Discord, run `/danro set-channel #your-channel` (admins only) — the bot
   will auto-create a webhook in that channel and persist the config

Visitor messages are posted via webhook with the visitor's nickname as the
sender's display name — so in Discord they look like real people, not bot
output.

Slash commands (require `Manage Server` permission by default):

- `/danro set-channel <channel>` — pick the parent text channel
- `/danro show` — show current configuration
- `/danro disable` — remove configuration

## Architecture

```
widget (browser, Web Component)
   ↓  WebSocket (visitor identity, messages)
server (Node + tsx)
   ↓  Adapter ({zulip, discord}.send / fetchHistory / subscribe / emojis)
Zulip topic  /  Discord thread (one per conversation)
```

Conversations are persisted in `data/conversations.json`. Topics are named
`[ja] nickname (idHead)` so agents can see the visitor's language at a
glance and identify the conversation by its short id.

The adapter interface lives in [`src/adapter.ts`](src/adapter.ts). Adding a
new platform means writing one file that implements `Adapter`.

## Production: Cloudflare Workers + Durable Objects

The node implementation is meant to be straightforward to port. The plan:

- `src/zulip.ts` — replace `zulip-js` with a fetch-based mini-SDK (~150 lines);
  long-poll loop runs inside a Durable Object
- `src/discord.ts` — REST calls already use `fetch`; the Gateway WS portion
  swaps to [`discord-gateway-cloudflare-do`](https://github.com/dcartertwo/discord-gateway-cloudflare-do)
- `src/conversations.ts` — JSON-on-disk swaps to DO storage; one DO per conversation
- `src/server.ts` — `ws` swaps to CF Worker WebSocket Hibernation
- Email out: Resend / Postmark via fetch

The adapter shape is the boundary. Nothing else in the server cares.

## License

MIT. See [LICENSE](LICENSE).
