export type Target = "zulip" | "discord";

export type Sender = {
  nickname: string;
  locale?: string | null;
};

export type InboundMessage = {
  topic: string;
  senderName: string;
  text: string;
};

export type HistoryMessage = {
  from: "visitor" | "agent";
  text: string;
  ts: number;
  senderName: string;
};

export type ValidateResult = { ok: true } | { ok: false; reason: string };

export type Adapter = {
  readonly target: Target;
  send(topic: string, sender: Sender, text: string): Promise<void>;
  fetchHistory(topic: string): Promise<HistoryMessage[]>;
  subscribe(onMessage: (m: InboundMessage) => void): Promise<void>;
  emojis(): Promise<Record<string, string>>;
  validateHello(siteId: string | undefined, origin: string | undefined): ValidateResult;
};
