import { nanoid } from "nanoid";
import type { Env } from "./worker.js";
import type { DiscordConfig, HistoryMessage } from "./types.js";
import { normalizeOrigin, parseOrigins } from "./types.js";

export type { DiscordConfig };

export type OnAgentMessage = (topic: string, senderName: string, text: string) => void;

type DiscordMessage = {
  id: string;
  channel_id: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  webhook_id?: string;
};

export type InteractionData = {
  id: string;
  token: string;
  type: number;
  guild_id?: string;
  member?: { permissions?: string };
  data?: {
    name: string;
    options?: Array<{
      name: string;
      type: number;
      value?: string;
      options?: Array<{ name: string; type: number; value?: string }>;
    }>;
  };
};

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY = "https://gateway.discord.gg/?v=10&encoding=json";

// Gateway opcodes
const GW_DISPATCH = 0;
const GW_HEARTBEAT = 1;
const GW_IDENTIFY = 2;
const GW_RECONNECT = 7;
const GW_INVALID_SESSION = 9;
const GW_HELLO = 10;

// Gateway intent bits
const INTENT_GUILDS = 1 << 0;
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15;

// Interaction / response constants
const INTERACTION_APPLICATION_COMMAND = 2;
const RESPONSE_CHANNEL_MESSAGE = 4;
const FLAG_EPHEMERAL = 64;

// Thread constants
const THREAD_TYPE_PUBLIC = 11;
const THREAD_ARCHIVE_24H = 1440; // minutes

// Permission flags
const PERM_MANAGE_GUILD = "32";

const SITE_ID_LEN = 12;
const HISTORY_LIMIT = 50;
const RECONNECT_DELAY_MS = 5000;

const DISCORD_COMMAND_DEFS = [
  {
    name: "danro",
    description: "danro-talk configuration",
    default_member_permissions: PERM_MANAGE_GUILD,
    options: [
      {
        name: "set-channel",
        description: "Set the parent channel for visitor conversations",
        type: 1,
        options: [{ name: "channel", description: "Parent text channel", type: 7, required: true, channel_types: [0] }],
      },
      { name: "show", description: "Show current configuration", type: 1 },
      { name: "rotate-id", description: "Rotate the siteId (invalidates old widget embeds)", type: 1 },
      {
        name: "set-origin",
        description: "Restrict by domain (comma-separated; empty to clear)",
        type: 1,
        options: [{ name: "domains", description: "e.g. https://example.com,https://example.org", type: 3, required: true }],
      },
      { name: "disable", description: "Disable visitor chat in this server", type: 1 },
    ],
  },
];

function discordDisplayName(m: DiscordMessage): string {
  return m.member?.nick ?? m.author?.global_name ?? m.author?.username ?? "unknown";
}

export class DiscordAdapter {
  private discordConfig: DiscordConfig | null = null;
  private dgWs: WebSocket | null = null;
  private dgSeq: number | null = null;
  private dgBotUserId: string | null = null;
  private dgHeartbeat: ReturnType<typeof setInterval> | null = null;
  private dgThreadByName = new Map<string, string>();
  private dgThreadById = new Map<string, string>();
  private dgRegistered = new Set<string>();
  private dgGlobalCleared = false;
  private dgConnecting = false;
  private dgAuthFailed = false;
  private dgBackoffMs = RECONNECT_DELAY_MS;

  constructor(
    private env: Env,
    private storage: DurableObjectStorage,
    private onMessage: OnAgentMessage,
    private onDisable: () => void,
    private onTopicRename: (oldTopic: string, newTopic: string) => void,
  ) {}

  async init(): Promise<void> {
    this.discordConfig = (await this.storage.get<DiscordConfig>("discord:config")) ?? null;
    const threads = (await this.storage.get<Record<string, string>>("discord:threads")) ?? {};
    for (const [name, id] of Object.entries(threads)) {
      this.dgThreadByName.set(name, id);
      this.dgThreadById.set(id, name);
    }
  }

  get config(): DiscordConfig | null {
    return this.discordConfig;
  }

  validate(siteId: string | undefined, origin: string | undefined): string | null {
    if (!this.discordConfig) return "service_unavailable";
    if (!siteId || siteId !== this.discordConfig.siteId) return "invalid_site_id";
    if (this.discordConfig.origins.length > 0) {
      if (!origin) return "origin_required";
      if (!this.discordConfig.origins.includes(normalizeOrigin(origin))) return "origin_not_allowed";
    }
    return null;
  }

  start(): void {
    if (!this.env.DISCORD_BOT_TOKEN) return;
    if (this.dgAuthFailed) return;
    if (!this.discordConfig) return;
    if (this.dgWs || this.dgConnecting) return;
    this.dgConnect();
  }

  stop(): void {
    if (this.dgHeartbeat) {
      clearInterval(this.dgHeartbeat);
      this.dgHeartbeat = null;
    }
    if (this.dgWs) {
      try {
        this.dgWs.close();
      } catch {}
      this.dgWs = null;
    }
  }

  async send(topic: string, nickname: string, text: string): Promise<void> {
    if (!this.discordConfig) throw new Error("discord not configured");
    const threadId = await this.dgEnsureThread(topic);
    const url = new URL(this.discordConfig.webhookUrl);
    url.searchParams.set("thread_id", threadId);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: `danro ${nickname}`, content: text, allowed_mentions: { parse: [] } }),
    });
    if (!res.ok) throw new Error(`webhook send: ${res.status} ${await res.text()}`);
  }

  async sendSystem(topic: string, text: string): Promise<void> {
    const threadId = await this.dgEnsureThread(topic);
    const res = await this.dgApi(`/channels/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) throw new Error(`discord sendSystem: ${res.status} ${await res.text()}`);
  }

  async fetchHistory(topic: string): Promise<HistoryMessage[]> {
    const threadId = this.dgThreadByName.get(topic);
    if (!threadId) return [];
    const res = await this.dgApi(`/channels/${threadId}/messages?limit=${HISTORY_LIMIT}`);
    if (!res.ok) return [];
    const messages = await res.json() as DiscordMessage[];
    return messages
      .reverse()
      .filter((m) => !(!m.webhook_id && /^visitor_id:\s*`/.test(m.content)))
      .map((m) => ({
        from: (m.webhook_id ? "visitor" : "agent") as "visitor" | "agent",
        text: m.content,
        ts: new Date(m.timestamp).getTime(),
        senderName: discordDisplayName(m),
      }));
  }

  async fetchEmojis(): Promise<Record<string, string>> {
    if (!this.discordConfig) return {};
    const res = await this.dgApi(`/guilds/${this.discordConfig.guildId}/emojis`);
    if (!res.ok) return {};
    const data = await res.json() as Array<{ id: string; name: string; animated: boolean }>;
    const out: Record<string, string> = {};
    for (const e of data) out[e.name] = `https://cdn.discordapp.com/emojis/${e.id}.${e.animated ? "gif" : "png"}`;
    return out;
  }

  async handleInteraction(d: InteractionData): Promise<void> {
    if (d.type !== INTERACTION_APPLICATION_COMMAND || d.data?.name !== "danro") return;
    const sub = d.data.options?.[0];
    if (!sub) return;

    const respond = (content: string) =>
      fetch(`${DISCORD_API}/interactions/${d.id}/${d.token}/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: RESPONSE_CHANNEL_MESSAGE, data: { content, flags: FLAG_EPHEMERAL } }),
      });

    const memberPerms = BigInt(d.member?.permissions ?? "0");
    if ((memberPerms & BigInt(PERM_MANAGE_GUILD)) === 0n) {
      await respond("This command requires the Manage Guild permission.");
      return;
    }

    if (sub.name === "set-channel") {
      const channelId = sub.options?.find((o) => o.name === "channel")?.value;
      if (!channelId || !d.guild_id) {
        await respond("Please specify a channel.");
        return;
      }
      try {
        const whRes = await this.dgApi(`/channels/${channelId}/webhooks`, {
          method: "POST",
          body: JSON.stringify({ name: "danro-talk" }),
        });
        if (!whRes.ok) throw new Error(`${whRes.status} ${await whRes.text()}`);
        const wh = await whRes.json() as { id: string; token: string };
        const siteId = this.discordConfig?.guildId === d.guild_id
          ? this.discordConfig.siteId
          : `dc_${nanoid(SITE_ID_LEN)}`;
        const origins = this.discordConfig?.guildId === d.guild_id
          ? this.discordConfig.origins
          : [];
        this.discordConfig = {
          siteId,
          guildId: d.guild_id,
          channelId,
          webhookUrl: `https://discord.com/api/webhooks/${wh.id}/${wh.token}`,
          origins,
        };
        await this.storage.put("discord:config", this.discordConfig);
        this.dgThreadByName.clear();
        this.dgThreadById.clear();
        await this.dgLoadThreads();
        await respond(
          `✅ Set to <#${channelId}>.\n\nsiteId: \`${siteId}\`\n\nEmbed code:\n\`\`\`html\n<script type="module" src="https://danro-api.atfedi.de/widget.js"></script>\n<danro-talk site-id="${siteId}"></danro-talk>\n\`\`\``,
        );
      } catch (e) {
        await respond(`❌ Failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (sub.name === "show") {
      const cfg = this.discordConfig;
      if (cfg !== null && cfg.guildId === d.guild_id) {
        const origs = cfg.origins.length > 0 ? cfg.origins.join(", ") : "(none — all origins allowed)";
        await respond([
          `**channel**: <#${cfg.channelId}>`,
          `**siteId**: \`${cfg.siteId}\``,
          `**origins**: ${origs}`,
        ].join("\n"));
      } else {
        await respond("Not configured. Run `/danro set-channel` first.");
      }
      return;
    }

    if (sub.name === "rotate-id") {
      if (!this.discordConfig || this.discordConfig.guildId !== d.guild_id) {
        await respond("Not configured.");
        return;
      }
      const siteId = `dc_${nanoid(SITE_ID_LEN)}`;
      this.discordConfig = { ...this.discordConfig, siteId };
      await this.storage.put("discord:config", this.discordConfig);
      this.onDisable();
      await respond(`✅ Rotated siteId: \`${siteId}\`. Old siteId is invalid; existing sessions were disconnected.`);
      return;
    }

    if (sub.name === "set-origin") {
      if (!this.discordConfig || this.discordConfig.guildId !== d.guild_id) {
        await respond("Not configured. Run `/danro set-channel` first.");
        return;
      }
      const list = parseOrigins(sub.options?.find((o) => o.name === "domains")?.value ?? "");
      this.discordConfig = { ...this.discordConfig, origins: list };
      await this.storage.put("discord:config", this.discordConfig);
      await respond(list.length === 0 ? "✅ Origin restriction cleared." : `✅ Allowed origins: ${list.join(", ")}`);
      return;
    }

    if (sub.name === "disable") {
      if (this.discordConfig?.guildId === d.guild_id) {
        this.discordConfig = null;
        await this.storage.delete("discord:config");
        this.dgThreadByName.clear();
        this.dgThreadById.clear();
        this.onDisable();
        await respond("✅ Disabled. Existing widget sessions were disconnected.");
      } else {
        await respond("No configuration found for this server.");
      }
    }
  }

  private dgApi(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${DISCORD_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  }

  private dgConnect(): void {
    if (this.dgConnecting || this.dgWs || this.dgAuthFailed) return;
    if (!this.env.DISCORD_BOT_TOKEN || !this.discordConfig) return;
    this.dgConnecting = true;
    fetch(DISCORD_GATEWAY, { headers: { Upgrade: "websocket" } }).then((resp) => {
      const ws = resp.webSocket;
      if (!ws) {
        this.dgConnecting = false;
        console.error("[discord:gateway] no webSocket");
        this.dgScheduleReconnect();
        return;
      }
      ws.accept();
      this.dgWs = ws;
      this.dgConnecting = false;

      ws.addEventListener("message", (event) => {
        this.dgOnMessage(ws, event.data as string).catch(console.error);
      });
      ws.addEventListener("close", (e: CloseEvent) => {
        this.dgWs = null;
        if (this.dgHeartbeat) {
          clearInterval(this.dgHeartbeat);
          this.dgHeartbeat = null;
        }
        // 4004 auth failed, 4010 invalid shard, 4011 sharding required,
        // 4012 invalid api version, 4013 invalid intents, 4014 disallowed intents
        const code = (e as { code?: number }).code ?? 0;
        if (code === 4004 || code === 4010 || code === 4011 || code === 4012 || code === 4013 || code === 4014) {
          this.dgAuthFailed = true;
          console.error(`[discord:gateway] fatal close ${code} — not reconnecting`);
          return;
        }
        this.dgScheduleReconnect();
      });
      ws.addEventListener("error", (e) => console.error("[discord:gateway]", e));
    }).catch((e) => {
      this.dgConnecting = false;
      console.error("[discord:gateway:connect]", e);
      this.dgScheduleReconnect();
    });
  }

  private dgScheduleReconnect(): void {
    if (this.dgAuthFailed || !this.discordConfig || !this.env.DISCORD_BOT_TOKEN) return;
    const delay = Math.min(this.dgBackoffMs, 5 * 60_000);
    this.dgBackoffMs = Math.min(this.dgBackoffMs * 2, 5 * 60_000);
    setTimeout(() => this.dgConnect(), delay);
  }

  private async dgOnMessage(ws: WebSocket, raw: string): Promise<void> {
    const p = JSON.parse(raw) as { op: number; d: unknown; s: number | null; t: string | null };
    if (p.s !== null && p.s !== undefined) this.dgSeq = p.s;

    if (p.op === GW_HELLO) {
      const d = p.d as { heartbeat_interval: number };
      this.dgHeartbeat = setInterval(
        () => ws.send(JSON.stringify({ op: GW_HEARTBEAT, d: this.dgSeq })),
        d.heartbeat_interval,
      );
      const intents = INTENT_GUILDS | INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;
      ws.send(JSON.stringify({
        op: GW_IDENTIFY,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          intents,
          properties: { os: "linux", browser: "danro-talk", device: "danro-talk" },
        },
      }));
      return;
    }

    if (p.op === GW_DISPATCH) {
      if (p.t === "READY") {
        this.dgBackoffMs = RECONNECT_DELAY_MS;
        const d = p.d as { user?: { id: string }; guilds?: Array<{ id: string; unavailable?: boolean }> };
        this.dgBotUserId = d.user?.id ?? null;
        if (!this.dgGlobalCleared && this.dgBotUserId) {
          this.dgGlobalCleared = true;
          await this.dgApi(`/applications/${this.dgBotUserId}/commands`, { method: "PUT", body: JSON.stringify([]) });
        }
        for (const g of d.guilds ?? []) if (!g.unavailable) await this.dgRegisterCommands(g.id);
        await this.dgLoadThreads();
      }
      if (p.t === "GUILD_CREATE") {
        const g = p.d as { id: string; unavailable?: boolean };
        if (!g.unavailable) await this.dgRegisterCommands(g.id);
      }
      if (p.t === "MESSAGE_CREATE") {
        const msg = p.d as DiscordMessage;
        if (!this.discordConfig || msg.webhook_id || msg.author?.bot) return;
        if (this.dgBotUserId && msg.author?.id === this.dgBotUserId) return;
        const topic = this.dgThreadById.get(msg.channel_id);
        if (!topic) return;
        this.onMessage(topic, discordDisplayName(msg), msg.content ?? "");
      }
      if (p.t === "INTERACTION_CREATE") {
        await this.handleInteraction(p.d as InteractionData);
      }
      if (p.t === "THREAD_CREATE") {
        const t = p.d as { id: string; name: string; parent_id: string };
        if (this.discordConfig && t.parent_id === this.discordConfig.channelId) {
          this.dgThreadByName.set(t.name, t.id);
          this.dgThreadById.set(t.id, t.name);
          await this.dgSaveThreads();
        }
      }
      if (p.t === "THREAD_UPDATE") {
        const t = p.d as { id: string; name: string; parent_id: string };
        if (this.discordConfig && t.parent_id === this.discordConfig.channelId) {
          const oldName = this.dgThreadById.get(t.id);
          if (oldName && oldName !== t.name) {
            this.dgThreadByName.delete(oldName);
            this.dgThreadByName.set(t.name, t.id);
            this.dgThreadById.set(t.id, t.name);
            await this.dgSaveThreads();
            this.onTopicRename(oldName, t.name);
          }
        }
      }
      return;
    }

    if (p.op === GW_RECONNECT || p.op === GW_INVALID_SESSION) ws.close();
  }

  private async dgLoadThreads(): Promise<void> {
    if (!this.discordConfig) return;
    const res = await this.dgApi(`/guilds/${this.discordConfig.guildId}/threads/active`);
    if (!res.ok) return;
    const data = await res.json() as { threads: Array<{ id: string; name: string; parent_id: string }> };
    for (const t of data.threads) {
      if (t.parent_id !== this.discordConfig.channelId) continue;
      this.dgThreadByName.set(t.name, t.id);
      this.dgThreadById.set(t.id, t.name);
    }
    await this.dgSaveThreads();
  }

  private async dgSaveThreads(): Promise<void> {
    const threads: Record<string, string> = {};
    for (const [name, id] of this.dgThreadByName) threads[name] = id;
    await this.storage.put("discord:threads", threads);
  }

  private async dgEnsureThread(name: string): Promise<string> {
    if (!this.discordConfig) throw new Error("discord not configured");
    const cached = this.dgThreadByName.get(name);
    if (cached) return cached;
    const res = await this.dgApi(`/channels/${this.discordConfig.channelId}/threads`, {
      method: "POST",
      body: JSON.stringify({ name, type: THREAD_TYPE_PUBLIC, auto_archive_duration: THREAD_ARCHIVE_24H }),
    });
    if (!res.ok) throw new Error(`thread create: ${res.status} ${await res.text()}`);
    const thread = await res.json() as { id: string };
    this.dgThreadByName.set(name, thread.id);
    this.dgThreadById.set(thread.id, name);
    await this.dgSaveThreads();
    return thread.id;
  }

  private async dgRegisterCommands(guildId: string): Promise<void> {
    if (!this.dgBotUserId || this.dgRegistered.has(guildId)) return;
    const res = await this.dgApi(`/applications/${this.dgBotUserId}/guilds/${guildId}/commands`, {
      method: "PUT",
      body: JSON.stringify(DISCORD_COMMAND_DEFS),
    });
    if (res.ok) {
      this.dgRegistered.add(guildId);
      console.log(`[discord] commands registered for ${guildId}`);
    }
  }
}
