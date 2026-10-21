import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { RelaySession as WorkerRelaySession, LIMITS, waitFor } from "../src/session.js";
import { FRAME, INITIAL_WINDOW, MAX_WS_MESSAGE, encodeFrame, parseFrames, u32 } from "../src/protocol.js";
import { AesCtrStream } from "../src/mtproxy.js";

import { PagesRelaySession } from "../src/pages/session.js";

const SECRET = "12".repeat(16); // Synthetic test credential, never a deployment secret.
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function message(...frames) {
  const joined = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
  let pos = 0; for (const f of frames) { joined.set(f, pos); pos += f.length; } return joined.buffer;
}
async function until(check) {
  // WebCrypto runs in the thread pool: a fixed number of immediate turns can
  // expire before real I/O gets CPU on busy CI. Use an actual bounded deadline.
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) { if (check()) return; await delay(1); }
  assert.fail("condition did not become true");
}
for (const RelaySession of [WorkerRelaySession, PagesRelaySession]) describe(RelaySession.name, () => {
function fixture(t, connect = () => { throw Error("unexpected dial"); }, Session = RelaySession) {
  const tasks = [], sent = [], stored = new Map();
  const ctx = { waitUntil(p) { tasks.push(p); }, storage: {
    async put(values) { for (const [k, v] of Object.entries(values)) stored.set(k, v); },
    async get(k) { return stored.get(k); }, async delete(k) { return stored.delete(k); },
    async setAlarm() {}, async deleteAlarm() {}, async transaction(fn) { return fn(this); },
  } };
  if (RelaySession === PagesRelaySession) Object.defineProperty(ctx, "storage", { get() { throw Error("Pages must not use DO storage"); } });
  const session = new Session(ctx, { PROXY_SECRET: SECRET }, connect);
  session.ws = { readyState: 1, send(data) { sent.push(...parseFrames(data)); }, close() {} };
  t.after(async () => { session.shutdown(); await Promise.all(tasks); });
  return { session, sent, tasks, stored };
}
const open = id => encodeFrame(FRAME.OPEN, id);
const data = (id, value) => encodeFrame(FRAME.DATA, id, new Uint8Array(value));
const close = id => encodeFrame(FRAME.CLOSE, id);

async function clientHandshake(dcId = 2, tag = 0xeeeeeeee) {
  const plain = crypto.getRandomValues(new Uint8Array(64));
  const view = new DataView(plain.buffer); view.setUint32(56, tag, true); view.setInt16(60, dcId, true);
  const material = plain.slice(8, 56), reverse = new Uint8Array(material).reverse();
  const key = async bytes => {
    const input = new Uint8Array(48); input.set(bytes); input.set(new Uint8Array(16).fill(0x12), 32);
    return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  };
  const tx = new AesCtrStream(await key(material.subarray(0, 32)), material.subarray(32));
  const rx = new AesCtrStream(await key(reverse.subarray(0, 32)), reverse.subarray(32));
  const encrypted = await tx.crypt(plain);
  const wire = new Uint8Array(plain); wire.set(encrypted.subarray(56), 56);
  return { wire, tx, rx };
}
function socketFixture(opened = Promise.resolve()) {
  let controller, reads = 0, closes = 0, aborts = 0;
  const writes = [], closed = deferred();
  const socket = { opened, closed: closed.promise,
    readable: new ReadableStream({ start(c) { controller = c; }, pull() { reads++; } }, { highWaterMark: 0 }),
    writable: { getWriter() { return { async write(bytes) { writes.push(new Uint8Array(bytes)); }, async abort() { aborts++; } }; } },
    close() { closes++; try { controller.close(); } catch {} closed.resolve(); return Promise.resolve(); },
  };
  return { socket, writes, push(bytes) { controller.enqueue(bytes); }, get closes() { return closes; }, get aborts() { return aborts; }, get reads() { return reads; } };
}

// No per-stream crypto/I/O is allowed to hold the session dispatch queue.
test("slow stream does not block another stream or WINDOW", async t => {
  const blocked = deferred(), order = [];
  t.after(() => blocked.resolve());
  class Session extends RelaySession {
    async writeStream(stream, payload) {
      if (stream.id === 1) await blocked.promise;
      if (!stream.closed) { order.push(stream.id); this.grantWindow(stream, payload.length); }
    }
  }
  const { session } = fixture(t, undefined, Session);
  await session.enqueueMessage(message(open(1), data(1, [1]), open(2), data(2, [2])));
  await until(() => order.includes(2));
  assert.deepEqual(order, [2]);
  const stream = session.streams.get(2);
  stream.sendCredit--; stream.sent.push({ remaining: 1 });
  stream.downlinkBytes = session.downlinkBytes = 1 + 8 + LIMITS.itemCost;
  stream.downlinkItems = session.downlinkItems = 1;
  await session.enqueueMessage(message(encodeFrame(FRAME.WINDOW, 2, u32(1))));
  assert.equal(stream.sendCredit, INITIAL_WINDOW);
  assert.equal(session.downlinkBytes, 0);
  await session.enqueueMessage(message(close(1)));
  assert.equal(session.streams.has(1), false);
  blocked.resolve();
});
test("same-stream writes remain FIFO and consume credit at admission", async t => {
  const gate = deferred(), seen = [];
  t.after(() => gate.resolve());
  class Session extends RelaySession {
    async writeStream(stream, payload) { if (!seen.length) await gate.promise; seen.push(...payload); this.grantWindow(stream, payload.length); }
  }
  const { session } = fixture(t, undefined, Session);
  await session.enqueueMessage(message(open(1), data(1, [1]), data(1, [2]), data(1, [3])));
  assert.equal(session.streams.get(1).receiveWindow, INITIAL_WINDOW - 3);
  assert.deepEqual(seen, []);
  gate.resolve(); await until(() => seen.length === 3);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(session.streams.get(1).receiveWindow, INITIAL_WINDOW);
  assert.equal(session.uplinkBytes, 0);
});
test("CLOSE drops queued DATA immediately and later tombstone frames are ignored", async t => {
  const gate = deferred(), seen = [];
  t.after(() => gate.resolve());
  class Session extends RelaySession { async writeStream(stream, payload) { await gate.promise; if (!stream.closed) seen.push(payload[0]); } }
  const { session } = fixture(t, undefined, Session);
  await session.enqueueMessage(message(open(1), data(1, [1]), data(1, [2]), data(1, [3]), close(1)));
  assert.equal(session.uplinkItems, 1); // Only the in-flight item remains until cancellation unwinds.
  await session.enqueueMessage(message(data(1, [4]), encodeFrame(FRAME.WINDOW, 1, u32(1)), close(1)));
  assert.equal(session.closed, false);
  gate.resolve(); await until(() => session.uplinkItems === 0);
  assert.deepEqual(seen, []); assert.equal(session.uplinkBytes, 0);
});
test("Blob decoding is ordered with ArrayBuffer messages", async t => {
  const seen = [];
  class Session extends RelaySession { async writeStream(stream, bytes) { seen.push(bytes[0]); this.grantWindow(stream, bytes.length); } }
  const { session } = fixture(t, undefined, Session);
  session.enqueueMessage(new Blob([open(1), data(1, [1])]));
  await session.enqueueMessage(message(data(1, [2])));
  await until(() => seen.length === 2);
  assert.deepEqual(seen, [1, 2]);
});
test("ingress bytes and item counts are bounded before asynchronous decoding", async t => {
  const { session } = fixture(t);
  const bytes = new ArrayBuffer(MAX_WS_MESSAGE);
  for (let i = 0; i < 4; i++) session.enqueueMessage(bytes);
  assert.equal(session.closed, true);
  await session.messageChain;
  assert.equal(session.ingressBytes, 0); assert.equal(session.ingressItems, 0);
});
test("per-stream queue limit closes only the overflowing stream", async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  class Session extends RelaySession { async writeStream() { await gate.promise; } }
  const { session, sent } = fixture(t, undefined, Session);
  session.openStream({ streamId: 1, payload: new Uint8Array() });
  session.openStream({ streamId: 2, payload: new Uint8Array() });
  for (let i = 0; i <= LIMITS.streamItems; i++) session.queueWrite({ streamId: 1, payload: new Uint8Array([1]) });
  assert.equal(session.closed, false); assert.equal(session.streams.has(1), false); assert.equal(session.streams.has(2), true);
  assert.equal(sent.at(-1).type, FRAME.CLOSE);
  gate.resolve(); await until(() => !session.uplinkItems);
});
test("rejects malformed frames, empty DATA, nonempty CLOSE and reused IDs", async t => {
  for (const invalid of [new Uint8Array([1]), data(1, []), encodeFrame(FRAME.CLOSE, 1, new Uint8Array([1])), open(1)]) {
    const { session } = fixture(t); await session.enqueueMessage(message(open(1)));
    await session.enqueueMessage(message(invalid)); assert.equal(session.closed, true);
  }
});
test("stream count overflow rejects the new stream without closing the session", async t => {
  const { session, sent } = fixture(t); session.maxStreams = 1;
  await session.enqueueMessage(message(open(1), open(2)));
  assert.equal(session.closed, false); assert.equal(session.streams.size, 1);
  assert.equal(sent.at(-1).type, FRAME.CLOSE); assert.equal(sent.at(-1).streamId, 2);
});
test("partial handshake does not receive WINDOW and times out", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { session, sent } = fixture(t);
  await session.enqueueMessage(message(open(1), data(1, [1, 2, 3])));
  await until(() => session.uplinkItems === 0);
  assert.equal(sent.length, 0); assert.equal(session.streams.get(1).receiveWindow, INITIAL_WINDOW - 3);
  t.mock.timers.tick(LIMITS.handshakeTimeout + 1);
  assert.equal(session.streams.has(1), false); assert.equal(sent.at(-1).type, FRAME.CLOSE);
});
test("real handshake, fragmented uplink and downlink preserve encryption and WINDOW totals", async t => {
  const upstream = socketFixture(), client = await clientHandshake();
  const { session, sent } = fixture(t, address => { assert.equal(address.hostname, "149.154.167.51"); assert.equal(address.port, 443); return upstream.socket; });
  const plaintext = new TextEncoder().encode("test payload across chunks"), ciphertext = await client.tx.crypt(plaintext);
  await session.enqueueMessage(message(open(1), encodeFrame(FRAME.DATA, 1, client.wire.subarray(0, 17))));
  await session.enqueueMessage(message(encodeFrame(FRAME.DATA, 1, client.wire.subarray(17)), encodeFrame(FRAME.DATA, 1, ciphertext.subarray(0, 5)), encodeFrame(FRAME.DATA, 1, ciphertext.subarray(5))));
  await until(() => session.uplinkItems === 0 && upstream.writes.length === 2);
  const wire = upstream.writes[0], material = wire.subarray(8, 56), rev = new Uint8Array(material).reverse();
  const dcDecrypt = new AesCtrStream(material.subarray(0, 32), material.subarray(32));
  const decodedHeader = await dcDecrypt.crypt(wire);
  assert.equal(new DataView(decodedHeader.buffer).getUint32(56, true), 0xeeeeeeee);
  const decoded = await dcDecrypt.crypt(Buffer.concat(upstream.writes.slice(1).map(Buffer.from)));
  assert.deepEqual(decoded, plaintext);
  const grants = sent.filter(f => f.type === FRAME.WINDOW).reduce((sum, f) => sum + new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0), 0);
  assert.equal(grants, 64 + plaintext.length);
  const dcEncrypt = new AesCtrStream(rev.subarray(0, 32), rev.subarray(32));
  const reply = new TextEncoder().encode("reply from DC"); upstream.push(await dcEncrypt.crypt(reply));
  await until(() => sent.some(f => f.type === FRAME.DATA));
  assert.deepEqual(await client.rx.crypt(sent.find(f => f.type === FRAME.DATA).payload), reply);
  assert.equal(session.downlinkItems, 1);
  await session.enqueueMessage(message(encodeFrame(FRAME.WINDOW, 1, u32(reply.length))));
  assert.equal(session.downlinkBytes, 0); assert.equal(session.downlinkItems, 0);
});
test("CLOSE during dialing closes the tracked socket and prevents late writes", async t => {
  const dial = deferred(), upstream = socketFixture(dial.promise), client = await clientHandshake();
  const { session } = fixture(t, () => upstream.socket);
  await session.enqueueMessage(message(open(1), encodeFrame(FRAME.DATA, 1, client.wire)));
  await until(() => session.streams.get(1)?.socket);
  await session.enqueueMessage(message(close(1)));
  assert.equal(upstream.closes, 1);
  dial.resolve(); await until(() => session.uplinkItems === 0);
  assert.equal(upstream.writes.length, 0); assert.equal(session.closed, false);
});
test("TCP dial timeout closes only that stream", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const upstream = socketFixture(new Promise(() => {})), client = await clientHandshake();
  const { session, sent } = fixture(t, () => upstream.socket);
  await session.enqueueMessage(message(open(1), encodeFrame(FRAME.DATA, 1, client.wire), open(2)));
  await until(() => session.streams.get(1)?.socket);
  t.mock.timers.tick(LIMITS.connectTimeout + 1);
  await until(() => !session.streams.has(1));
  assert.equal(upstream.closes, 1); assert.equal(session.closed, false); assert.equal(session.streams.has(2), true);
  assert.equal(sent.at(-1).type, FRAME.CLOSE);
});
test("waitFor handles timeout, cancellation and late rejection", async () => {
  const abort = new AbortController();
  await assert.rejects(waitFor(new Promise(() => {}), abort.signal, 1, "timed out"), /timed out/);
  const late = deferred(), p = waitFor(late.promise, abort.signal, 1000, "timed out");
  abort.abort(); await assert.rejects(p, /stream closed/); late.reject(Error("late failure")); await setImmediate();
  await assert.rejects(waitFor(Promise.reject(Error("already rejected")), abort.signal, 1000, "timed out"), /stream closed/);
});
test("downlink item budget pauses reads and resumes on partial WINDOW acknowledgement", async t => {
  const { session, sent } = fixture(t);
  session.openStream({ streamId: 1, payload: new Uint8Array() });
  const stream = session.streams.get(1), upstream = socketFixture(); stream.socket = upstream.socket;
  stream.tgDecrypt = stream.clientEncrypt = { async crypt(b) { return new Uint8Array(b); } };
  session.downlinkItems = LIMITS.downlinkItems;
  const reading = session.readStream(stream);
  await setImmediate(); assert.equal(upstream.reads, 0);
  session.downlinkItems = 0; session.wakeDownlink();
  upstream.push(new Uint8Array([1, 2, 3, 4])); await until(() => sent.length === 1);
  const cost = 4 + 8 + LIMITS.itemCost; assert.equal(session.downlinkBytes, cost);
  session.addWindow({ streamId: 1, payload: u32(2) });
  assert.equal(session.downlinkBytes, cost - 2); assert.equal(session.downlinkItems, 1);
  session.addWindow({ streamId: 1, payload: u32(2) });
  assert.equal(session.downlinkBytes, 0); assert.equal(session.downlinkItems, 0);
  session.closeStream(1, false); await reading;
});
test("excess WINDOW credit fails closed", async t => {
  const { session } = fixture(t);
  await session.enqueueMessage(message(open(1), encodeFrame(FRAME.WINDOW, 1, u32(1))));
  assert.equal(session.closed, true);
});
test("diagnostics disabled avoids enumerating frames for logging", async t => {
  const { session } = fixture(t);
  session.trace = () => assert.fail("hot-path tracing should be skipped");
  // A PONG contains no stream event that would independently be traced.
  await session.enqueueMessage(message(encodeFrame(FRAME.PONG, 0)));
  assert.equal(session.messageCount, 0); session.trace = () => {};
});

test("aggregate uplink budget and malformed WINDOW are bounded", async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  class Session extends RelaySession { async writeStream() { await gate.promise; } }
  const { session } = fixture(t, undefined, Session);
  for (let id = 1; id <= 3; id++) session.openStream({ streamId: id, payload: new Uint8Array() });
  const payload = new Uint8Array(1024 * 1024);
  for (let id = 1; id <= 3; id++) for (let i = 0; i < 3; i++) session.queueWrite({ streamId: id, payload });
  assert.ok(session.uplinkBytes <= LIMITS.uplinkBytes);
  assert.equal(session.streams.has(3), false); assert.equal(session.closed, false);
  gate.resolve(); await until(() => session.uplinkItems === 0);
  await session.enqueueMessage(message(encodeFrame(FRAME.WINDOW, 1, new Uint8Array([1]))));
  assert.equal(session.closed, true);
});
test("an over-credit DATA batch is rejected before queuing unbounded work", async t => {
  const gate = deferred();
  t.after(() => gate.resolve());
  class Session extends RelaySession { async writeStream() { await gate.promise; } }
  const { session } = fixture(t, undefined, Session);
  session.openStream({ streamId: 1, payload: new Uint8Array() });
  const payload = new Uint8Array(1024 * 1024);
  for (let i = 0; i < 4; i++) session.queueWrite({ streamId: 1, payload });
  assert.equal(session.streams.get(1).receiveWindow, 0);
  session.queueWrite({ streamId: 1, payload: new Uint8Array([1]) });
  assert.equal(session.closed, true); gate.resolve();
});
test("stalled TCP writes time out and cleanup promises cannot leak rejections", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = await clientHandshake(), upstream = socketFixture();
  let writeStarted = false;
  upstream.socket.writable.getWriter = () => ({ write() { writeStarted = true; return new Promise(() => {}); }, abort() { return Promise.reject(Error("abort failed")); } });
  const originalClose = upstream.socket.close;
  upstream.socket.close = () => { originalClose(); return Promise.reject(Error("close failed")); };
  const { session } = fixture(t, () => upstream.socket);
  await session.enqueueMessage(message(open(1), encodeFrame(FRAME.DATA, 1, client.wire)));
  await until(() => writeStarted);
  t.mock.timers.tick(LIMITS.writeTimeout + 1);
  await until(() => !session.streams.has(1));
  assert.equal(session.closed, false); assert.equal(upstream.closes, 1); await setImmediate();
});
test("session shutdown releases downlink waiters and deletes initialization state", async t => {
  const { session, stored } = fixture(t);
  if (RelaySession === WorkerRelaySession) {
    await session.fetch(new Request("https://session/internal/init", { method: "POST" }));
    assert.ok(stored.has("expiresAt"));
  }
  session.openStream({ streamId: 1, payload: new Uint8Array() });
  const stream = session.streams.get(1); stream.sendCredit = 0;
  const waiting = session.waitDownlink(stream); await setImmediate(); assert.equal(session.downlinkWaiters.size, 1);
  session.shutdown(); assert.equal(await waiting, false);
  assert.equal(stored.has("expiresAt"), false); assert.equal(session.downlinkWaiters.size, 0);
  assert.equal((await session.fetch(new Request("https://session/internal/init", { method: "POST" }))).status, 404);
});

test("uplink coalesces only queued same-stream data with bounded item batches", async t => {
  const gate = deferred(), batches = [];
  t.after(() => gate.resolve());
  class Session extends RelaySession {
    async writeStream(stream, payload) {
      batches.push([...payload]);
      if (batches.length === 1) await gate.promise;
      this.grantWindow(stream, payload.length);
    }
  }
  const { session, sent } = fixture(t, undefined, Session);
  session.openStream({ streamId: 1, payload: new Uint8Array() });
  for (let i = 0; i < 131; i++) session.queueWrite({ streamId: 1, payload: new Uint8Array([i]) });
  assert.deepEqual(batches, [[0]], "first item must start without a batching timer");
  gate.resolve(); await until(() => session.uplinkItems === 0);
  assert.deepEqual(batches.map(b => b.length), [1, 64, 64, 2]);
  assert.deepEqual(batches.flat(), Array.from({ length: 131 }, (_, i) => i));
  assert.equal(session.uplinkBytes, 0); assert.equal(session.streams.get(1).pendingBytes, 0);
  const grants = sent.filter(f => f.type === FRAME.WINDOW).reduce((n, f) => n + new DataView(f.payload.buffer, f.payload.byteOffset, 4).getUint32(0), 0);
  assert.equal(grants, 131); assert.equal(session.streams.get(1).receiveWindow, INITIAL_WINDOW);
});
test("uplink coalescing respects the byte limit without mixing streams", async t => {
  const gate = deferred(), batches = [];
  t.after(() => gate.resolve());
  class Session extends RelaySession {
    async writeStream(stream, payload) {
      batches.push({ id: stream.id, bytes: payload.length });
      if (batches.length === 1) await gate.promise;
      this.grantWindow(stream, payload.length);
    }
  }
  const { session } = fixture(t, undefined, Session);
  for (const id of [1, 2]) session.openStream({ streamId: id, payload: new Uint8Array() });
  session.queueWrite({ streamId: 1, payload: new Uint8Array([1]) });
  for (const size of [32768, 32768, 1]) session.queueWrite({ streamId: 1, payload: new Uint8Array(size) });
  session.queueWrite({ streamId: 2, payload: new Uint8Array([2]) });
  await until(() => session.streams.get(2).pendingItems === 0);
  gate.resolve(); await until(() => session.uplinkItems === 0);
  assert.deepEqual(batches, [{ id: 1, bytes: 1 }, { id: 2, bytes: 1 }, { id: 1, bytes: 65536 }, { id: 1, bytes: 1 }]);
  assert.equal(session.uplinkBytes, 0);
});
test("closing a stream releases queued and in-flight batch accounting exactly once", async t => {
  const first = deferred(), batch = deferred(); let calls = 0;
  t.after(() => { first.resolve(); batch.resolve(); });
  class Session extends RelaySession {
    async writeStream(stream, payload) {
      if (++calls === 1) await first.promise; else await batch.promise;
      if (!stream.closed) this.grantWindow(stream, payload.length);
    }
  }
  const { session } = fixture(t, undefined, Session);
  session.openStream({ streamId: 1, payload: new Uint8Array() });
  const stream = session.streams.get(1);
  for (let i = 0; i < 132; i++) session.queueWrite({ streamId: 1, payload: new Uint8Array([1]) });
  first.resolve(); await until(() => calls === 2);
  session.closeStream(1, true);
  assert.equal(session.uplinkItems, LIMITS.uplinkBatchItems);
  batch.resolve(); await until(() => session.uplinkItems === 0);
  assert.equal(session.uplinkBytes, 0); assert.equal(stream.pendingItems, 0); assert.equal(stream.pendingBytes, 0);
});
test("failed coalesced writes release the batch and close only its stream", async t => {
  const gate = deferred(); let calls = 0;
  t.after(() => gate.resolve());
  class Session extends RelaySession {
    async writeStream(stream, payload) {
      if (++calls === 1) { await gate.promise; this.grantWindow(stream, payload.length); }
      else throw Error("synthetic write failure");
    }
  }
  const { session } = fixture(t, undefined, Session);
  for (const id of [1, 2]) session.openStream({ streamId: id, payload: new Uint8Array() });
  for (let i = 0; i < 100; i++) session.queueWrite({ streamId: 1, payload: new Uint8Array([1]) });
  gate.resolve(); await until(() => !session.streams.has(1));
  assert.equal(session.uplinkItems, 0); assert.equal(session.uplinkBytes, 0);
  assert.equal(session.closed, false); assert.equal(session.streams.has(2), true);
});

});
