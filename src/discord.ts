import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { WebSocket as WSClient } from "ws";
import type { Adapter, HistoryMessage, InboundMessage } from "./adapter.js";

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN ?? "";
const CONFIG_PATH = process.env.DISCORD_CONFIG_PATH ?? "data/discord-config.json";

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

type DiscordConfig = {
  siteId: string;
  guildId: string;
  channelId: string;
  webhookUrl: string;
  origins: string[];
};

type DiscordMessage = {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
  webhook_id?: string;
};

let config: DiscordConfig | null = null;
let botUserId: string | null = null;
const threadByName = new Map<string, string>();
const threadById = new Map<string, string>();
let onDisableHandler: (() => void) | null = null;

function loadConfig(): void {
  if (!existsSync(CONFIG_PATH)) return;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<DiscordConfig>;
    if (raw.siteId && raw.guildId && raw.channelId && raw.webhookUrl) {
      config = {
        siteId: raw.siteId,
        guildId: raw.guildId,
        channelId: raw.channelId,
        webhookUrl: raw.webhookUrl,
        origins: raw.origins ?? [],
      };
    }
  } catch (e) {
    console.error("[discord:config] failed to load", e);
  }
}

function saveConfig(): void {
  if (!config) return;
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function clearConfig(): void {
  config = null;
  threadByName.clear();
  threadById.clear();
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
}

function newSiteId(): string {
  return `dc_${nanoid(12)}`;
}

function normalizeOrigin(s: string): string {
  return s.trim().toLowerCase().replace(/\/$/, "");
}

export function setOnDisable(fn: () => void): void {
  onDisableHandler = fn;
}


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
  if (!config) return;
  const res = await api(`/guilds/${config.guildId}/threads/active`);
  if (!res.ok) return;
  const data = (await res.json()) as { threads: Array<{ id: string; name: string; parent_id: string }> };
  for (const t of data.threads) {
    if (t.parent_id !== config.channelId) continue;
    threadByName.set(t.name, t.id);
    threadById.set(t.id, t.name);
  }
}

async function ensureThread(name: string): Promise<string> {
  if (!config) throw new Error("discord not configured");
  const cached = threadByName.get(name);
  if (cached) return cached;
  const res = await api(`/channels/${config.channelId}/threads`, {
    method: "POST",
    body: JSON.stringify({ name, type: 11, auto_archive_duration: 1440 }),
  });
  if (!res.ok) throw new Error(`thread create failed: ${res.status} ${await res.text()}`);
  const thread = (await res.json()) as { id: string };
  threadByName.set(name, thread.id);
  threadById.set(thread.id, name);
  return thread.id;
}

async function createWebhook(channelId: string): Promise<{ id: string; token: string; url: string }> {
  const res = await api(`/channels/${channelId}/webhooks`, {
    method: "POST",
    body: JSON.stringify({ name: "danro-chat" }),
  });
  if (!res.ok) throw new Error(`webhook create failed: ${res.status} ${await res.text()}`);
  const wh = (await res.json()) as { id: string; token: string };
  return { ...wh, url: `https://discord.com/api/webhooks/${wh.id}/${wh.token}` };
}

async function respondInteraction(id: string, token: string, content: string): Promise<void> {
  await fetch(`${API}/interactions/${id}/${token}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: 4, data: { content, flags: 64 } }),
  });
}

type InteractionOption = {
  name: string;
  type: number;
  value?: string;
  options?: InteractionOption[];
};

type InteractionData = {
  id: string;
  token: string;
  type: number;
  guild_id?: string;
  data?: { name: string; options?: InteractionOption[] };
};

function embedSnippet(siteId: string): string {
  return [
    "埋め込みコード:",
    "```html",
    `<danro-talk ws-url="wss://your-server" site-id="${siteId}"></danro-talk>`,
    "```",
    "**siteId** は HTML 上に公開されます。漏洩したら `/danro rotate-id` で再発行できます。",
    "ドメイン制限したい場合は `/danro set-origin example.com` で設定してください。",
  ].join("\n");
}

async function handleInteraction(d: InteractionData): Promise<void> {
  if (d.type !== 2 || d.data?.name !== "danro") return;
  const sub = d.data.options?.[0];
  if (!sub) return;

  if (sub.name === "set-channel") {
    const channelId = sub.options?.find((o) => o.name === "channel")?.value;
    if (!channelId || !d.guild_id) {
      await respondInteraction(d.id, d.token, "チャンネルを指定してください。");
      return;
    }
    try {
      const webhook = await createWebhook(channelId);
      const siteId = config?.guildId === d.guild_id ? config.siteId : newSiteId();
      const origins = config?.guildId === d.guild_id ? config.origins : [];
      config = { siteId, guildId: d.guild_id, channelId, webhookUrl: webhook.url, origins };
      saveConfig();
      threadByName.clear();
      threadById.clear();
      await loadActiveThreads();
      await respondInteraction(
        d.id,
        d.token,
        `✅ <#${channelId}> に設定しました。\n\nsiteId: \`${siteId}\`\n\n${embedSnippet(siteId)}`,
      );
    } catch (e) {
      await respondInteraction(d.id, d.token, `❌ 失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  if (sub.name === "show") {
    if (config && config.guildId === d.guild_id) {
      const originsLine = config.origins.length > 0 ? config.origins.join(", ") : "（未設定 — どこからでも接続可）";
      await respondInteraction(
        d.id,
        d.token,
        [
          `**channel**: <#${config.channelId}>`,
          `**siteId**: \`${config.siteId}\``,
          `**origins**: ${originsLine}`,
        ].join("\n"),
      );
    } else {
      await respondInteraction(d.id, d.token, "未設定です。`/danro set-channel` で設定してください。");
    }
    return;
  }

  if (sub.name === "rotate-id") {
    if (!config || config.guildId !== d.guild_id) {
      await respondInteraction(d.id, d.token, "未設定です。");
      return;
    }
    const siteId = newSiteId();
    config = { ...config, siteId };
    saveConfig();
    onDisableHandler?.();
    await respondInteraction(
      d.id,
      d.token,
      `✅ siteId を再発行しました: \`${siteId}\`\n旧 siteId は無効、既存の widget セッションは切断されました。\n\n${embedSnippet(siteId)}`,
    );
    return;
  }

  if (sub.name === "set-origin") {
    if (!config || config.guildId !== d.guild_id) {
      await respondInteraction(d.id, d.token, "先に `/danro set-channel` で設定してください。");
      return;
    }
    const value = sub.options?.find((o) => o.name === "domains")?.value ?? "";
    const list = value
      .split(",")
      .map((s) => normalizeOrigin(s))
      .filter((s) => s.length > 0);
    config = { ...config, origins: list };
    saveConfig();
    if (list.length === 0) {
      await respondInteraction(d.id, d.token, "✅ ドメイン制限を解除しました（どこからでも接続可）。");
    } else {
      await respondInteraction(d.id, d.token, `✅ 許可ドメイン: ${list.join(", ")}`);
    }
    return;
  }

  if (sub.name === "disable") {
    if (config && config.guildId === d.guild_id) {
      clearConfig();
      onDisableHandler?.();
      await respondInteraction(d.id, d.token, "✅ 無効化しました。既存の widget セッションは切断されました。");
    } else {
      await respondInteraction(d.id, d.token, "このサーバには設定がありません。");
    }
    return;
  }
}

async function registerCommands(): Promise<void> {
  if (!botUserId) return;
  const commands = [
    {
      name: "danro",
      description: "danro-chat configuration",
      default_member_permissions: "32", // MANAGE_GUILD
      options: [
        {
          name: "set-channel",
          description: "Set the parent channel for visitor conversations",
          type: 1,
          options: [
            { name: "channel", description: "Parent text channel", type: 7, required: true, channel_types: [0] },
          ],
        },
        { name: "show", description: "Show current configuration", type: 1 },
        { name: "rotate-id", description: "Rotate the siteId (invalidates old widget embeds)", type: 1 },
        {
          name: "set-origin",
          description: "Restrict by domain (comma-separated; empty to clear)",
          type: 1,
          options: [
            { name: "domains", description: "e.g. https://example.com,https://example.org", type: 3, required: true },
          ],
        },
        { name: "disable", description: "Disable visitor chat in this server", type: 1 },
      ],
    },
  ];
  const res = await api(`/applications/${botUserId}/commands`, {
    method: "PUT",
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    console.error("[discord:commands]", res.status, await res.text());
  } else {
    console.log("[discord] slash commands registered");
  }
}

function connectGateway(onMessage: (m: DiscordMessage) => void): void {
  const ws = new WSClient(GATEWAY);
  let heartbeat: NodeJS.Timeout | null = null;
  let seq: number | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  ws.on("message", async (raw) => {
    const payload = JSON.parse(raw.toString()) as { op: number; d: any; s: number | null; t: string | null };
    if (payload.s !== null && payload.s !== undefined) seq = payload.s;

    if (payload.op === 10) {
      heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), payload.d.heartbeat_interval);
      const intents = (1 << 0) | (1 << 9) | (1 << 15);
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: BOT_TOKEN,
          intents,
          properties: { os: "linux", browser: "danro-chat", device: "danro-chat" },
        },
      }));
      return;
    }

    if (payload.op === 0) {
      if (payload.t === "READY") {
        botUserId = payload.d.user?.id ?? null;
        await registerCommands();
        await loadActiveThreads();
      }
      if (payload.t === "MESSAGE_CREATE") onMessage(payload.d as DiscordMessage);
      if (payload.t === "INTERACTION_CREATE") {
        handleInteraction(payload.d as InteractionData).catch((e) => console.error("[discord:interaction]", e));
      }
      if (payload.t === "THREAD_CREATE") {
        const t = payload.d as { id: string; name: string; parent_id: string };
        if (config && t.parent_id === config.channelId) {
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

loadConfig();

export const discordAdapter: Adapter = {
  target: "discord",

  async send(topic, sender, text) {
    if (!config) throw new Error("discord not configured");
    const threadId = await ensureThread(topic);
    const url = new URL(config.webhookUrl);
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
    if (!BOT_TOKEN) {
      console.warn("[discord] BOT_TOKEN missing — skipping subscribe");
      return;
    }
    connectGateway((msg) => {
      if (!config) return;
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

  validateHello(siteId, origin) {
    if (!config) return { ok: false, reason: "service_unavailable" };
    if (!siteId || siteId !== config.siteId) return { ok: false, reason: "invalid_site_id" };
    if (config.origins.length > 0) {
      if (!origin) return { ok: false, reason: "origin_required" };
      if (!config.origins.includes(normalizeOrigin(origin))) return { ok: false, reason: "origin_not_allowed" };
    }
    return { ok: true };
  },

  async emojis(): Promise<Record<string, string>> {
    if (!config) return {};
    const res = await api(`/guilds/${config.guildId}/emojis`);
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
