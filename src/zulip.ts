// @ts-expect-error — zulip-js has no shipped types
import zulipInit from "zulip-js";
import type { Adapter, HistoryMessage, InboundMessage, Sender } from "./adapter.js";

type ZulipMessageEvent = {
  type: "message";
  message: {
    id: number;
    sender_email: string;
    sender_full_name: string;
    type: "stream" | "private";
    display_recipient: string;
    subject: string;
    content: string;
  };
};

type ZulipMessage = {
  id: number;
  sender_email: string;
  sender_full_name: string;
  subject: string;
  content: string;
  timestamp: number;
};

type ZulipNarrow = { operator: string; operand: string };
type ZulipRealmEmoji = { name: string; source_url: string; deactivated: boolean };

type ZulipClient = {
  emojis: {
    retrieve: () => Promise<{ result: string; emoji: Record<string, ZulipRealmEmoji> }>;
  };
  messages: {
    send: (p: { type: "stream"; to: string; topic: string; content: string }) => Promise<unknown>;
    retrieve: (p: {
      anchor: string | number;
      num_before: number;
      num_after: number;
      narrow: ZulipNarrow[];
      apply_markdown?: boolean;
    }) => Promise<{ result: string; messages: ZulipMessage[] }>;
  };
  callOnEachEvent: (cb: (e: ZulipMessageEvent) => void, types: string[]) => void;
};

const cfg = {
  realm: process.env.ZULIP_REALM!,
  username: process.env.ZULIP_USERNAME!,
  apiKey: process.env.ZULIP_API_KEY!,
};
const stream = process.env.ZULIP_STREAM!;
const visitorEmoji = process.env.ZULIP_VISITOR_EMOJI ?? "";
const requiredSiteId = process.env.ZULIP_SITE_ID ?? "";
const allowedOrigins = (process.env.ZULIP_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase().replace(/\/$/, ""))
  .filter((s) => s.length > 0);

let client: ZulipClient | null = null;
let botEmail = "";

async function getClient(): Promise<ZulipClient> {
  if (client) return client;
  client = (await zulipInit(cfg)) as ZulipClient;
  botEmail = cfg.username;
  return client;
}

const VISITOR_PREFIX_RE = /^(:[^:\s]+:\s+)?\*\*[^*\n]+\*\*\n/;
function stripVisitorPrefix(content: string): string {
  const body = content.replace(VISITOR_PREFIX_RE, "");
  return body.split("\n").map((line) => line.replace(/^> ?/, "")).join("\n");
}

export const zulipAdapter: Adapter = {
  target: "zulip",

  async send(topic, sender, text) {
    const c = await getClient();
    const prefix = visitorEmoji ? `${visitorEmoji} ` : "";
    const quoted = text.split("\n").map((line) => `> ${line}`).join("\n");
    const content = `${prefix}**${sender.nickname}**\n${quoted}`;
    await c.messages.send({ type: "stream", to: stream, topic, content });
  },

  async fetchHistory(topic): Promise<HistoryMessage[]> {
    const c = await getClient();
    const res = await c.messages.retrieve({
      anchor: "newest",
      num_before: 50,
      num_after: 0,
      narrow: [
        { operator: "stream", operand: stream },
        { operator: "topic", operand: topic },
      ],
      apply_markdown: false,
    });
    if (res.result !== "success") return [];
    return res.messages.map((m) => {
      const fromBot = m.sender_email === botEmail;
      return {
        from: fromBot ? ("visitor" as const) : ("agent" as const),
        text: fromBot ? stripVisitorPrefix(m.content) : m.content,
        ts: m.timestamp * 1000,
        senderName: m.sender_full_name,
      };
    });
  },

  async subscribe(onMessage: (m: InboundMessage) => void): Promise<void> {
    const c = await getClient();
    c.callOnEachEvent((event) => {
      if (event.type !== "message") return;
      const m = event.message;
      if (m.type !== "stream") return;
      if (m.display_recipient !== stream) return;
      if (m.sender_email === botEmail) return;
      onMessage({ topic: m.subject, senderName: m.sender_full_name, text: m.content });
    }, ["message"]);
  },

  validateHello(siteId, origin) {
    if (requiredSiteId && siteId !== requiredSiteId) return { ok: false, reason: "invalid_site_id" };
    if (allowedOrigins.length > 0) {
      if (!origin) return { ok: false, reason: "origin_required" };
      if (!allowedOrigins.includes(origin.toLowerCase().replace(/\/$/, ""))) {
        return { ok: false, reason: "origin_not_allowed" };
      }
    }
    return { ok: true };
  },

  async emojis(): Promise<Record<string, string>> {
    const c = await getClient();
    const res = await c.emojis.retrieve();
    if (res.result !== "success") return {};
    const out: Record<string, string> = {};
    const realmBase = cfg.realm.replace(/\/$/, "");
    for (const e of Object.values(res.emoji)) {
      if (e.deactivated) continue;
      const url = e.source_url.startsWith("http") ? e.source_url : `${realmBase}${e.source_url}`;
      out[e.name] = url;
    }
    return out;
  },
};

// Sender, HistoryMessage, InboundMessage re-exports kept lean; consumers import from adapter.ts
export type { Sender };
