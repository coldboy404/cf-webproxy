import test from "node:test";
import assert from "node:assert/strict";
import { createProxyHandler, createSessionToken, verifySessionToken } from "../src/http.js";
import { FRAME, encodeFrame } from "../src/protocol.js";
import { canonicalHost, entranceHost } from "../src/config.js";
const secret = "12".repeat(16);
const host = "preferred.example.com";
function fixture(extra = {}) {
  let calls = 0;
  const env = { PROXY_SECRET: secret, ...extra };
  const handler = createProxyHandler({ createToken: createSessionToken, verifyToken: verifySessionToken,
    initialize: async () => { calls++; return true; }, attach: () => { calls++; return new Response(null, { status: 204 }); } });
  const request = (path, init = {}, domain = host) => handler.fetch(new Request(`https://${domain}${path}`, init), env);
  return { env, request, calls: () => calls };
}
async function bootstrap(f, domain = host) {
  const key = await crypto.subtle.importKey("raw", Buffer.from(secret, "hex"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${domain}`));
  const response = await f.request("/?bridge=" + Buffer.from(mac).toString("base64url"), {}, domain);
  return JSON.parse((await response.text()).match(/const cfg=(.*);/)[1]).bootstrap;
}
test("entrance allowlist normalizes DNS names, rejects invalid values and keeps old strict pin", () => {
  assert.equal(canonicalHost(" Preferred.Example.com. "), host);
  for (const invalid of ["https://example.com", "example.com:443", "example.com/path", "a..com", "*.example.com", "x.com\nscript", "example.com,", "localhost"]) {
    assert.throws(() => canonicalHost(invalid));
  }
  const env = { ALLOWED_HOSTNAMES: ` ${host.toUpperCase()},backup.example.com ` };
  assert.equal(entranceHost(env, host), host);
  assert.equal(entranceHost(env, "unknown.example.com"), null);
  assert.equal(entranceHost({ ...env, PUBLIC_HOSTNAME: host }, "backup.example.com"), null);
});
test("health aliases report transport and invalid configuration fails closed without secrets", async () => {
  for (const path of ["/healthz", "/health"]) {
    const f = fixture({ RELAY_TRANSPORT: "kws" });
    assert.deepEqual(await (await f.request(path)).json(), { ok: true, carrier: "websocket", relay: "telegram-kws" });
    for (const extra of [{ PROXY_SECRET: "" }, { PROXY_SECRET: "z".repeat(32) }, { RELAY_TRANSPORT: "typo" }, { ALLOWED_HOSTNAMES: "https://example.com" }]) {
      const response = await fixture(extra).request(path);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { ok: false, error: "invalid_configuration" });
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  }
});
test("preferred entrance authenticates with its own hostname, no redirect and no cross-host ticket reuse", async () => {
  const f = fixture({ ALLOWED_HOSTNAMES: `${host},backup.example.com` });
  const token = await bootstrap(f);
  const response = await f.request("/api/v1/session", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", Origin: `https://${host}` }, body: encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])) });
  assert.equal(response.status, 200);
  const session = response.headers.get("X-Session-Token");
  const headers = { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tproxy-v1.${session}` };
  assert.equal((await f.request("/api/v1/ws", { headers })).status, 204);
  assert.equal((await f.request("/api/v1/ws", { headers }, "backup.example.com")).status, 404);
  assert.equal((await f.request("/healthz", { headers: { "X-Forwarded-Host": host } }, "other.example.com")).status, 404);
  for (const override of [{ Origin: "https://evil.example" }, { Origin: "null" }, { Cookie: "x=y" }]) {
    assert.equal((await f.request("/api/v1/ws", { headers: { ...headers, ...override } })).status, 404);
  }
  assert.equal((await f.request("/api/v1/ws", { method: "POST", headers })).status, 404);
  assert.equal(f.calls(), 2);
});
test("API rejects cross-origin session creation before allocating backend state", async () => {
  const f = fixture(), token = await bootstrap(f);
  assert.equal((await f.request("/api/v1/session", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", Origin: "https://evil.example" }, body: encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])) })).status, 404);
  assert.equal(f.calls(), 0);
});
