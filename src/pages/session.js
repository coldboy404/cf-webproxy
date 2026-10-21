import { RelaySession } from "../session.js";
import { createPagesToken, verifyPagesToken } from "./auth.js";

// One instance per incoming WebSocket request; never put live sockets in a
// module-global Map (Cloudflare may send other requests to another isolate).
export class PagesRelaySession extends RelaySession {
  shutdown(reason = "shutdown") {
    super.shutdown(reason, false); // No DO storage or alarm exists in Pages.
  }
}

export function createPagesBackend(connect) {
  return {
    createToken: createPagesToken,
    verifyToken: verifyPagesToken,
    async initialize() { return true; }, // Only mint a ticket; allocate on WS attach.
    attach(env, _token, protocol, ctx) {
      const session = new PagesRelaySession(ctx, env, connect);
      session.initialized = true;
      return session.acceptWebSocket(protocol);
    },
    async close() {
      // An HTTP DELETE cannot address a WebSocket in another Pages invocation.
      // The shared Bridge already closes its WebSocket before attempting DELETE.
      // Do not return a misleading 204 or claim cross-isolate revocation.
      return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
    },
  };
}
