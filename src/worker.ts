import { ChatServer } from "./chat-server.js";
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.CHAT_SERVER.idFromName("main");
    const stub = env.CHAT_SERVER.get(id);
    return stub.fetch(request);
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const id = env.CHAT_SERVER.idFromName("main");
    await env.CHAT_SERVER.get(id).fetch(new Request("https://internal/ping"));
  },
};
