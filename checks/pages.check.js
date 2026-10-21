import test from "node:test";
import assert from "node:assert/strict";
import { createProxyHandler } from "../src/http.js";
import { createPagesBackend, PagesRelaySession } from "../src/pages/session.js";
import { FRAME, encodeFrame, parseFrames } from "../src/protocol.js";
const HOST = "proxy.example.com", SECRET = "12".repeat(16);
function fixture(t) {
  const tasks = [], sockets = [];
  const ctx = { waitUntil(p) { tasks.push(p); }, get storage() { throw Error("Pages cannot access DO storage"); } };
  const env = { PROXY_SECRET: SECRET, get SESSIONS() { throw Error("Pages cannot require DO binding"); } };
  const backend = createPagesBackend(() => { throw Error("unexpected TCP"); });
  const handler = createProxyHandler(backend);
  const OriginalResponse = globalThis.Response;
  t.mock.method(globalThis, "Response", function(body, init) {
    if (init?.status === 101) return { ...init, headers: new Headers(init.headers) };
    return new OriginalResponse(body, init);
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  globalThis.WebSocketPair = class {
    constructor() {
      const events = new Map();
      const server = { readyState: 1, sent: [], accept() {},
        send(data) { this.sent.push(...parseFrames(data)); },
        close() { this.readyState = 3; },
        addEventListener(name, fn) { events.set(name, fn); },
        emit(name, event = {}) { return events.get(name)?.(event); },
      };
      this[0] = {}; this[1] = server; sockets.push(server);
    }
  };
  t.after(async () => {
    for (const socket of sockets) socket.emit("close");
    await Promise.all(tasks);
    if (previous) Object.defineProperty(globalThis, "WebSocketPair", previous);
    else delete globalThis.WebSocketPair;
  });
  const request = (path, init) => handler.fetch(new Request("https://" + HOST + path, init), env, ctx);
  const attach = token => request("/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1." + token } });
  return { env, ctx, backend, handler, request, attach, sockets, tasks };
}
async function bootstrap(f) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(SECRET, "hex"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("tdesktop-web-proxy-bridge-v1\n" + HOST));
  const response = await f.request("/?bridge=" + Buffer.from(mac).toString("base64url"));
  assert.equal(response.status, 200);
  return JSON.parse((await response.text()).match(/const cfg=(.*);/)[1]).bootstrap;
}
async function create(f) {
  const response = await f.request("/api/v1/session", { method: "POST", headers: { Authorization: "Bearer " + await bootstrap(f), "Content-Type": "application/octet-stream" }, body: encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])) });
  assert.equal(response.status, 200); assert.equal(response.headers.get("X-Carrier-Mode"), "websocket");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), encodeFrame(FRAME.WELCOME, 0));
  return response.headers.get("X-Session-Token");
}
test("Pages completes Bridge/HELLO/WS/control-frame flow without Durable Objects", async t => {
  const f = fixture(t), token = await create(f), response = await f.attach(token);
  assert.equal(response.status, 101);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), "tproxy-v1." + token);
  await f.sockets[0].emit("message", { data: encodeFrame(FRAME.PONG, 0, new Uint8Array([7])).buffer });
  assert.equal(f.sockets[0].sent.length, 0);
  assert.equal(f.sockets[0].readyState, 1);
});
test("Pages rejects invalid auth/HELLO/cookies before allocating a socket", async t => {
  const f = fixture(t), token = await create(f);
  assert.equal((await f.attach("A".repeat(43))).status, 404);
  const auth = await bootstrap(f);
  for (const [body, cookie] of [[encodeFrame(FRAME.OPEN, 1), false], [new Uint8Array(1024 * 1024), false], [encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])), true]]) {
    assert.equal((await f.request("/api/v1/session", { method: "POST", headers: { Authorization: "Bearer " + auth, "Content-Type": "application/octet-stream", ...(cookie ? { Cookie: "x=1" } : {}) }, body })).status, 404);
  }
  f.env.PUBLIC_HOSTNAME = "other.example.com";
  assert.equal((await f.attach(token)).status, 404); assert.equal(f.sockets.length, 0);
});
test("Pages replay creates independent connections; DELETE does not claim revocation", async t => {
  const f = fixture(t), token = await create(f);
  assert.equal((await f.attach(token)).status, 101); assert.equal((await f.attach(token)).status, 101);
  const response = await f.request("/api/v1/session", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  assert.equal(response.status, 405); assert.equal(response.headers.get("Allow"), "POST");
  f.sockets[0].emit("close"); assert.equal(f.sockets[0].readyState, 3); assert.equal(f.sockets[1].readyState, 1);
  await f.sockets[1].emit("message", { data: encodeFrame(FRAME.PONG, 0).buffer });
  assert.equal(f.sockets[1].sent.length, 0); assert.equal(f.sockets[1].readyState, 1);
});
test("Pages active sockets survive ticket expiry, but new attachments fail", async t => {
  let now = 2000000000000; t.mock.method(Date, "now", () => now);
  const f = fixture(t), token = await create(f);
  assert.equal((await f.attach(token)).status, 101); now += 60000;
  assert.equal((await f.attach(token)).status, 404);
  await f.sockets[0].emit("message", { data: encodeFrame(FRAME.PONG, 0).buffer });
  assert.equal(f.sockets[0].sent.length, 0); assert.equal(f.sockets[0].readyState, 1);
});
for (const event of ["close", "error", "malformed"]) test("Pages " + event + " releases socket, streams and waiters without storage", async t => {
  const f = fixture(t), session = new PagesRelaySession(f.ctx, f.env, () => { throw Error("unexpected TCP"); });
  t.after(() => session.shutdown());
  assert.equal(session.acceptWebSocket("tproxy-v1.test").status, 101);
  assert.equal(session.acceptWebSocket("tproxy-v1.test").status, 409);
  await session.enqueueMessage(encodeFrame(FRAME.OPEN, 1).buffer);
  let closes = 0, wakeups = 0;
  session.streams.get(1).socket = { close() { closes++; } };
  session.downlinkWaiters.add(() => wakeups++);
  if (event === "malformed") await f.sockets[0].emit("message", { data: new Uint8Array([1]).buffer });
  else f.sockets[0].emit(event);
  await Promise.all(f.tasks);
  assert.equal(session.closed, true); assert.equal(session.ws, null);
  assert.equal(closes, 1); assert.equal(wakeups, 1);
  assert.equal(session.streams.size, 0); assert.equal(session.downlinkWaiters.size, 0);
  assert.equal(session.ingressBytes, 0); assert.equal(session.uplinkBytes, 0);
  assert.equal(session.acceptWebSocket("tproxy-v1.test").status, 404);
});
