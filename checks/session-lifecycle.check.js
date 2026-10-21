import test from "node:test";
import assert from "node:assert/strict";
import { RelaySession, LIMITS } from "../src/session.js";

function fixture(t) {
  let now = 1000000, alarm = null, records = new Map();
  const tasks = [];
  t.mock.method(Date, "now", () => now);
  const storage = {
    async get(k) { return records.get(k); },
    async put(values) { for (const [k,v] of Object.entries(values)) records.set(k,v); },
    async delete(k) { return records.delete(k); },
    async setAlarm(value) { alarm = value; },
    async deleteAlarm() { alarm = null; },
    async transaction(fn) {
      const before = new Map(records), oldAlarm = alarm;
      try { return await fn(this); } catch (error) { records = before; alarm = oldAlarm; throw error; }
    },
  };
  const ctx = { storage, waitUntil(p) { tasks.push(p); } };
  const fresh = () => new RelaySession(ctx, {}, () => { throw Error("unexpected TCP"); });
  const session = fresh();
  const ResponseClass = globalThis.Response;
  t.mock.method(globalThis, "Response", function(body, init) {
    if (init?.status === 101) return { status: 101, webSocket: init.webSocket };
    return new ResponseClass(body, init);
  });
  const originalPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = {};
      this[1] = { readyState: 1, accept() {}, addEventListener() {}, close() { this.readyState = 3; } };
    }
  };
  t.after(async () => {
    session.shutdown(); await Promise.all(tasks);
    if (originalPair) Object.defineProperty(globalThis, "WebSocketPair", originalPair);
    else delete globalThis.WebSocketPair;
  });
  return { session, storage, fresh, tasks, advance(ms) { now += ms; }, get now() { return now; }, get alarm() { return alarm; } };
}
const init = session => session.fetch(new Request("https://session/internal/init", { method: "POST" }));
const attach = session => session.fetch(new Request("https://session/internal/ws", { headers: { Upgrade: "websocket" } }));

test("warm and restored sessions reject first attachment at and beyond the deadline", async t => {
  for (const age of [LIMITS.sessionConnectTimeout, LIMITS.sessionConnectTimeout + 60000]) {
    await t.test(String(age), async t => {
      const f = fixture(t); await init(f.session); f.advance(age);
      assert.equal((await attach(f.fresh())).status, 404);
      assert.equal((await attach(f.session)).status, 404);
      await Promise.all(f.tasks);
      assert.equal(await f.storage.get("expiresAt"), undefined);
      assert.equal(f.alarm, null);
    });
  }
});

test("first attachment before deadline cancels expiry and late alarms preserve live sessions", async t => {
  const f = fixture(t); await init(f.session); f.advance(LIMITS.sessionConnectTimeout - 1);
  assert.equal((await attach(f.session)).status, 101);
  await Promise.all(f.tasks); assert.equal(f.alarm, null);
  f.advance(60000); await f.session.alarm();
  assert.equal(f.session.closed, false); assert.equal(f.session.ws.readyState, 1);
  assert.equal((await attach(f.session)).status, 409);
});

test("initialization persists its deadline without renewing it after object restoration", async t => {
  const f = fixture(t); await init(f.session);
  const deadline = await f.storage.get("expiresAt");
  assert.equal(f.alarm, deadline);
  f.advance(1000); await init(f.session); await init(f.fresh());
  assert.equal(await f.storage.get("expiresAt"), deadline); assert.equal(f.alarm, deadline);
});

test("early alarm reschedules and an abandoned session is cleaned without client traffic", async t => {
  const f = fixture(t); await init(f.session); const deadline = f.alarm;
  await f.session.alarm(); assert.equal(f.session.closed, false); assert.equal(f.alarm, deadline);
  f.advance(LIMITS.sessionConnectTimeout);
  const restored = f.fresh(); await restored.alarm();
  assert.equal(restored.closed, true); assert.equal(await f.storage.get("expiresAt"), undefined); assert.equal(f.alarm, null);
  await restored.alarm(); // At-least-once delivery must be harmless.
});

test("alarm cleanup failures propagate and can be retried", async t => {
  const f = fixture(t); await init(f.session); f.advance(LIMITS.sessionConnectTimeout);
  const remove = f.storage.delete.bind(f.storage); let failed = false;
  f.storage.delete = async key => { if (!failed) { failed = true; throw Error("storage unavailable"); } return remove(key); };
  await assert.rejects(f.session.alarm(), /storage unavailable/);
  assert.ok(await f.storage.get("expiresAt")); assert.notEqual(f.alarm, null);
  await f.session.alarm(); assert.equal(await f.storage.get("expiresAt"), undefined); assert.equal(f.alarm, null);
});

test("failed alarm scheduling rolls back initialization", async t => {
  const f = fixture(t);
  f.storage.setAlarm = async () => { throw Error("schedule failed"); };
  await assert.rejects(init(f.session), /schedule failed/);
  assert.equal(f.session.initialized, false); assert.equal(await f.storage.get("expiresAt"), undefined);
});

test("unknown or invalid stored deadlines fail closed", async t => {
  const f = fixture(t);
  for (const deadline of [undefined, NaN, "2000000", Infinity]) {
    await f.storage.put({ expiresAt: deadline });
    assert.equal((await attach(f.fresh())).status, 404);
    await Promise.all(f.tasks);
  }
});

test("shutdown during the expiry read cannot resurrect a socket", async t => {
  const f = fixture(t); await init(f.session);
  const get = f.storage.get.bind(f.storage);
  f.storage.get = async key => { const value = await get(key); f.session.shutdown(); return value; };
  assert.equal((await attach(f.session)).status, 404); assert.equal(f.session.ws, null);
});

test("concurrent attachment admits at most one socket", async t => {
  const f = fixture(t); await init(f.session);
  const results = await Promise.all([attach(f.session), attach(f.session)]);
  assert.deepEqual(results.map(r => r.status).sort(), [101, 409]);
});

test("an attachment during an alarm storage read remains active", async t => {
  const f = fixture(t); await init(f.session);
  const get = f.storage.get.bind(f.storage); let release, first = true;
  f.storage.get = async key => {
    const value = await get(key);
    if (first) { first = false; await new Promise(resolve => { release = resolve; }); }
    return value;
  };
  const alarm = f.session.alarm();
  assert.equal((await attach(f.session)).status, 101);
  f.advance(LIMITS.sessionConnectTimeout); release(); await alarm;
  assert.equal(f.session.closed, false);
});
