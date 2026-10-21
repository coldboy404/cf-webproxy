// Uses the workerd/Miniflare version shipped with this repository's Wrangler.
// Run after npm ci (root), npm ci --prefix pages and npm run build --prefix pages.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomBytes, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { FRAME, encodeFrame, parseFrames } from "../src/protocol.js";
const rootRequire = createRequire(new URL("../package.json", import.meta.url));
const wranglerRequire = createRequire(rootRequire.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const SECRET = randomBytes(16).toString("hex"), HOST = "127.0.0.1";
const config = await readFile(new URL("./wrangler.toml", import.meta.url), "utf8");
const compatibilityDate = config.match(/compatibility_date\s*=\s*"([^"]+)"/)[1];
const options = {
  modules: true, scriptPath: fileURLToPath(new URL("./dist/_worker.js", import.meta.url)),
  compatibilityDate, bindings: { PROXY_SECRET: SECRET, MAX_STREAMS: "1" },
};
const runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
const sockets = [];
async function attach(protocol) {
  const url = new URL("/api/v1/ws", await runtime.ready); url.protocol = "ws:";
  const socket = new WebSocket(url, protocol); socket.binaryType = "arraybuffer"; sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("WebSocket upgrade timeout")), 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(Error("WebSocket upgrade failed")); }, { once: true });
  });
  assert.equal(socket.protocol, protocol); return socket;
}
async function request(path, options) { return runtime.dispatchFetch("https://" + HOST + path, options); }
function receive(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(Error("WebSocket response timeout")); }, 5000);
    const listener = event => { cleanup(); resolve(parseFrames(new Uint8Array(event.data))); };
    function cleanup() { clearTimeout(timeout); socket.removeEventListener("message", listener); }
    socket.addEventListener("message", listener);
  });
}
try {
  const health = await request("/healthz");
  assert.equal(health.status, 200); assert.equal((await health.json()).relay, "direct-telegram-dc");
  const capability = createHmac("sha256", Buffer.from(SECRET, "hex")).update("tdesktop-web-proxy-bridge-v1\n" + HOST).digest("base64url");
  const bridge = await request("/?bridge=" + capability);
  const bootstrap = JSON.parse((await bridge.text()).match(/const cfg=(.*);/)[1]).bootstrap;
  const created = await request("/api/v1/session", { method: "POST", headers: { Authorization: "Bearer " + bootstrap, "Content-Type": "application/octet-stream" }, body: encodeFrame(FRAME.HELLO, 0, new Uint8Array([1])) });
  assert.equal(created.status, 200);
  assert.deepEqual(new Uint8Array(await created.arrayBuffer()), encodeFrame(FRAME.WELCOME, 0));
  const token = created.headers.get("X-Session-Token"), protocol = "tproxy-v1." + token;
  const invalid = await request("/api/v1/session", { method: "DELETE", headers: { Authorization: "Bearer " + "A".repeat(43) } });
  assert.equal(invalid.status, 404); await invalid.text();
  const socket = await attach(protocol);
  let received = receive(socket);
  // The second OPEN must be rejected while the first stream stays alive.
  socket.send(Buffer.concat([encodeFrame(FRAME.OPEN, 1), encodeFrame(FRAME.OPEN, 2)]));
  let frames = await received;
  assert.equal(frames[0].type, FRAME.CLOSE); assert.equal(frames[0].streamId, 2);
  const deleted = await request("/api/v1/session", { method: "DELETE", headers: { Authorization: "Bearer " + token } });
  assert.equal(deleted.status, 405);
  // Authenticated invalid input closes only this session, without DO storage.
  received = receive(socket); socket.send(new Uint8Array([1])); frames = await received;
  assert.equal(frames[0].type, FRAME.BYE);
  await attach(protocol);
  console.log("Pages workerd smoke passed: HTTP, Bridge, HELLO, auth, WebSocket, stream limit, cleanup, independent attachment; no DO bindings.");
} finally {
  await Promise.all(sockets.map(socket => new Promise(resolve => {
    if (socket.readyState === 3) return resolve();
    const timer = setTimeout(resolve, 1000);
    socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
    try { socket.close(1000, "test complete"); } catch { clearTimeout(timer); resolve(); }
  })));
  // Allow workerd's local upgraded HTTP sockets to finish closing before teardown.
  await new Promise(resolve => setTimeout(resolve, 100));
  await runtime.dispose();
}
