import "dotenv/config";
import { WebSocketServer, type WebSocket } from "ws";
import type { Adapter, Target } from "./adapter.js";
import { attach, detach, ensureTopic, getByTopic, setEmail, setNickname, type Conversation } from "./conversations.js";
import type { IncomingMessage } from "node:http";
import { discordAdapter, setOnDisable, validateDiscordHello } from "./discord.js";
import { zulipAdapter } from "./zulip.js";

type ClientHello = { type: "hello"; visitorId?: string; locale?: string; target?: Target; siteId?: string };
type ClientMessage = { type: "message"; text: string };
type ClientSetNickname = { type: "set_nickname"; nickname: string; email?: string | null };
type ClientFrame = ClientHello | ClientMessage | ClientSetNickname;

type ServerWelcome = { type: "welcome"; visitorId: string; nickname: string | null; email: string | null; returning: boolean; hasHistory: boolean; emojis: Record<string, string> };
type ServerNicknameUpdated = { type: "nickname_updated"; nickname: string | null; email: string | null };
type ServerMessage = { type: "message"; from: "visitor" | "agent"; text: string; ts: number; senderName?: string };
type ServerHistoryEnd = { type: "history_end" };
type ServerError = { type: "error"; reason: string };
type ServerFrame = ServerWelcome | ServerNicknameUpdated | ServerMessage | ServerHistoryEnd | ServerError;

const PORT = Number(process.env.PORT ?? 3000);

const adapters: Partial<Record<Target, Adapter>> = {
  zulip: zulipAdapter,
};
if (process.env.DISCORD_BOT_TOKEN) {
  adapters.discord = discordAdapter;
}

function adapterFor(target: Target): Adapter {
  const a = adapters[target];
  if (!a) throw new Error(`no adapter registered for target=${target}`);
  return a;
}

const emojiByTarget: Partial<Record<Target, Record<string, string>>> = {};
for (const [target, adapter] of Object.entries(adapters) as [Target, Adapter][]) {
  try {
    emojiByTarget[target] = await adapter.emojis();
    console.log(`[${target}] loaded ${Object.keys(emojiByTarget[target]!).length} custom emoji`);
  } catch (e) {
    console.error(`[${target}:emoji]`, e);
    emojiByTarget[target] = {};
  }
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[ws] listening on :${PORT}`);

const discordSessions = new Set<WebSocket>();

setOnDisable(() => {
  for (const ws of discordSessions) {
    try {
      send(ws, { type: "error", reason: "service_unavailable" });
      ws.close(1001, "discord disabled");
    } catch {
      // ignore
    }
  }
  discordSessions.clear();
});

wss.on("connection", (ws, req: IncomingMessage) => {
  let conv: Conversation | null = null;
  const origin = req.headers.origin;

  ws.on("message", async (raw) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw.toString()) as ClientFrame;
    } catch {
      send(ws, { type: "error", reason: "invalid_json" });
      return;
    }

    if (frame.type === "hello") {
      const target: Target = frame.target ?? "zulip";
      if (!adapters[target]) {
        send(ws, { type: "error", reason: "unknown_target" });
        return;
      }
      if (target === "discord") {
        const result = validateDiscordHello(frame.siteId, origin);
        if (!result.ok) {
          send(ws, { type: "error", reason: result.reason });
          ws.close(1008, result.reason);
          return;
        }
        discordSessions.add(ws);
      }
      const { conv: c, returning } = attach(frame.visitorId ?? null, ws, target, frame.locale);
      conv = c;
      const hasHistory = returning && !!c.topic;
      send(ws, {
        type: "welcome",
        visitorId: c.visitorId,
        nickname: c.nickname,
        email: c.email,
        returning,
        hasHistory,
        emojis: emojiByTarget[c.target] ?? {},
      });
      if (hasHistory) {
        try {
          const history = await adapterFor(c.target).fetchHistory(c.topic);
          for (const m of history) {
            send(ws, { type: "message", from: m.from, text: m.text, ts: m.ts, senderName: m.senderName });
          }
        } catch (e) {
          console.error(`[${c.target}:history]`, e);
        }
        send(ws, { type: "history_end" });
      }
      return;
    }

    if (frame.type === "set_nickname") {
      if (!conv) {
        send(ws, { type: "error", reason: "not_attached" });
        return;
      }
      const updated = setNickname(conv.visitorId, frame.nickname);
      if (updated && frame.email !== undefined) setEmail(conv.visitorId, frame.email);
      if (updated) send(ws, { type: "nickname_updated", nickname: updated.nickname, email: updated.email });
      return;
    }

    if (frame.type === "message") {
      if (!conv) {
        send(ws, { type: "error", reason: "not_attached" });
        return;
      }
      if (!conv.nickname) {
        send(ws, { type: "error", reason: "no_nickname" });
        return;
      }
      const text = frame.text.trim();
      if (!text) return;
      const topic = ensureTopic(conv.visitorId);
      if (!topic) {
        send(ws, { type: "error", reason: "no_topic" });
        return;
      }
      send(ws, { type: "message", from: "visitor", text, ts: Date.now() });
      try {
        await adapterFor(conv.target).send(topic, { nickname: conv.nickname, locale: conv.locale }, text);
      } catch (e) {
        console.error(`[${conv.target}:send]`, e);
        send(ws, { type: "error", reason: "send_failed" });
      }
    }
  });

  ws.on("close", () => {
    discordSessions.delete(ws);
    if (conv) detach(conv.visitorId);
  });
});

for (const [target, adapter] of Object.entries(adapters) as [Target, Adapter][]) {
  await adapter.subscribe((m) => {
    const c = getByTopic(target, m.topic);
    if (!c || !c.ws) return;
    send(c.ws, {
      type: "message",
      from: "agent",
      text: m.text,
      ts: Date.now(),
      senderName: m.senderName,
    });
  });
  console.log(`[${target}] subscribed`);
}
