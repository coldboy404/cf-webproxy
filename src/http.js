import { FRAME, encodeFrame, parseFrames, clampInt } from "./protocol.js";
import { bridgePage } from "./bridge.js";
import { hmac } from "./auth.js";
import { entranceHost, validateConfig } from "./config.js";

// Both deployment targets share authentication, HTTP framing and the Bridge.
export function createProxyHandler(backend) {
  return {
    async fetch(request, env, ctx) {
      try {
        return await route(request, env, ctx, backend);
      } catch (error) {
        console.error("unhandled request error", error);
        return camouflage();
      }
    },
  };
}

async function route(request, env, ctx, backend) {
  const url = new URL(request.url);
  let expectedHost, transport;
  try {
    expectedHost = entranceHost(env, url.hostname);
    if (!expectedHost) return camouflage();
    transport = validateConfig(env);
  } catch {
    return url.pathname === "/healthz" || url.pathname === "/health"
      ? Response.json({ ok: false, error: "invalid_configuration" }, { status: 500, headers: noStore() })
      : camouflage();
  }
  // Keep the Bridge, session and WebSocket on the actual entrance hostname.
  // A CNAME target / X-Forwarded-Host must never replace the signed hostname.
  if (url.pathname === "/api/v1/session" || url.pathname === "/api/v1/ws") {
    if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return camouflage();
  }

  if (url.pathname === "/" && request.method === "GET") {
    const capability = exactBridgeQuery(url);
    if (!capability || !(await capabilityMatches(capability, expectedHost, env.PROXY_SECRET))) {
      return publicPage();
    }
    const bootstrap = await createBootstrap(env, request.headers.get("CF-Connecting-IP") || "");
    return bridgePage(expectedHost, bootstrap);
  }

  if (url.pathname === "/api/v1/session") {
    if (request.headers.has("Cookie")) return camouflage();
    if (request.method === "DELETE") {
      const token = bearer(request);
      if (!(await backend.verifyToken(env, expectedHost, token))) return camouflage();
      return backend.close(env, token);
    }
    if (request.method !== "POST" || !isBinary(request.headers.get("Content-Type"))) return camouflage();
    const bootstrap = bearer(request);
    if (!bootstrap || !(await verifyBootstrap(env, bootstrap, request.headers.get("CF-Connecting-IP") || ""))) return camouflage();
    const hello = await readHello(request);
    if (!isHello(hello)) return camouflage();

    const sessionToken = await backend.createToken(env, expectedHost);
    if (!(await backend.initialize(env, sessionToken))) return camouflage();

    const welcome = encodeFrame(FRAME.WELCOME, 0);
    return new Response(welcome, {
      status: 200,
      headers: {
        ...noStore(),
        "Content-Type": "application/octet-stream",
        "X-Session-Token": sessionToken,
        "X-Carrier-Mode": "websocket",
        "X-Down-Cursor": "0",
      },
    });
  }

  if (url.pathname === "/api/v1/ws" && request.method === "GET" && !request.headers.has("Cookie") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((v) => v.trim());
    const protocol = protocols.find((v) => v.startsWith("tproxy-v1."));
    const token = protocol?.slice("tproxy-v1.".length);
    if (!(await backend.verifyToken(env, expectedHost, token))) return camouflage();
    return backend.attach(env, token, protocol, ctx);
  }

  if ((url.pathname === "/healthz" || url.pathname === "/health") && request.method === "GET") {
    return Response.json({ ok: true, carrier: "websocket", relay: transport === "kws" ? "telegram-kws" : "direct-telegram-dc" }, { headers: noStore() });
  }

  return camouflage();
}

function publicPage() {
  return new Response("<!doctype html><meta charset=utf-8><title>Welcome</title><h1>Welcome</h1>", {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

function camouflage() {
  return new Response("<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>", {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function exactBridgeQuery(url) {
  if (url.searchParams.size !== 1 || !url.searchParams.has("bridge")) return null;
  const value = url.searchParams.get("bridge");
  return /^[A-Za-z0-9_-]{43}$/.test(value || "") && url.search === `?bridge=${value}` ? value : null;
}

async function capabilityMatches(candidate, host, hexSecret) {
  if (!/^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(String(hexSecret || ""))) return false;
  const secret = hexToBytes(hexSecret);
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1\n${host}`);
  const expected = base64url(await hmac(secret, context));
  return constantTimeEqual(candidate, expected);
}

async function createBootstrap(env, _ip) {
  const ttl = clampInt(env.SESSION_TTL_SECONDS, 30, 600, 300);
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + ttl, n: randomToken(16) })));
  const signature = base64url(await hmac(signingKey(env), new TextEncoder().encode(payload)));
  return `${payload}.${signature}`;
}

async function verifyBootstrap(env, token, _ip) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const expected = base64url(await hmac(signingKey(env), new TextEncoder().encode(payload)));
  if (!constantTimeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(base64urlDecode(payload)));
    return Number.isInteger(data.exp) && data.exp >= Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function signingKey(env) {
  // Domain separation lets one user-supplied proxy secret safely serve both
  // MTProxy authentication and short-lived bootstrap-token signing.
  return new TextEncoder().encode(`cf-webproxy/session-signing/v1\n${String(env.PROXY_SECRET || "")}`);
}

// Keep the opaque 43-character wire format, but reject fabricated credentials
// before they can allocate or address a Durable Object.
export async function createSessionToken(env, host) {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const mac = await sessionMac(env, host, nonce);
  const bytes = new Uint8Array(32); bytes.set(nonce); bytes.set(mac.subarray(0, 16), 16);
  return base64url(bytes);
}
export async function verifySessionToken(env, host, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) return false;
  const bytes = base64urlDecode(token);
  if (base64url(bytes) !== token) return false;
  const mac = await sessionMac(env, host, bytes.subarray(0, 16));
  return constantTimeEqual(base64url(bytes.subarray(16)), base64url(mac.subarray(0, 16)));
}
function sessionMac(env, host, nonce) {
  const context = new TextEncoder().encode("cf-webproxy/session-token/v1\n" + host + "\n");
  const bytes = new Uint8Array(context.length + nonce.length); bytes.set(context); bytes.set(nonce, context.length);
  return hmac(signingKey(env), bytes);
}
async function readHello(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), bytes = new Uint8Array(9);
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, length);
      if (length + value.length > bytes.length) {
        await reader.cancel(); return new Uint8Array();
      }
      bytes.set(value, length); length += value.length;
    }
  } finally { reader.releaseLock(); }
}

function isHello(bytes) {
  try {
    const frames = parseFrames(bytes);
    return frames.length === 1 && frames[0].type === FRAME.HELLO && frames[0].streamId === 0 && frames[0].payload.length === 1 && frames[0].payload[0] === 1;
  } catch { return false; }
}

function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function isBinary(value) {
  return /^application\/octet-stream(?:\s*;.*)?$/i.test(value || "");
}
function noStore() { return { "Cache-Control": "no-store" }; }
function randomToken(bytes) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return base64url(value); }
function hexToBytes(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
function base64url(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64urlDecode(value) { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4); const raw = atob(padded); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
export const _check = { FRAME, encodeFrame, parseFrames, isHello, exactBridgeQuery };

function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
