import { nanoid } from "nanoid";
import type { Env } from "./worker.js";
import type { Target, ConvData, ClientFrame, ServerFrame, HistoryMessage } from "./types.js";
import { normalizeOrigin, parseOrigins } from "./types.js";
import { ZulipAdapter } from "./zulip.js";
import { DiscordAdapter } from "./discord.js";
import type { InteractionData } from "./discord.js";

const NICKNAME_MAX_LEN = 40;
const ALARM_INTERVAL_MS = 20_000;
const EMAIL_MAX_LEN = 200;
const WS_POLICY_VIOLATION = 1008;
const WS_GOING_AWAY = 1001;

export class ChatServer implements DurableObject {
  readonly ctx: DurableObjectState;
  readonly env: Env;

  private convs = new Map<string, ConvData>();
  private topicIdx = new Map<string, string>(); // "target:topic" -> visitorId
  private sessions = new Map<string, WebSocket>(); // visitorId -> ws

  private zulip: ZulipAdapter;
  private discord: DiscordAdapter;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.zulip = new ZulipAdapter(
      env,
      ctx.storage,
      (topic, senderName, text) => this.deliverMessage("zulip", topic, senderName, text),
      () => this.closeSessions("zulip"),
      (oldTopic, newTopic) => this.handleTopicRename("zulip", oldTopic, newTopic),
    );
    this.discord = new DiscordAdapter(
      env,
      ctx.storage,
      (topic, senderName, text) => this.deliverMessage("discord", topic, senderName, text),
      () => this.closeSessions("discord"),
      (oldTopic, newTopic) => this.handleTopicRename("discord", oldTopic, newTopic),
    );
    ctx.blockConcurrencyWhile(() => this.init());
  }

  private handleTopicRename(target: Target, oldTopic: string, newTopic: string): void {
    const key = `${target}:${oldTopic}`;
    const vid = this.topicIdx.get(key);
    if (!vid) return;
    this.topicIdx.delete(key);
    this.topicIdx.set(`${target}:${newTopic}`, vid);
    const conv = this.convs.get(vid);
    if (conv) {
      conv.topic = newTopic;
      this.ctx.storage.put(`conv:${vid}`, conv);
    }
    const ws = this.sessions.get(vid);
    if (ws) this.wsSend(ws, { type: "topic_renamed", topic: newTopic });
  }

  private deliverMessage(target: Target, topic: string, senderName: string, text: string): void {
    const vid = this.topicIdx.get(`${target}:${topic}`);
    const ws = vid ? this.sessions.get(vid) : undefined;
    if (ws) this.wsSend(ws, { type: "message", from: "agent", text, ts: Date.now(), senderName });
  }

  private closeSessions(target: Target): void {
    for (const [vid, ws] of this.sessions) {
      if (this.convs.get(vid)?.target === target) {
        this.wsSend(ws, { type: "error", reason: "service_unavailable" });
        try {
          ws.close(WS_GOING_AWAY, `${target} disabled`);
        } catch {
          // ignore
        }
        this.sessions.delete(vid);
      }
    }
  }

  private async init(): Promise<void> {
    const convEntries = await this.ctx.storage.list<ConvData>({ prefix: "conv:" });
    for (const [, c] of convEntries) {
      this.convs.set(c.visitorId, c);
      if (c.topic) this.topicIdx.set(`${c.target}:${c.topic}`, c.visitorId);
    }
    await this.zulip.init();
    await this.discord.init();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.handleWsUpgrade(request);
    if (url.pathname === "/discord/interaction" && request.method === "POST") {
      const body = await request.json() as InteractionData;
      await this.discord.handleInteraction(body);
      return new Response("ok");
    }
    if (url.pathname === "/ping") {
      this.startServices();
      const existing = await this.ctx.storage.getAlarm();
      if (!existing) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
      return new Response("ok");
    }
    return new Response("Not Found", { status: 404 });
  }

  // ── WebSocket ─────────────────────────────────────────────────

  private handleWsUpgrade(request: Request): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const origin = request.headers.get("origin") ?? undefined;
    let vid: string | null = null;

    server.addEventListener("message", (event) => {
      this.onVisitorMessage(server, origin, event.data as string, () => vid, (id) => { vid = id; })
        .catch((e) => console.error("[ws:message]", e));
    });

    server.addEventListener("close", () => {
      if (vid) this.sessions.delete(vid);
      if (this.sessions.size === 0) this.stopServices();
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async onVisitorMessage(
    ws: WebSocket,
    origin: string | undefined,
    raw: string,
    getVid: () => string | null,
    setVid: (id: string) => void,
  ): Promise<void> {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(raw) as ClientFrame;
    } catch {
      this.wsSend(ws, { type: "error", reason: "invalid_json" });
      return;
    }

    if (frame.type === "hello") {
      const target: Target = frame.target ?? "zulip";
      const err = this.validateHello(target, frame.siteId, origin);
      if (err) {
        this.wsSend(ws, { type: "error", reason: err });
        ws.close(WS_POLICY_VIOLATION, err);
        return;
      }

      const { conv, returning } = this.attach(frame.visitorId ?? null, ws, target, frame.locale);
      setVid(conv.visitorId);
      const hasHistory = returning && !!conv.topic;
      const emojis = await this.fetchEmojis(target).catch(() => ({} as Record<string, string>));

      this.wsSend(ws, {
        type: "welcome",
        visitorId: conv.visitorId,
        nickname: conv.nickname,
        email: conv.email,
        returning,
        hasHistory,
        emojis,
      });

      if (hasHistory) {
        const history = await this.fetchHistory(target, conv.topic).catch(() => [] as HistoryMessage[]);
        for (const m of history) this.wsSend(ws, { type: "message", from: m.from, text: m.text, ts: m.ts, senderName: m.senderName });
        this.wsSend(ws, { type: "history_end" });
      }

      this.startServices();
      return;
    }

    const vid = getVid();
    if (!vid) {
      this.wsSend(ws, { type: "error", reason: "not_attached" });
      return;
    }

    if (frame.type === "set_nickname") {
      const conv = this.convs.get(vid);
      if (!conv) return;
      const cleaned = frame.nickname.trim().slice(0, NICKNAME_MAX_LEN);
      if (!cleaned) return;
      conv.nickname = cleaned;
      if (frame.email !== undefined) {
        const e = frame.email?.trim();
        conv.email = e && e.length > 0 ? e.slice(0, EMAIL_MAX_LEN) : null;
      }
      await this.ctx.storage.put(`conv:${vid}`, conv);
      this.wsSend(ws, { type: "nickname_updated", nickname: conv.nickname, email: conv.email });
      return;
    }

    if (frame.type === "message") {
      const conv = this.convs.get(vid);
      if (!conv) {
        this.wsSend(ws, { type: "error", reason: "not_attached" });
        return;
      }
      if (!conv.nickname) {
        this.wsSend(ws, { type: "error", reason: "no_nickname" });
        return;
      }
      const text = frame.text.trim();
      if (!text) return;
      const { topic, isNew } = await this.ensureTopic(conv);
      if (!topic) {
        this.wsSend(ws, { type: "error", reason: "no_topic" });
        return;
      }
      if (isNew) {
        await this.dispatchSystem(conv.target, topic, `visitor_id: \`${conv.visitorId}\``).catch(console.error);
      }
      this.wsSend(ws, { type: "message", from: "visitor", text, ts: Date.now() });
      try {
        await this.dispatchSend(conv.target, topic, conv.nickname, conv.locale, text);
      } catch (e) {
        console.error(`[${conv.target}:send]`, e);
        this.wsSend(ws, { type: "error", reason: "send_failed" });
      }
    }
  }

  private wsSend(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {}
  }

  // ── Conversation ──────────────────────────────────────────────

  private attach(id: string | null, ws: WebSocket, target: Target, locale?: string | null): { conv: ConvData; returning: boolean } {
    if (id) {
      const existing = this.convs.get(id);
      if (existing) {
        this.sessions.set(id, ws);
        return { conv: existing, returning: true };
      }
    }
    const visitorId = id ?? nanoid();
    const conv: ConvData = { visitorId, target, nickname: null, email: null, locale: locale ?? null, topic: "" };
    this.convs.set(visitorId, conv);
    this.sessions.set(visitorId, ws);
    this.ctx.storage.put(`conv:${visitorId}`, conv);
    return { conv, returning: false };
  }

  private async ensureTopic(conv: ConvData): Promise<{ topic: string | null; isNew: boolean }> {
    if (!conv.nickname) return { topic: null, isNew: false };
    if (conv.topic) return { topic: conv.topic, isNew: false };
    const now = new Date();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(now.getUTCDate()).padStart(2, "0");
    const localeTag = conv.locale ? `[${conv.locale}] ` : "";
    const base = `${mm}-${dd} ${localeTag}${conv.nickname}`;
    let candidate = base;
    for (let n = 2; this.topicIdx.has(`${conv.target}:${candidate}`); n++) candidate = `${base} #${n}`;
    conv.topic = candidate;
    this.topicIdx.set(`${conv.target}:${candidate}`, conv.visitorId);
    await this.ctx.storage.put(`conv:${conv.visitorId}`, conv);
    return { topic: candidate, isNew: true };
  }

  // ── Validation ────────────────────────────────────────────────

  private validateHello(target: Target, siteId: string | undefined, origin: string | undefined): string | null {
    if (target === "zulip") return this.zulip.validate(siteId, origin);
    if (target === "discord") return this.discord.validate(siteId, origin);
    return "unknown_target";
  }

  // ── Dispatch ──────────────────────────────────────────────────

  private async fetchEmojis(target: Target): Promise<Record<string, string>> {
    if (target === "zulip") return this.zulip.fetchEmojis();
    if (target === "discord") return this.discord.fetchEmojis();
    return {};
  }

  private async fetchHistory(target: Target, topic: string): Promise<HistoryMessage[]> {
    if (target === "zulip") return this.zulip.fetchHistory(topic);
    if (target === "discord") return this.discord.fetchHistory(topic);
    return [];
  }

  private async dispatchSend(target: Target, topic: string, nickname: string, _locale: string | null, text: string): Promise<void> {
    if (target === "zulip") return this.zulip.send(topic, nickname, text);
    if (target === "discord") return this.discord.send(topic, nickname, text);
  }

  private async dispatchSystem(target: Target, topic: string, text: string): Promise<void> {
    if (target === "zulip") return this.zulip.sendSystem(topic, text);
    if (target === "discord") return this.discord.sendSystem(topic, text);
  }

  // ── Alarm ─────────────────────────────────────────────────────

  async alarm(): Promise<void> {
    this.startServices();
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // ── Service lifecycle ─────────────────────────────────────────

  private startServices(): void {
    this.zulip.start();
    this.discord.start();
  }

  private stopServices(): void {
    this.zulip.stop();
    this.discord.stop();
  }
}
