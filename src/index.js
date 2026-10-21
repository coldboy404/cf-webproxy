import { connect } from "cloudflare:sockets";
import { RelaySession } from "./session.js";
import { createProxyHandler, createSessionToken, verifySessionToken } from "./http.js";

// Preserve the original Workers + Durable Objects deployment and token format.
export default createProxyHandler({
  createToken: createSessionToken,
  verifyToken: verifySessionToken,
  async initialize(env, token) {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    const response = await stub.fetch("https://session/internal/init", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return response.ok;
  },
  attach(env, token, protocol) {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    return stub.fetch("https://session/internal/ws", {
      headers: { Upgrade: "websocket", "X-TProxy-Protocol": protocol },
    });
  },
  async close(env, token) {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    await stub.fetch("https://session/internal/close", { method: "POST" });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  },
});

export { _check } from "./http.js";

export class WebProxySession extends RelaySession {
  constructor(ctx, env) { super(ctx, env, connect); }
}
