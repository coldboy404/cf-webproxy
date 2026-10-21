import test from "node:test";
import assert from "node:assert/strict";
import { createHmacSigner } from "../src/auth.js";

const key = value => new Uint8Array(32).fill(value);
const payload = new TextEncoder().encode("synthetic test payload");
function counted() {
  const imports = [];
  return { imports, subtle: {
    importKey(...args) { imports.push(new Uint8Array(args[1])); return crypto.subtle.importKey(...args); },
    sign(...args) { return crypto.subtle.sign(...args); },
  } };
}
async function reference(bytes, data) {
  const imported = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, data));
}

test("HMAC cache shares concurrent imports and preserves native signatures", async () => {
  const f = counted(), sign = createHmacSigner(f.subtle);
  const results = await Promise.all(Array.from({ length: 20 }, () => sign(key(1), payload)));
  const expected = await reference(key(1), payload);
  for (const result of results) assert.deepEqual(result, expected);
  assert.equal(f.imports.length, 1);
  const differentData = new Uint8Array([1,2,3]);
  assert.deepEqual(await sign(key(1), differentData), await reference(key(1), differentData));
  assert.equal(f.imports.length, 1);
});

test("HMAC key rotation and distinct signing domains do not reuse the wrong key", async () => {
  const f = counted(), sign = createHmacSigner(f.subtle);
  const bridge = key(1), session = new TextEncoder().encode("cf-webproxy/session-signing/v1\n" + "01".repeat(16));
  const old = await sign(bridge, payload), scoped = await sign(session, payload), rotated = await sign(key(2), payload);
  assert.notDeepEqual(old, scoped); assert.notDeepEqual(old, rotated);
  assert.deepEqual(rotated, await reference(key(2), payload));
  assert.deepEqual(await sign(bridge, payload), old); assert.equal(f.imports.length, 3);
});

test("HMAC cache evicts least recently used keys at its fixed bound", async () => {
  const f = counted(), sign = createHmacSigner(f.subtle, 2);
  await sign(key(1), payload); await sign(key(2), payload); await sign(key(1), payload);
  await sign(key(3), payload); await sign(key(1), payload); await sign(key(2), payload);
  assert.deepEqual(f.imports.map(bytes => bytes[0]), [1,2,3,2]);
});

test("failed imports are removed so a later request can retry", async () => {
  let count = 0;
  const sign = createHmacSigner({
    importKey(...args) { if (++count === 1) return Promise.reject(Error("import failed")); return crypto.subtle.importKey(...args); },
    sign: crypto.subtle.sign.bind(crypto.subtle),
  });
  await assert.rejects(sign(key(1), payload), /import failed/);
  assert.deepEqual(await sign(key(1), payload), await reference(key(1), payload)); assert.equal(count, 2);
});

test("late rejection of an evicted import cannot delete its replacement", async () => {
  let rejectOld, count = 0;
  const sign = createHmacSigner({
    importKey(...args) { if (++count === 1) return new Promise((_, reject) => { rejectOld = reject; }); return crypto.subtle.importKey(...args); },
    sign: crypto.subtle.sign.bind(crypto.subtle),
  }, 1);
  const old = assert.rejects(sign(key(1), payload), /old failure/);
  await sign(key(2), payload); await sign(key(1), payload);
  rejectOld(Error("old failure")); await old;
  await sign(key(1), payload); assert.equal(count, 3);
});

test("cache imports a snapshot of the supplied key bytes", async () => {
  const f = counted(), sign = createHmacSigner(f.subtle), bytes = key(1);
  const first = sign(bytes, payload); bytes.fill(2);
  assert.deepEqual(await first, await reference(key(1), payload));
  assert.deepEqual(await sign(bytes, payload), await reference(key(2), payload));
  assert.equal(f.imports.length, 2);
});
