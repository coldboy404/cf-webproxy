import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { FRAME, encodeFrame } from "../src/protocol.js";

// Only Node unit tests stub the Workers-only module; production uses the real API.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:sockets") return { url: 'data:text/javascript,export function connect(){throw Error("unexpected real TCP");}', shortCircuit: true };
  return next(specifier, context);
} });
const { default: worker, _check } = await import("../src/index.js");
hooks.deregister();
const HOST = "proxy.example.com", SECRET = "12".repeat(16);
function fixture() {
  const calls = [], env = { PROXY_SECRET: SECRET, SESSIONS: {
    idFromName(token) { return token; }, get(token) { return { async fetch(url, options) { calls.push({ token, url, options }); return new Response(null, { status: 204 }); } }; },
  } };
  return { env, calls };
}
async function bootstrap(env, host = HOST) {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(Buffer.from(env.PROXY_SECRET, "hex")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("tdesktop-web-proxy-bridge-v1\n" + host));
  const capability = Buffer.from(mac).toString("base64url");
  const response = await worker.fetch(new Request("https://" + host + "/?bridge=" + capability), env);
  const html = await response.text(); return JSON.parse(html.match(/const cfg=(.*);/)[1]).bootstrap;
}
async function create(env) {
  return worker.fetch(new Request("https://" + HOST + "/api/v1/session", { method: "POST", headers: { Authorization: "Bearer " + await bootstrap(env), "Content-Type": "application/octet-stream" }, body: encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])) }), env);
}
test("Bridge capability is strict and secret authentication hides the Bridge", async () => {
  const { env } = fixture();
  const response = await worker.fetch(new Request("https://" + HOST + "/?bridge=" + "A".repeat(43)), env);
  assert.equal(response.status, 200); assert.ok(!(await response.text()).includes("synthetic-bootstrap"));
  assert.equal(_check.exactBridgeQuery(new URL("https://" + HOST + "/?bridge=" + "A".repeat(43) + "&x=1")), null);
  assert.equal(_check.isHello(encodeFrame(FRAME.HELLO, 0, new Uint8Array([1]))), true);
});
test("session token keeps 43-character format and authenticates WS/delete before DO lookup", async () => {
  const { env, calls } = fixture(), response = await create(env);
  assert.equal(response.status, 200); const token = response.headers.get("X-Session-Token");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.equal(calls.length, 1);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), encodeFrame(FRAME.WELCOME, 0));
  await worker.fetch(new Request("https://" + HOST + "/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1." + token } }), env);
  assert.equal(calls.length, 2); assert.equal(calls.at(-1).token, token);
  await worker.fetch(new Request("https://" + HOST + "/api/v1/session", { method: "DELETE", headers: { Authorization: "Bearer " + token } }), env);
  assert.equal(calls.length, 3);
  for (const invalid of ["A".repeat(43), token.slice(0, -1) + (token.at(-1) === "A" ? "B" : "A")]) {
    const ws = await worker.fetch(new Request("https://" + HOST + "/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1." + invalid } }), env);
    const del = await worker.fetch(new Request("https://" + HOST + "/api/v1/session", { method: "DELETE", headers: { Authorization: "Bearer " + invalid } }), env);
    assert.equal(ws.status, 404); assert.equal(del.status, 404); assert.equal(calls.length, 3);
  }
  const wrongHost = await worker.fetch(new Request("https://other.example/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1." + token } }), env);
  assert.equal(wrongHost.status, 404); assert.equal(calls.length, 3);
});
test("HTTP API rejects cookies, malformed HELLO and oversized authenticated bodies", async () => {
  const { env, calls } = fixture(), credential = await bootstrap(env);
  for (const [body, cookie] of [[encodeFrame(FRAME.OPEN, 1), false], [new Uint8Array(1024 * 1024), false], [encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])), true]]) {
    const headers = { Authorization: "Bearer " + credential, "Content-Type": "application/octet-stream" };
    if (cookie) headers.Cookie = "unexpected=1";
    const response = await worker.fetch(new Request("https://" + HOST + "/api/v1/session", { method: "POST", headers, body }), env);
    assert.equal(response.status, 404); assert.equal(calls.length, 0);
  }
});
test("PUBLIC_HOSTNAME and health endpoint retain existing behavior", async () => {
  const { env } = fixture(); env.PUBLIC_HOSTNAME = HOST;
  const wrong = await worker.fetch(new Request("https://other.example/healthz"), env); assert.equal(wrong.status, 404);
  const health = await worker.fetch(new Request("https://" + HOST + "/healthz"), env);
  assert.deepEqual(await health.json(), { ok: true, carrier: "websocket", relay: "direct-telegram-dc" });
});

test("rotating PROXY_SECRET rejects old credentials even with warm cached keys", async () => {
  const { env, calls } = fixture();
  const oldBootstrap = await bootstrap(env);
  const oldSession = (await create(env)).headers.get("X-Session-Token");
  env.PROXY_SECRET = "34".repeat(16);
  const before = calls.length;
  const ws = await worker.fetch(new Request("https://" + HOST + "/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1." + oldSession } }), env);
  assert.equal(ws.status, 404);
  const post = await worker.fetch(new Request("https://" + HOST + "/api/v1/session", { method: "POST", headers: { Authorization: "Bearer " + oldBootstrap, "Content-Type": "application/octet-stream" }, body: encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])) }), env);
  assert.equal(post.status, 404); assert.equal(calls.length, before);
  const fresh = await create(env); assert.equal(fresh.status, 200);
  const token = fresh.headers.get("X-Session-Token");
  const accepted = await worker.fetch(new Request("https://" + HOST + "/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1." + token } }), env);
  assert.equal(accepted.status, 204); assert.equal(calls.at(-1).token, token);
});
