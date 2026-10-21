import { hmac } from "../auth.js";

// A short attachment window limits replay without pretending to have a global
// one-use registry. Established WebSockets are NOT closed when this expires.
export const PAGES_ATTACH_TTL_SECONDS = 60;
const encoder = new TextEncoder();

function validSecret(env) {
  return /^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(String(env.PROXY_SECRET || ""));
}
function encode(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(token) {
  return Uint8Array.from(atob(token.replace(/-/g, "+").replace(/_/g, "/") + "="), c => c.charCodeAt(0));
}
function mac(env, host, payload) {
  const context = encoder.encode("cf-webproxy/pages-session/v1\n" + host + "\n");
  const bytes = new Uint8Array(context.length + payload.length);
  bytes.set(context); bytes.set(payload, context.length);
  return hmac(encoder.encode("cf-webproxy/pages-signing/v1\n" + env.PROXY_SECRET), bytes);
}

export async function createPagesToken(env, host) {
  if (!validSecret(env)) throw new Error("PROXY_SECRET is missing or invalid");
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  new DataView(bytes.buffer).setUint32(0, Math.floor(Date.now() / 1000) + PAGES_ATTACH_TTL_SECONDS);
  bytes.set((await mac(env, host, bytes.subarray(0, 16))).subarray(0, 16), 16);
  return encode(bytes);
}

export async function verifyPagesToken(env, host, token) {
  if (!validSecret(env) || !/^[A-Za-z0-9_-]{43}$/.test(token || "")) return false;
  const bytes = decode(token);
  if (encode(bytes) !== token) return false;
  const deadline = new DataView(bytes.buffer).getUint32(0), now = Math.floor(Date.now() / 1000);
  if (deadline <= now || deadline > now + PAGES_ATTACH_TTL_SECONDS) return false;
  const expected = await mac(env, host, bytes.subarray(0, 16));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= bytes[i + 16] ^ expected[i];
  return diff === 0;
}
