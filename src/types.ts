export type Target = "zulip" | "discord";

export type ConvData = {
  visitorId: string;
  target: Target;
  nickname: string | null;
  email: string | null;
  locale: string | null;
  topic: string;
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
