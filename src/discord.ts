import { WebSocket as WSClient } from "ws";
import type { Adapter, HistoryMessage, InboundMessage } from "./adapter.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const PARENT_CHANNEL_ID = process.env.DISCORD_PARENT_CHANNEL_ID ?? "";
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL ?? "";
const GUILD_ID = process.env.DISCORD_GUILD_ID ?? "";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

const threadByName = new Map<string, string>();
const threadById = new Map<string, string>();
let botUserId: string | null = null;

type DiscordMessage = {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
  webhook_id?: string;
};

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function loadActiveThreads(): Promise<void> {
  if (!GUILD_ID) return;
  const res = await api(`/guilds/${GUILD_ID}/threads/active`);
  if (!res.ok) return;
  const data = (await res.json()) as { threads: Array<{ id: string; name: string; parent_id: string }> };
  for (const t of data.threads) {
    if (t.parent_id !== PARENT_CHANNEL_ID) continue;
    threadByName.set(t.name, t.id);
    threadById.set(t.id, t.name);
  }
}

async function ensureThread(name: string): Promise<string> {
  const cached = threadByName.get(name);
  if (cached) return cached;
  const res = await api(`/channels/${PARENT_CHANNEL_ID}/threads`, {
    method: "POST",
    body: JSON.stringify({ name, type: 11, auto_archive_duration: 1440 }),
  });
  if (!res.ok) throw new Error(`thread create failed: ${res.status} ${await res.text()}`);
  const thread = (await res.json()) as { id: string };
  threadByName.set(name, thread.id);
  threadById.set(thread.id, name);
  return thread.id;
}

function connectGateway(onMessage: (m: DiscordMessage) => void): void {
  const ws = new WSClient(GATEWAY);
  let heartbeat: NodeJS.Timeout | null = null;
  let seq: number | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  ws.on("message", (raw) => {
    const payload = JSON.parse(raw.toString()) as { op: number; d: any; s: number | null; t: string | null };
    if (payload.s !== null && payload.s !== undefined) seq = payload.s;

    if (payload.op === 10) {
      heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), payload.d.heartbeat_interval);
      const intents = (1 << 0) | (1 << 9) | (1 << 15); // GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: BOT_TOKEN,
          intents,
          properties: { os: "linux", browser: "danro-talk", device: "danro-talk" },
        },
      }));
      return;
    }

    if (payload.op === 0) {
      if (payload.t === "READY") botUserId = payload.d.user?.id ?? null;
      if (payload.t === "MESSAGE_CREATE") onMessage(payload.d as DiscordMessage);
      if (payload.t === "THREAD_CREATE") {
        const t = payload.d as { id: string; name: string; parent_id: string };
        if (t.parent_id === PARENT_CHANNEL_ID) {
          threadByName.set(t.name, t.id);
          threadById.set(t.id, t.name);
        }
      }
      return;
    }

    if (payload.op === 7 || payload.op === 9) {
      ws.close();
    }
  });

  ws.on("close", () => {
    stopHeartbeat();
    setTimeout(() => connectGateway(onMessage), 5000);
  });

  ws.on("error", (e) => {
    console.error("[discord:gateway]", e);
  });
}

export const discordAdapter: Adapter = {
  target: "discord",

  async send(topic, sender, text) {
    if (!WEBHOOK_URL) throw new Error("DISCORD_WEBHOOK_URL not configured");
    const threadId = await ensureThread(topic);
    const url = new URL(WEBHOOK_URL);
    url.searchParams.set("thread_id", threadId);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: sender.nickname,
        content: text,
        allowed_mentions: { parse: [] },
      }),
    });
    if (!res.ok) throw new Error(`webhook send failed: ${res.status} ${await res.text()}`);
  },

  async fetchHistory(topic): Promise<HistoryMessage[]> {
    const threadId = threadByName.get(topic);
    if (!threadId) return [];
    const res = await api(`/channels/${threadId}/messages?limit=50`);
    if (!res.ok) return [];
    const messages = (await res.json()) as DiscordMessage[];
    return messages.reverse().map((m) => ({
      from: m.webhook_id ? ("visitor" as const) : ("agent" as const),
      text: m.content,
      ts: new Date(m.timestamp).getTime(),
      senderName: m.author?.username ?? "unknown",
    }));
  },

  async subscribe(onMessage: (m: InboundMessage) => void): Promise<void> {
    if (!BOT_TOKEN || !PARENT_CHANNEL_ID) {
      console.warn("[discord] BOT_TOKEN or PARENT_CHANNEL_ID missing — skipping subscribe");
      return;
    }
    await loadActiveThreads();
    connectGateway((msg) => {
      if (msg.webhook_id) return;
      if (msg.author?.bot) return;
      if (botUserId && msg.author?.id === botUserId) return;
      const topic = threadById.get(msg.channel_id);
      if (!topic) return;
      onMessage({
        topic,
        senderName: msg.author?.username ?? "unknown",
        text: msg.content ?? "",
      });
    });
  },

  async emojis(): Promise<Record<string, string>> {
    if (!GUILD_ID) return {};
    const res = await api(`/guilds/${GUILD_ID}/emojis`);
    if (!res.ok) return {};
    const data = (await res.json()) as Array<{ id: string; name: string; animated: boolean }>;
    const out: Record<string, string> = {};
    for (const e of data) {
      const ext = e.animated ? "gif" : "png";
      out[e.name] = `https://cdn.discordapp.com/emojis/${e.id}.${ext}`;
    }
    return out;
  },
};
