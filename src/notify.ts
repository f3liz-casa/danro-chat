import { Resend } from "resend";
import type { Env } from "./worker.js";
import { signToken } from "./signed-link.js";

const COOLDOWN_MS = 5 * 60 * 1000;

type Locale = "ja" | "ko" | "en";

function pickLocale(raw: string | null | undefined): Locale {
  const s = (raw ?? "").toLowerCase();
  if (s.startsWith("ko")) return "ko";
  if (s.startsWith("ja")) return "ja";
  return "en";
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

function snippet(text: string, max = 200): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

type Body = { subject: string; html: string; text: string };

function compose(locale: Locale, senderName: string, text: string, url: string | null): Body {
  const sn = escape(senderName);
  const snip = snippet(text);
  const snipHtml = escape(snip);
  const link = url ? `\n\n${url}` : "";
  const linkHtml = url ? `<p><a href="${escape(url)}">${escape(url)}</a></p>` : "";

  if (locale === "ja") {
    return {
      subject: `${senderName}さんから返信が届きました`,
      text: `${senderName}さんから返信が届きました。\n\n> ${snip}${link}`,
      html: `<p><strong>${sn}</strong> さんから返信が届きました。</p><blockquote>${snipHtml}</blockquote>${linkHtml}`,
    };
  }
  if (locale === "ko") {
    return {
      subject: `${senderName}님이 답장을 보냈어요`,
      text: `${senderName}님이 답장을 보냈어요.\n\n> ${snip}${link}`,
      html: `<p><strong>${sn}</strong> 님이 답장을 보냈어요.</p><blockquote>${snipHtml}</blockquote>${linkHtml}`,
    };
  }
  return {
    subject: `New reply from ${senderName}`,
    text: `${senderName} replied:\n\n> ${snip}${link}`,
    html: `<p><strong>${sn}</strong> replied:</p><blockquote>${snipHtml}</blockquote>${linkHtml}`,
  };
}

export function shouldNotify(lastNotifiedAt: number | null | undefined, now: number): boolean {
  if (!lastNotifiedAt) return true;
  return now - lastNotifiedAt >= COOLDOWN_MS;
}

export async function sendNotification(
  env: Env,
  toEmail: string,
  visitorLocale: string | null | undefined,
  senderName: string,
  text: string,
  visitorId: string,
  pageUrl: string | null,
): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return;
  const locale = pickLocale(visitorLocale);
  const base = env.NOTIFY_URL ?? pageUrl;
  let url: string | null = null;
  if (base) {
    if (env.LINK_SIGNING_KEY) {
      const token = await signToken(env.LINK_SIGNING_KEY, visitorId);
      const sep = base.includes("?") ? "&" : "?";
      url = `${base}${sep}dt=${encodeURIComponent(token)}`;
    } else {
      url = base;
    }
  }
  const body = compose(locale, senderName, text, url);
  const resend = new Resend(env.RESEND_API_KEY);
  console.log(`[notify:resend:try] to=${toEmail} from=${env.RESEND_FROM} subject=${body.subject}`);
  const { data, error } = await resend.emails.send(
    {
      from: env.RESEND_FROM,
      to: [toEmail],
      subject: body.subject,
      html: body.html,
      text: body.text,
      tags: [{ name: "kind", value: "agent_reply" }],
    },
    { idempotencyKey: `agent-reply/${visitorId}/${Date.now()}` },
  );
  if (error) console.error("[notify:resend]", error);
  else console.log(`[notify:resend:ok] id=${data?.id}`);
}
