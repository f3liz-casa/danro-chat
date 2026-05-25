import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { WebSocket } from "ws";
import type { Target } from "./adapter.js";
import { newVisitorId, type VisitorId } from "./names.js";

export type Conversation = {
  visitorId: VisitorId;
  target: Target;
  nickname: string | null;
  email: string | null;
  locale: string | null;
  topic: string;
  ws: WebSocket | null;
};

type Persisted = Record<VisitorId, { target?: Target; nickname?: string | null; email?: string | null; locale?: string | null; topic: string }>;

function topicKey(target: Target, topic: string): string {
  return `${target}:${topic}`;
}

const STORE_PATH = process.env.STORE_PATH ?? "data/conversations.json";

const byVisitor = new Map<VisitorId, Conversation>();
const byTopic = new Map<string, VisitorId>();

function load(): void {
  if (!existsSync(STORE_PATH)) return;
  const raw = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Persisted;
  for (const [id, v] of Object.entries(raw)) {
    const target = v.target ?? "zulip";
    byVisitor.set(id, { visitorId: id, target, nickname: v.nickname ?? null, email: v.email ?? null, locale: v.locale ?? null, topic: v.topic, ws: null });
    if (v.topic) byTopic.set(topicKey(target, v.topic), id);
  }
}

function save(): void {
  const out: Persisted = {};
  for (const [id, c] of byVisitor) out[id] = { target: c.target, nickname: c.nickname, email: c.email, locale: c.locale, topic: c.topic };
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(out, null, 2));
}

load();

export type AttachResult = { conv: Conversation; returning: boolean };

export function attach(visitorId: VisitorId | null, ws: WebSocket, target: Target, locale?: string | null): AttachResult {
  if (visitorId) {
    const existing = byVisitor.get(visitorId);
    if (existing) {
      existing.ws = ws;
      return { conv: existing, returning: true };
    }
  }
  const id = visitorId ?? newVisitorId();
  const conv: Conversation = { visitorId: id, target, nickname: null, email: null, locale: locale ?? null, topic: "", ws };
  byVisitor.set(id, conv);
  save();
  return { conv, returning: false };
}

export function detach(visitorId: VisitorId): void {
  const c = byVisitor.get(visitorId);
  if (c) c.ws = null;
}

export function setNickname(visitorId: VisitorId, nickname: string): Conversation | null {
  const c = byVisitor.get(visitorId);
  if (!c) return null;
  const cleaned = nickname.trim();
  if (cleaned.length === 0) return c;
  c.nickname = cleaned.slice(0, 40);
  save();
  return c;
}

export function setEmail(visitorId: VisitorId, email: string | null): Conversation | null {
  const c = byVisitor.get(visitorId);
  if (!c) return null;
  const cleaned = email?.trim();
  c.email = cleaned && cleaned.length > 0 ? cleaned.slice(0, 200) : null;
  save();
  return c;
}

export function ensureTopic(visitorId: VisitorId): string | null {
  const c = byVisitor.get(visitorId);
  if (!c || !c.nickname) return null;
  if (c.topic) return c.topic;
  const localeTag = c.locale ? `[${c.locale}] ` : "";
  const idHead = c.visitorId.slice(0, 4);
  const base = `${localeTag}${c.nickname} (${idHead})`;
  let candidate = base;
  for (let n = 2; byTopic.has(topicKey(c.target, candidate)); n++) {
    candidate = `${base} #${n}`;
  }
  c.topic = candidate;
  byTopic.set(topicKey(c.target, candidate), visitorId);
  save();
  return candidate;
}

export function getByTopic(target: Target, topic: string): Conversation | null {
  const id = byTopic.get(topicKey(target, topic));
  if (!id) return null;
  return byVisitor.get(id) ?? null;
}
