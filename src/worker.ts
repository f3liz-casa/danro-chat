import { ChatServer } from "./chat-server.js";
import { chatWidgetJs } from "./widget-text.js";
export { ChatServer };

export interface Env {
  CHAT_SERVER: DurableObjectNamespace;
  ZULIP_REALM: string;
  ZULIP_USERNAME: string;
  ZULIP_API_KEY: string;
  ZULIP_STREAM?: string;
  ZULIP_VISITOR_EMOJI?: string;
  ZULIP_SITE_ID?: string;
  ZULIP_ORIGINS?: string;
  DISCORD_BOT_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  NOTIFY_URL?: string;
  LINK_SIGNING_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isWsUpgrade = request.headers.get("Upgrade") === "websocket";
    if (url.pathname === "/" && request.method === "GET" && !isWsUpgrade) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>danro-talk</title>` +
        `<style>body{margin:0;display:grid;place-items:center;min-height:100dvh;` +
        `background:#f4f2ed;font-family:-apple-system,sans-serif;color:#2b2a26}` +
        `p{font-size:14px;color:#6a6760;margin:8px 0 0}</style>` +
        `<div><div style="font-size:48px">🪵</div>` +
        `<p>hello. nothing to see here.</p></div>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }
    if (url.pathname === "/widget.js") {
      return new Response(chatWidgetJs, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    }
    const id = env.CHAT_SERVER.idFromName("main");
    const stub = env.CHAT_SERVER.get(id);
    return stub.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const id = env.CHAT_SERVER.idFromName("main");
    await env.CHAT_SERVER.get(id).fetch(new Request("https://internal/ping"));
  },
};
