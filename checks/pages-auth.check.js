import test from "node:test";
import assert from "node:assert/strict";
import { createPagesToken, verifyPagesToken, PAGES_ATTACH_TTL_SECONDS } from "../src/pages/auth.js";
import { createSessionToken, verifySessionToken } from "../src/http.js";
const env = { PROXY_SECRET: "12".repeat(16) }, host = "proxy.example.com";

test("Pages tickets are random, canonical, host-bound and separate from Workers tokens", async () => {
  const a = await createPagesToken(env, host), b = await createPagesToken(env, host);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
  assert.equal(await verifyPagesToken(env, host, a), true);
  assert.equal(await verifyPagesToken(env, "other.example.com", a), false);
  assert.equal(await verifyPagesToken({ PROXY_SECRET: "34".repeat(16) }, host, a), false);
  assert.equal(await verifySessionToken(env, host, a), false);
  assert.equal(await verifyPagesToken(env, host, await createSessionToken(env, host)), false);
  const dd = { PROXY_SECRET: "dd" + env.PROXY_SECRET };
  assert.equal(await verifyPagesToken(dd, host, await createPagesToken(dd, host)), true);
});
test("Pages ticket expiry is exactly 60 seconds, including cold-isolate verification", async t => {
  let now = 2000000000000;
  t.mock.method(Date, "now", () => now);
  const token = await createPagesToken(env, host);
  assert.equal(PAGES_ATTACH_TTL_SECONDS, 60);
  const fresh = await import("../src/pages/auth.js?cold-isolate-test");
  assert.equal(await fresh.verifyPagesToken({ ...env }, host, token), true);
  now += 59000; assert.equal(await verifyPagesToken(env, host, token), true);
  now += 1000; assert.equal(await verifyPagesToken(env, host, token), false);
  now -= 61000; assert.equal(await verifyPagesToken(env, host, token), false);
});
test("tampered payloads, MACs, malformed and noncanonical tickets fail closed", async () => {
  const token = await createPagesToken(env, host), bytes = Buffer.from(token, "base64url");
  for (let i = 0; i < bytes.length; i++) {
    const changed = Buffer.from(bytes); changed[i] ^= 1;
    assert.equal(await verifyPagesToken(env, host, changed.toString("base64url")), false);
  }
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const noncanonical = token.slice(0, -1) + alphabet[alphabet.indexOf(token.at(-1)) | 1];
  for (const value of [null, undefined, "", "A".repeat(43), "!".repeat(43), token + "=", noncanonical]) {
    assert.equal(await verifyPagesToken(env, host, value), false);
  }
  for (const secret of [undefined, "", "a", "AB".repeat(16)]) {
    assert.equal(await verifyPagesToken({ PROXY_SECRET: secret }, host, token), false);
    await assert.rejects(createPagesToken({ PROXY_SECRET: secret }, host), /invalid/);
  }
});
