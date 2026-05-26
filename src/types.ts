export type Target = "zulip" | "discord";

export type ConvData = {
  visitorId: string;
  target: Target;
  nickname: string | null;
  email: string | null;
  locale: string | null;
  topic: string;
  lastNotifiedAt?: number | null;
  pageUrl?: string | null;
};

export type DiscordConfig = {
  siteId: string;
  guildId: string;
  channelId: string;
  webhookUrl: string;
  origins: string[];
};

export type HistoryMessage = {
  from: "visitor" | "agent";
  text: string;
  ts: number;
  senderName: string;
};

export type ClientHello = {
  type: "hello";
  visitorId?: string;
  locale?: string;
  target?: Target;
  siteId?: string;
  signedToken?: string;
  pageUrl?: string;
};
export type ClientMessage = { type: "message"; text: string };
export type ClientSetNickname = { type: "set_nickname"; nickname: string; email?: string | null };
export type ClientFrame = ClientHello | ClientMessage | ClientSetNickname;

export type ServerFrame =
  | {
      type: "welcome";
      visitorId: string;
      nickname: string | null;
      email: string | null;
      returning: boolean;
      hasHistory: boolean;
      emojis: Record<string, string>;
    }
  | { type: "nickname_updated"; nickname: string | null; email: string | null }
  | { type: "topic_renamed"; topic: string }
  | { type: "message"; from: "visitor" | "agent"; text: string; ts: number; senderName?: string }
  | { type: "history_end" }
  | { type: "error"; reason: string };

export function normalizeOrigin(s: string): string {
  return s.trim().toLowerCase().replace(/\/$/, "");
}

export function parseOrigins(raw: string): string[] {
  return raw.split(",").map(normalizeOrigin).filter(Boolean);
}

const PAGE_URL_MAX_LEN = 500;
export function sanitizePageUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const cleaned = `${u.origin}${u.pathname}`;
    if (cleaned.length > PAGE_URL_MAX_LEN) return null;
    return cleaned;
  } catch {
    return null;
  }
}
