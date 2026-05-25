import { nanoid } from "nanoid";
import type { Env } from "./worker.js";
import type { HistoryMessage } from "./types.js";
import { normalizeOrigin, parseOrigins } from "./types.js";

export type OnAgentMessage = (topic: string, senderName: string, text: string) => void;
export type OnTopicRename = (oldTopic: string, newTopic: string) => void;

type ZulipRuntimeConfig = {
  stream: string;
  siteId: string;
  origins: string[];
};

const POLL_INTERVAL_MS = 5000;
const HISTORY_LIMIT = 50;
const SITE_ID_LEN = 12;

const VISITOR_PREFIX_RE = /^(:[^:\s]+:\s+)?\*\*[^*\n]+\*\*\n/;
function stripVisitorPrefix(content: string): string {
  return content
    .replace(VISITOR_PREFIX_RE, "")
    .split("\n")
    .map((l) => l.replace(/^> ?/, ""))
    .join("\n");
}

export class ZulipAdapter {
  private config!: ZulipRuntimeConfig;
  private queueId: string | null = null;
  private lastEventId = -1;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(
    private env: Env,
    private storage: DurableObjectStorage,
    private onMessage: OnAgentMessage,
    private onDisable: () => void,
    private onTopicRename: OnTopicRename,
  ) {}

  async init(): Promise<void> {
    const stored = await this.storage.get<ZulipRuntimeConfig>("zulip:config");
    this.config = stored ?? {
      stream: this.env.ZULIP_STREAM ?? "",
      siteId: this.env.ZULIP_SITE_ID ?? "",
      origins: parseOrigins(this.env.ZULIP_ORIGINS ?? ""),
    };
    if (!this.config.siteId) {
      this.config.siteId = `zl_${nanoid(SITE_ID_LEN)}`;
      await this.storage.put("zulip:config", this.config);
    }
    this.queueId = (await this.storage.get<string>("zulip:queue_id")) ?? null;
    this.lastEventId = (await this.storage.get<number>("zulip:last_event_id")) ?? -1;
  }

  validate(siteId: string | undefined, origin: string | undefined): string | null {
    const sid = this.config.siteId;
    if (siteId !== sid) return "invalid_site_id";
    const origs = this.config.origins;
    if (origs.length > 0) {
      if (!origin) return "origin_required";
      if (!origs.includes(normalizeOrigin(origin))) return "origin_not_allowed";
    }
    return null;
  }

  start(): void {
    if (this.env.ZULIP_API_KEY && !this.poller) {
      this.poller = setInterval(() => {
        this.poll().catch(console.error);
      }, POLL_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.poller) {
      clearInterval(this.poller);
      this.poller = null;
    }
  }

  async send(topic: string, nickname: string, text: string): Promise<void> {
    const emoji = this.env.ZULIP_VISITOR_EMOJI ?? "";
    const prefix = emoji ? `${emoji} ` : "";
    const quoted = text.split("\n").map((l) => `> ${l}`).join("\n");
    const body = new URLSearchParams({
      type: "stream",
      to: this.config.stream,
      topic,
      content: `${prefix}**${nickname}**\n${quoted}`,
    });
    const res = await this.zulipFetch("/messages", { method: "POST", body });
    if (!res.ok) throw new Error(`zulip send: ${res.status} ${await res.text()}`);
  }

  async sendSystem(topic: string, text: string): Promise<void> {
    const body = new URLSearchParams({
      type: "stream",
      to: this.config.stream,
      topic,
      content: text,
    });
    const res = await this.zulipFetch("/messages", { method: "POST", body });
    if (!res.ok) throw new Error(`zulip sendSystem: ${res.status} ${await res.text()}`);
  }

  async fetchHistory(topic: string): Promise<HistoryMessage[]> {
    const params = new URLSearchParams({
      anchor: "newest",
      num_before: String(HISTORY_LIMIT),
      num_after: "0",
      narrow: JSON.stringify([
        { operator: "stream", operand: this.config.stream },
        { operator: "topic", operand: topic },
      ]),
      apply_markdown: "false",
    });
    const res = await this.zulipFetch(`/messages?${params}`);
    if (!res.ok) return [];
    const data = await res.json() as {
      result: string;
      messages: Array<{
        sender_email: string;
        sender_full_name: string;
        content: string;
        timestamp: number;
      }>;
    };
    if (data.result !== "success") return [];
    return data.messages.map((m) => ({
      from: m.sender_email === this.env.ZULIP_USERNAME ? ("visitor" as const) : ("agent" as const),
      text: m.sender_email === this.env.ZULIP_USERNAME ? stripVisitorPrefix(m.content) : m.content,
      ts: m.timestamp * 1000,
      senderName: m.sender_full_name,
    }));
  }

  async fetchEmojis(): Promise<Record<string, string>> {
    const res = await this.zulipFetch("/realm/emoji");
    if (!res.ok) return {};
    const data = await res.json() as {
      result: string;
      emoji: Record<string, { name: string; source_url: string; deactivated: boolean }>;
    };
    if (data.result !== "success") return {};
    const base = this.env.ZULIP_REALM.replace(/\/$/, "");
    const out: Record<string, string> = {};
    for (const e of Object.values(data.emoji)) {
      if (e.deactivated) continue;
      out[e.name] = e.source_url.startsWith("http") ? e.source_url : `${base}${e.source_url}`;
    }
    return out;
  }

  // ── Internal ──────────────────────────────────────────────────

  private authHeader(): string {
    return `Basic ${btoa(`${this.env.ZULIP_USERNAME}:${this.env.ZULIP_API_KEY}`)}`;
  }

  private zulipFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const base = this.env.ZULIP_REALM.replace(/\/$/, "");
    return fetch(`${base}/api/v1${path}`, {
      ...init,
      headers: { Authorization: this.authHeader(), ...(init.headers ?? {}) },
    });
  }

  private async register(): Promise<void> {
    const body = new URLSearchParams({ event_types: JSON.stringify(["message", "update_message"]) });
    const res = await this.zulipFetch("/register", { method: "POST", body });
    if (!res.ok) throw new Error(`zulip register: ${res.status}`);
    const data = await res.json() as { queue_id: string; last_event_id: number };
    this.queueId = data.queue_id;
    this.lastEventId = data.last_event_id;
    await this.storage.put("zulip:queue_id", this.queueId);
    await this.storage.put("zulip:last_event_id", this.lastEventId);
  }

  private async poll(): Promise<void> {
    if (!this.queueId) {
      await this.register().catch((e) => console.error("[zulip:register]", e));
      if (!this.queueId) return;
    }
    const params = new URLSearchParams({
      queue_id: this.queueId,
      last_event_id: String(this.lastEventId),
      dont_block: "true",
    });
    let res: Response;
    try {
      res = await this.zulipFetch(`/events?${params}`);
    } catch (e) {
      console.error("[zulip:poll]", e);
      return;
    }

    if (res.status === 400) {
      // Queue expired — re-register next tick
      this.queueId = null;
      await this.storage.delete("zulip:queue_id");
      return;
    }
    if (!res.ok) return;

    const data = await res.json() as {
      events: Array<{
        id: number;
        type: string;
        message?: {
          sender_email: string;
          sender_full_name: string;
          type: "stream" | "private";
          display_recipient: string | Array<{ email: string }>;
          subject: string;
          content: string;
        };
        stream_name?: string;
        orig_subject?: string;
        subject?: string;
        propagate_mode?: string;
      }>;
    };

    for (const event of data.events) {
      if (event.id > this.lastEventId) this.lastEventId = event.id;

      if (event.type === "update_message") {
        const oldTopic = event.orig_subject;
        const newTopic = event.subject;
        if (oldTopic && newTopic && oldTopic !== newTopic && event.stream_name === this.config.stream) {
          this.onTopicRename(oldTopic, newTopic);
        }
        continue;
      }

      if (event.type !== "message" || !event.message) continue;

      const m = event.message;
      if (m.sender_email === this.env.ZULIP_USERNAME) continue;

      if (m.type === "stream") {
        if (m.display_recipient !== this.config.stream) continue;
        this.onMessage(m.subject, m.sender_full_name, m.content);
      } else if (m.type === "private") {
        const recipients = m.display_recipient as Array<{ email: string }>;
        if (!recipients.some((r) => r.email === this.env.ZULIP_USERNAME)) continue;
        await this.handleCommand(m.sender_email, m.content.trim());
      }
    }
    await this.storage.put("zulip:last_event_id", this.lastEventId);
  }

  // ── Bot commands (received as DMs) ────────────────────────────

  private async isAdmin(email: string): Promise<boolean> {
    const res = await this.zulipFetch(`/users/${encodeURIComponent(email)}`).catch(() => null);
    if (!res?.ok) return false;
    const data = await res.json() as { result: string; user: { is_admin?: boolean; is_realm_owner?: boolean } };
    return data.result === "success" && (data.user.is_admin === true || data.user.is_realm_owner === true);
  }

  private async handleCommand(senderEmail: string, text: string): Promise<void> {
    if (!(await this.isAdmin(senderEmail))) {
      await this.dmReply(senderEmail, "This command is restricted to Zulip administrators.");
      return;
    }

    const [cmd, ...rest] = text.trim().split(/\s+/);
    const arg = rest.join(" ");

    switch (cmd?.toLowerCase()) {
      case "set-stream": {
        if (!arg) {
          await this.dmReply(senderEmail, "Usage: `set-stream <stream name>`");
          return;
        }
        this.config.stream = arg;
        await this.storage.put("zulip:config", this.config);
        await this.dmReply(senderEmail, `✅ Stream set to \`${arg}\`.`);
        break;
      }
      case "rotate-id": {
        const siteId = `zl_${nanoid(SITE_ID_LEN)}`;
        this.config.siteId = siteId;
        await this.storage.put("zulip:config", this.config);
        this.onDisable();
        await this.dmReply(
          senderEmail,
          `✅ Rotated siteId: \`${siteId}\`. Old siteId is invalid; existing sessions were disconnected.`,
        );
        break;
      }
      case "set-origin": {
        const list = parseOrigins(arg);
        this.config.origins = list;
        await this.storage.put("zulip:config", this.config);
        await this.dmReply(
          senderEmail,
          list.length === 0
            ? "✅ Origin restriction cleared."
            : `✅ Allowed origins: ${list.join(", ")}`,
        );
        break;
      }
      case "show": {
        const origs =
          this.config.origins.length > 0
            ? this.config.origins.join(", ")
            : "(none — all origins allowed)";
        const siteIdDisplay = this.config.siteId || "(not set)";
        await this.dmReply(senderEmail, [
          `**stream**: \`${this.config.stream}\``,
          `**siteId**: \`${siteIdDisplay}\``,
          `**origins**: ${origs}`,
        ].join("\n"));
        break;
      }
      default: {
        await this.dmReply(senderEmail, [
          "Available commands:",
          "- `set-stream <stream name>` — set the stream to post messages to",
          "- `rotate-id` — rotate siteId (existing sessions are disconnected)",
          "- `set-origin <origin,...>` — set allowed origins (empty to clear)",
          "- `show` — show current configuration",
        ].join("\n"));
        break;
      }
    }
  }

  private async dmReply(toEmail: string, content: string): Promise<void> {
    const body = new URLSearchParams({
      type: "private",
      to: JSON.stringify([toEmail]),
      content,
    });
    await this.zulipFetch("/messages", { method: "POST", body }).catch((e) =>
      console.error("[zulip:dm]", e),
    );
  }
}
