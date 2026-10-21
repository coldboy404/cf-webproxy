import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { PacketFramer, connectKws, kwsUrls, relayTransport, KWS_LIMITS } from "../src/kws.js";
import { RelaySession } from "../src/session.js";
import { PagesRelaySession } from "../src/pages/session.js";
import { AesCtrStream } from "../src/mtproxy.js";
import { FRAME, encodeFrame, parseFrames } from "../src/protocol.js";

const concat = (...parts) => new Uint8Array(Buffer.concat(parts.map(p => Buffer.from(p))));

for (const Session of [RelaySession, PagesRelaySession]) test(`${Session.name}: real handshake and packet crypto preserve WS message boundaries and downlink`, async t => {
  const tasks = [], sent = [];
  let upstream;
  const session = new Session({ waitUntil(p) { tasks.push(p); } },
    { PROXY_SECRET: "12".repeat(16), RELAY_TRANSPORT: "kws" },
    () => assert.fail("KWS must not dial TCP"),
    (dcId, options) => {
      assert.equal(dcId, -2);
      upstream = connectKws(dcId, { ...options, WebSocket: FakeWebSocket });
      return upstream;
    });
  session.ws = { readyState: 1, send(data) { sent.push(...parseFrames(data)); }, close() {} };
  t.after(async () => { session.shutdown("test", false); await Promise.all(tasks); });
  const plain = crypto.getRandomValues(new Uint8Array(64));
  const v = new DataView(plain.buffer); v.setUint32(56, 0xeeeeeeee, true); v.setInt16(60, -2, true);
  const material = plain.slice(8, 56), reverse = new Uint8Array(material).reverse();
  async function secretKey(bytes) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", concat(bytes, new Uint8Array(16).fill(0x12))));
  }
  const tx = new AesCtrStream(await secretKey(material.subarray(0, 32)), material.subarray(32));
  const rx = new AesCtrStream(await secretKey(reverse.subarray(0, 32)), reverse.subarray(32));
  const encryptedHeader = await tx.crypt(plain), wire = new Uint8Array(plain);
  wire.set(encryptedHeader.subarray(56), 56);
  const packets = [intermediate(new Uint8Array(80).fill(9), true), intermediate(new Uint8Array(12).fill(7))];
  const encrypted = await tx.crypt(concat(...packets));
  await session.enqueueMessage(concat(encodeFrame(FRAME.OPEN, 1), encodeFrame(FRAME.DATA, 1, concat(wire, encrypted.subarray(0, 9)))).buffer);
  await until(() => upstream);
  const ws = FakeWebSocket.instances.at(-1); assert.match(ws.url, /kws2-1/);
  ws.open();
  await until(() => session.uplinkItems === 0);
  assert.deepEqual(ws.sent.map(x => x.length), [64], "partial packet must not be sent");
  await session.enqueueMessage(encodeFrame(FRAME.DATA, 1, encrypted.subarray(9)).buffer);
  await until(() => session.uplinkItems === 0);
  assert.deepEqual(ws.sent.map(x => x.length), [64, ...packets.map(p => p.length)]);
  const tgMaterial = ws.sent[0].slice(8, 56), tgReverse = new Uint8Array(tgMaterial).reverse();
  const tgRx = new AesCtrStream(tgMaterial.subarray(0, 32), tgMaterial.subarray(32));
  const tgHeader = await tgRx.crypt(ws.sent[0]);
  assert.equal(new DataView(tgHeader.buffer).getUint32(56, true), 0xeeeeeeee);
  for (let i = 0; i < packets.length; i++) assert.deepEqual(await tgRx.crypt(ws.sent[i + 1]), packets[i]);
  const tgTx = new AesCtrStream(tgReverse.subarray(0, 32), tgReverse.subarray(32));
  const reply = intermediate(new Uint8Array(16).fill(4));
  ws.message((await tgTx.crypt(reply)).buffer);
  await until(() => sent.some(f => f.type === FRAME.DATA));
  assert.deepEqual(await rx.crypt(concat(...sent.filter(f => f.type === FRAME.DATA).map(f => f.payload))), reply);
  const grant = sent.filter(f => f.type === FRAME.WINDOW).reduce((n, f) => n + new DataView(f.payload.buffer, f.payload.byteOffset).getUint32(0), 0);
  assert.equal(grant, 64 + encrypted.length);
});
function intermediate(body, quick = false) {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, body.length + (quick ? 0x80000000 : 0), true);
  return concat(header, body);
}
class FakeWebSocket extends EventTarget {
  static instances = [];
  constructor(url, protocol) {
    super(); this.url = url; this.protocol = protocol; this.readyState = 0;
    this.sent = []; this.bufferedAmount = 0; this.closes = 0;
    FakeWebSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  send(value) { if (this.readyState !== 1) throw Error("not open"); this.sent.push(new Uint8Array(value)); }
  close() { this.closes++; this.readyState = 3; }
  message(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  fail() { this.dispatchEvent(new Event("error")); }
}
async function until(check) {
  // WebCrypto completion is not bounded by a count of event-loop turns.
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) { if (check()) return; await setImmediate(); }
  assert.fail("condition did not become true");
}
function socket(t, options = {}) {
  FakeWebSocket.instances = [];
  const result = connectKws(2, { WebSocket: FakeWebSocket, ...options });
  t.after(() => result.close());
  return result;
}

test("fetch Upgrade uses HTTPS, manual redirects and negotiated binary protocol", async t => {
  const requests = [], ws = new FakeWebSocket("mock", "binary");
  ws.readyState = 1; ws.accept = () => { ws.accepted = true; };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    return { status: 101, webSocket: ws, headers: new Headers({ "Sec-WebSocket-Protocol": "binary" }) };
  });
  const s = connectKws(-5); t.after(() => s.close());
  await s.opened;
  assert.equal(requests[0].url, "https://kws5-1.web.telegram.org/apiws");
  assert.equal(requests[0].options.headers.Upgrade, "websocket");
  assert.equal(requests[0].options.headers["Sec-WebSocket-Protocol"], "binary");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(ws.accepted, true);
  await s.writable.getWriter().write(new Uint8Array(64));
  assert.equal(ws.sent[0].length, 64);
});

test("fetch dial cancellation closes late upgrades without resurrecting stream", async t => {
  let resolve;
  t.mock.method(globalThis, "fetch", () => new Promise(r => { resolve = r; }));
  const abort = new AbortController(), s = connectKws(1, { signal: abort.signal });
  const rejected = assert.rejects(s.opened, /aborted/);
  abort.abort(); await rejected;
  const ws = new FakeWebSocket("mock", "binary"); ws.accept = () => {};
  resolve({ status: 101, webSocket: ws, headers: new Headers({ "Sec-WebSocket-Protocol": "binary" }) });
  await until(() => ws.closes === 1);
  await s.closed;
});

test("transport defaults to TCP and invalid configuration fails fast", () => {
  assert.equal(relayTransport({}), "tcp");
  assert.equal(relayTransport({ RELAY_TRANSPORT: "kws" }), "kws");
  for (const value of ["", "TCP", "invalid", 1]) assert.throws(() => relayTransport({ RELAY_TRANSPORT: value }), /RELAY_TRANSPORT/);
});

test("KWS destinations are fixed official hosts, media-first only for negative DC", () => {
  for (let dc = 1; dc <= 5; dc++) {
    assert.deepEqual(kwsUrls(dc), [`wss://kws${dc}.web.telegram.org/apiws`, `wss://kws${dc}-1.web.telegram.org/apiws`]);
    assert.deepEqual(kwsUrls(-dc), kwsUrls(dc).reverse());
  }
  for (const dc of [0, 6, 2.5, "2"]) assert.throws(() => kwsUrls(dc));
});

test("packet framer preserves fragmented/coalesced intermediate and padded packets with quick ack", async () => {
  for (const [tag, body] of [[0xeeeeeeee, new Uint8Array(12).fill(3)], [0xdddddddd, new Uint8Array(13).fill(4)]]) {
    const packets = [intermediate(body, true), intermediate(body)], frames = [];
    const framer = new PacketFramer(tag);
    const bytes = concat(...packets);
    for (const byte of bytes) await framer.push(new Uint8Array([byte]), p => frames.push(p));
    assert.deepEqual(frames, packets);
    assert.equal(framer.pendingBytes, 0);
    await framer.push(bytes, p => frames.push(p));
    assert.deepEqual(frames, [...packets, ...packets]);
  }
});

test("abridged framer supports short/extended lengths and quick ack flag", async () => {
  const short = concat([0x82], new Uint8Array(8).fill(1));
  const extended = concat([0xff, 128, 0, 0], new Uint8Array(512).fill(2));
  const framer = new PacketFramer(0xefefefef), frames = [];
  const bytes = concat(short, extended, short);
  for (let i = 0; i < bytes.length; i += 3) await framer.push(bytes.subarray(i, i + 3), p => frames.push(p));
  assert.deepEqual(frames, [short, extended, short]);
});

test("packet framer rejects malformed/oversized framing before allocating packet bodies", async () => {
  assert.throws(() => new PacketFramer(0), /transport/);
  for (const [tag, bytes] of [[0xefefefef, [0]], [0xefefefef, [127, 0, 0, 0]], [0xeeeeeeee, [3, 0, 0, 0]], [0xdddddddd, [0, 0, 0, 0]], [0xeeeeeeee, [0xff, 0xff, 0xff, 0x7f]]]) {
    await assert.rejects(new PacketFramer(tag).push(new Uint8Array(bytes), () => {}), /packet/);
  }
});

test("socket opens with binary protocol and preserves standalone writes and binary reads", async t => {
  const s = socket(t), ws = FakeWebSocket.instances[0];
  assert.equal(ws.protocol, "binary"); assert.equal(ws.binaryType, "arraybuffer");
  ws.open(); await s.opened;
  const writer = s.writable.getWriter(), reader = s.readable.getReader();
  await writer.write(new Uint8Array(64)); await writer.write(new Uint8Array([1, 2]));
  assert.deepEqual(ws.sent.map(x => x.length), [64, 2]);
  ws.message(new Uint8Array([7, 8]).buffer);
  assert.deepEqual((await reader.read()).value, new Uint8Array([7, 8]));
  s.close(); assert.equal((await reader.read()).done, true); await s.closed;
});

test("reader cancellation releases the socket and resolves closed", async t => {
  const s = socket(t), ws = FakeWebSocket.instances[0]; ws.open(); await s.opened;
  const reader = s.readable.getReader();
  const pending = reader.read();
  await reader.cancel();
  assert.equal((await pending).done, true);
  await s.closed; assert.equal(ws.closes, 1);
});

test("failed first host falls back, late first-host open cannot resurrect it", async t => {
  const s = socket(t), first = FakeWebSocket.instances[0];
  first.fail(); await until(() => FakeWebSocket.instances.length === 2);
  const second = FakeWebSocket.instances[1];
  assert.match(second.url, /kws2-1/); assert.equal(first.closes, 1);
  first.open(); second.open(); await s.opened;
  await s.writable.getWriter().write(new Uint8Array(64));
  assert.equal(first.sent.length, 0); assert.equal(second.sent.length, 1);
});

test("open timeout is bounded across both hosts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = socket(t), rejected = assert.rejects(s.opened, /timeout/);
  t.mock.timers.tick(KWS_LIMITS.openTimeout / 2);
  await until(() => FakeWebSocket.instances.length === 2);
  t.mock.timers.tick(KWS_LIMITS.openTimeout / 2);
  await rejected; await s.closed;
  assert.ok(FakeWebSocket.instances.every(ws => ws.closes === 1));
});

test("cancellation closes a pending dial and prevents fallback", async t => {
  const abort = new AbortController(), s = socket(t, { signal: abort.signal });
  const rejected = assert.rejects(s.opened, /closed|abort/);
  abort.abort(); await rejected; await s.closed;
  FakeWebSocket.instances[0].open(); await setImmediate();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(FakeWebSocket.instances[0].sent.length, 0);
});

test("incoming queue bounds bytes and message count and rejects text", async t => {
  for (const mode of ["items", "bytes", "aggregate", "text"]) {
    const s = socket(t), ws = FakeWebSocket.instances[0]; ws.open(); await s.opened;
    if (mode === "text") ws.message("not binary");
    else if (mode === "bytes") ws.message(new ArrayBuffer(KWS_LIMITS.maxMessage + 1));
    else if (mode === "aggregate") for (let i = 0; i < 3; i++) ws.message(new ArrayBuffer(KWS_LIMITS.maxMessage));
    else for (let i = 0; i <= KWS_LIMITS.queueItems; i++) ws.message(new ArrayBuffer(1));
    await s.closed;
    await assert.rejects(s.readable.getReader().read(), /binary|limit/);
    assert.equal(ws.closes, 1);
  }
});

test("buffered writes have a deadline and send failures close the socket", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const s = socket(t), ws = FakeWebSocket.instances[0]; ws.open(); await s.opened;
  ws.bufferedAmount = KWS_LIMITS.writeHighWater;
  const rejected = assert.rejects(s.writable.getWriter().write(new Uint8Array([1])), /timeout/);
  await setImmediate();
  t.mock.timers.tick(KWS_LIMITS.writeTimeout + 1);
  await rejected; await s.closed; assert.equal(ws.sent.length, 0);
  const s2 = socket(t), ws2 = FakeWebSocket.instances[0]; ws2.open(); await s2.opened;
  ws2.send = () => { throw new Error("send failed"); };
  await assert.rejects(s2.writable.getWriter().write(new Uint8Array([1])), /send failed/);
  await s2.closed; assert.equal(ws2.closes, 1);
});

test("write buffering waits for drainage and cancellation releases pending writes", async t => {
  const abort = new AbortController(), s = socket(t, { signal: abort.signal });
  const ws = FakeWebSocket.instances[0]; ws.open(); await s.opened;
  const writer = s.writable.getWriter(); ws.bufferedAmount = KWS_LIMITS.writeHighWater;
  let completed = false;
  const write = writer.write(new Uint8Array([1])).then(() => { completed = true; });
  await setImmediate(); assert.equal(completed, false); assert.equal(ws.sent.length, 0);
  ws.bufferedAmount = 0; await write; assert.equal(ws.sent.length, 1);
  ws.bufferedAmount = KWS_LIMITS.writeHighWater;
  const stalled = assert.rejects(writer.write(new Uint8Array([2])), /closed|abort/);
  await setImmediate(); abort.abort(); await stalled; await s.closed;
  assert.equal(ws.sent.length, 1);
});
