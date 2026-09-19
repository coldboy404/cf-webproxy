import { connect } from "cloudflare:sockets";
import { TELEGRAM_DCS, parseProxySecret, acceptClientHandshake, createTelegramHandshake } from "./mtproxy.js";

const FRAME = Object.freeze({
  OPEN: 0x01,
  DATA: 0x02,
  CLOSE: 0x03,
  WINDOW: 0x04,
  PING: 0x05,
  PONG: 0x06,
  HELLO: 0x10,
  WELCOME: 0x11,
  BYE: 0x1f,
});

const HEADER_SIZE = 8;
const MAX_PAYLOAD = 1024 * 1024;
const MAX_BATCH_FRAMES = 4096;
const INITIAL_WINDOW = 4 * 1024 * 1024;
const DATA_CHUNK = 64 * 1024;
const MAX_WS_MESSAGE = 2 * 1024 * 1024;

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error("unhandled request error", error);
      return camouflage();
    }
  },
};

export class WebProxySession {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.initialized = false;
    this.closed = false;
    this.ws = null;
    this.streams = new Map();
    this.closedIds = new Set();
    this.maxStreams = clampInt(env.MAX_STREAMS, 1, 128, 64);
    this.messageChain = Promise.resolve();
    this.traceId = crypto.randomUUID().slice(0, 8);
    this.messageCount = 0;
  }

  trace(event, details = {}) {
    console.log("webproxy", { traceId: this.traceId, event, ...details });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/internal/ws") this.trace("internal_ws_request", { upgrade: request.headers.get("Upgrade") || "" });

    if (url.pathname === "/internal/init" && request.method === "POST") {
      if (this.initialized) return new Response(null, { status: 204 });
      this.initialized = true;
      await this.ctx.storage.put({ expiresAt: Date.now() + 10 * 60 * 1000 });
      return new Response(null, { status: 204 });
    }

    if (url.pathname === "/internal/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (!this.initialized) {
        const expiresAt = await this.ctx.storage.get("expiresAt");
        if (!expiresAt || expiresAt < Date.now()) return new Response("unknown session", { status: 404 });
        this.initialized = true;
      }
      if (this.ws) return new Response("already connected", { status: 409 });

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();
      this.ws = server;
      this.trace("websocket_accepted");
      server.addEventListener("message", (event) => {
        this.messageChain = this.messageChain
          .then(() => this.onMessage(event.data))
          .catch((error) => {
            this.trace("message_handler_failed", { error: safeError(error) });
            this.protocolError("message_handler_failed");
          });
        this.ctx.waitUntil(this.messageChain);
      });
      server.addEventListener("close", (event) => {
        this.trace("websocket_closed", { code: event.code, reason: event.reason || "", clean: event.wasClean });
        this.shutdown("websocket_close");
      });
      server.addEventListener("error", () => {
        this.trace("websocket_error");
        this.shutdown("websocket_error");
      });

      const protocol = request.headers.get("X-TProxy-Protocol") || "";
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {},
      });
    }

    if (url.pathname === "/internal/close" && request.method === "POST") {
      this.trace("session_delete_received");
      this.shutdown("session_delete");
      return new Response(null, { status: 204 });
    }

    return new Response("not found", { status: 404 });
  }

  async onMessage(data) {
    if (this.closed) return;
    if (data instanceof Blob) {
      if (data.size === 0 || data.size > MAX_WS_MESSAGE) {
        this.trace("invalid_websocket_message", { kind: "Blob", length: data.size });
        return this.protocolError("invalid_websocket_message");
      }
      data = await data.arrayBuffer();
    }
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > MAX_WS_MESSAGE) {
      this.trace("invalid_websocket_message", { kind: Object.prototype.toString.call(data), length: data?.byteLength ?? null });
      return this.protocolError("invalid_websocket_message");
    }

    let frames;
    try {
      frames = parseFrames(new Uint8Array(data));
    } catch (error) {
      this.trace("frame_parse_failed", { length: data.byteLength, error: safeError(error), prefix: hexPrefix(new Uint8Array(data)) });
      return this.protocolError("frame_parse_failed");
    }

    this.messageCount += 1;
    this.trace("frames_received", {
      message: this.messageCount,
      bytes: data.byteLength,
      frames: frames.map((frame) => ({ type: frame.type, streamId: frame.streamId, length: frame.payload.length })),
    });

    for (const frame of frames) {
      if (frame.streamId === 0) {
        if (frame.type !== FRAME.PONG || frame.payload.length > 64) return this.protocolError("invalid_control_frame");
        continue;
      }
      if (frame.type === FRAME.OPEN) await this.openStream(frame);
      else if (frame.type === FRAME.DATA) await this.writeStream(frame);
      else if (frame.type === FRAME.WINDOW) this.addWindow(frame);
      else if (frame.type === FRAME.CLOSE) this.closeStream(frame.streamId, false);
      else return this.protocolError("unknown_frame_type");
      if (this.closed) return;
    }
  }

  async openStream(frame) {
    const id = frame.streamId;
    if (frame.payload.length !== 0 || this.streams.has(id) || this.closedIds.has(id)) return this.protocolError("invalid_open");
    if (this.streams.size >= this.maxStreams) { this.rememberClosed(id); return this.sendFrame(FRAME.CLOSE, id); }
    const stream = { id, socket:null, writer:null, handshake:new Uint8Array(), receiveWindow:INITIAL_WINDOW, sendCredit:INITIAL_WINDOW, creditWaiters:[], closed:false };
    this.streams.set(id, stream);
    this.trace("stream_opened", { streamId: id });
  }

  async writeStream(frame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) { if (this.closedIds.has(frame.streamId)) return; return this.protocolError(); }
    const length=frame.payload.length;
    if (!length || length > stream.receiveWindow) return this.protocolError();
    stream.receiveWindow -= length;
    try {
      let payload=frame.payload;
      if (!stream.writer) {
        const joined=new Uint8Array(stream.handshake.length+payload.length); joined.set(stream.handshake); joined.set(payload,stream.handshake.length);
        if (joined.length < 64) { stream.handshake=joined; this.grantWindow(stream,length); return; }
        if (joined.length > 64 + 1024*1024) throw new Error("excess pre-auth data");
        const secret=parseProxySecret(this.env.PROXY_SECRET).inner;
        const client=await acceptClientHandshake(joined.subarray(0,64),secret);
        this.trace("mtproxy_handshake_accepted", { streamId: stream.id, dcId: client.dcId, tag: client.tag });
        const tg=await createTelegramHandshake(client.tag,client.dcId);
        const socket=connect({hostname:TELEGRAM_DCS[Math.abs(client.dcId)],port:443},{allowHalfOpen:false});
        await socket.opened;
        this.trace("telegram_dc_connected", { streamId: stream.id, dcId: client.dcId });
        stream.socket=socket; stream.writer=socket.writable.getWriter();
        stream.clientDecrypt=client.clientDecrypt; stream.clientEncrypt=client.clientEncrypt;
        stream.tgEncrypt=tg.encrypt; stream.tgDecrypt=tg.decrypt; stream.handshake=new Uint8Array();
        await stream.writer.write(tg.wire);
        this.ctx.waitUntil(this.readStream(stream));
        payload=joined.subarray(64);
      }
      if (payload.length) {
        const plain=await stream.clientDecrypt.crypt(payload);
        await stream.writer.write(await stream.tgEncrypt.crypt(plain));
      }
      this.grantWindow(stream,length);
    } catch (error) {
      this.trace("stream_write_failed", { streamId: stream.id, stage: stream.writer ? "relay" : "handshake_or_connect", error: safeError(error) });
      this.closeStream(stream.id,true);
    }
  }

  grantWindow(stream,length) {
    stream.receiveWindow += length;
    this.sendFrame(FRAME.WINDOW,stream.id,u32(length));
  }
  addWindow(frame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if (this.closedIds.has(frame.streamId)) return;
      return this.protocolError();
    }
    if (frame.payload.length !== 4) return this.protocolError();
    const amount = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0);
    if (!amount) return this.protocolError();
    stream.sendCredit = Math.min(0xffffffff, stream.sendCredit + amount);
    const waiters = stream.creditWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async readStream(stream) {
    const reader = stream.socket.readable.getReader();
    try {
      while (!stream.closed && !this.closed) {
        const { value, done } = await reader.read();
        if (done) break;
        const encrypted = value instanceof Uint8Array ? value : new Uint8Array(value);
        const plain = await stream.tgDecrypt.crypt(encrypted);
        const bytes = await stream.clientEncrypt.crypt(plain);
        let offset = 0;
        while (offset < bytes.length && !stream.closed && !this.closed) {
          while (stream.sendCredit === 0 && !stream.closed && !this.closed) {
            await new Promise((resolve) => stream.creditWaiters.push(resolve));
          }
          const size = Math.min(DATA_CHUNK, stream.sendCredit, bytes.length - offset);
          if (!size) continue;
          this.sendFrame(FRAME.DATA, stream.id, bytes.subarray(offset, offset + size));
          stream.sendCredit -= size;
          offset += size;
        }
      }
    } catch (error) {
      console.warn("upstream read failed", error);
    } finally {
      try { reader.releaseLock(); } catch {}
      this.closeStream(stream.id, true);
    }
  }

  closeStream(id, notify) {
    const stream = this.streams.get(id);
    if (!stream) {
      if (!this.closedIds.has(id)) this.rememberClosed(id);
      return;
    }
    this.streams.delete(id);
    this.rememberClosed(id);
    stream.closed = true;
    this.trace("stream_closed", { streamId: id, notify });
    for (const resolve of stream.creditWaiters.splice(0)) resolve();
    try { stream.writer?.abort(); } catch {}
    try { stream.socket?.close(); } catch {}
    if (notify && !this.closed) this.sendFrame(FRAME.CLOSE, id);
  }

  rememberClosed(id) {
    this.closedIds.add(id);
    if (this.closedIds.size > 4096) this.closedIds.delete(this.closedIds.values().next().value);
  }

  sendFrame(type, streamId, payload = new Uint8Array()) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return;
    try {
      this.ws.send(encodeFrame(type, streamId, payload));
    } catch {
      this.shutdown();
    }
  }

  protocolError(reason = "protocol_error") {
    this.trace("protocol_error", { reason });
    this.sendFrame(FRAME.BYE, 0);
    this.shutdown(reason);
  }

  shutdown(reason = "shutdown") {
    if (this.closed) return;
    this.trace("session_shutdown", { reason, streams: this.streams.size });
    this.closed = true;
    for (const id of [...this.streams.keys()]) this.closeStream(id, false);
    try { this.ws?.close(1000, "session closed"); } catch {}
    this.ws = null;
  }
}

async function route(request, env) {
  const url = new URL(request.url);
  const expectedHost = canonicalHost(env.PUBLIC_HOSTNAME || url.hostname);
  if (canonicalHost(url.hostname) !== expectedHost) return camouflage();

  if (url.pathname === "/" && request.method === "GET") {
    const capability = exactBridgeQuery(url);
    if (!capability || !(await capabilityMatches(capability, expectedHost, env.PROXY_SECRET))) {
      return publicPage();
    }
    const bootstrap = await createBootstrap(env, request.headers.get("CF-Connecting-IP") || "");
    return bridgePage(expectedHost, bootstrap);
  }

  if (url.pathname === "/api/v1/session") {
    if (request.method === "DELETE") {
      const token = bearer(request);
      if (!token) return camouflage();
      const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
      await stub.fetch("https://session/internal/close", { method: "POST" });
      return new Response(null, { status: 204, headers: noStore() });
    }
    if (request.method !== "POST" || !isBinary(request.headers.get("Content-Type"))) return camouflage();
    const bootstrap = bearer(request);
    if (!bootstrap || !(await verifyBootstrap(env, bootstrap, request.headers.get("CF-Connecting-IP") || ""))) return camouflage();
    const hello = new Uint8Array(await request.arrayBuffer());
    if (!isHello(hello)) return camouflage();

    const sessionToken = randomToken(32);
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionToken));
    const init = await stub.fetch("https://session/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!init.ok) return camouflage();

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

  if (url.pathname === "/api/v1/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((v) => v.trim());
    const protocol = protocols.find((v) => v.startsWith("tproxy-v1."));
    const token = protocol?.slice("tproxy-v1.".length);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return camouflage();
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    console.log("webproxy", { event: "ws_proxy_start" });
    try {
      const response = await stub.fetch("https://session/internal/ws", {
        headers: { Upgrade: "websocket", "X-TProxy-Protocol": protocol },
      });
      console.log("webproxy", { event: "ws_proxy_response", status: response.status, hasWebSocket: Boolean(response.webSocket) });
      return response;
    } catch (error) {
      console.error("webproxy", { event: "ws_proxy_failed", error: safeError(error) });
      throw error;
    }
  }

  if (url.pathname === "/healthz" && request.method === "GET") {
    return Response.json({ ok: true, carrier: "websocket", relay: "direct-telegram-dc" }, { headers: noStore() });
  }

  return camouflage();
}

function bridgePage(host, bootstrap) {
  const config = JSON.stringify({ origin: `https://${host}`, bootstrap, batchLimit: MAX_WS_MESSAGE });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Web Proxy</title></head>
<body><main><h1>Connection bridge</h1><p>This page is opened by a compatible Telegram client.</p></main>
<script>
(()=>{'use strict';
const cfg=${config};
let port=null, sessionToken='', socket=null, creating=false, closed=false;
const pending=[];
const fragment=new URLSearchParams(location.hash.slice(1));
const nonce=fragment.get('android')||'';
history.replaceState(null,'','/');
function status(state){try{port&&port.postMessage({t:'status',state})}catch{}}
function splitFrames(buffer){
 const input=new Uint8Array(buffer); let off=0,count=0,out=[];
 while(off<input.length){
  if(++count>4096||input.length-off<8)throw Error('bad frame');
  const view=new DataView(input.buffer,input.byteOffset+off,8); const len=view.getUint32(4);
  if(len>1048576||off+8+len>input.length)throw Error('bad frame');
  out.push(buffer.slice(off,off+8+len)); off+=8+len;
 }
 if(!out.length)throw Error('empty'); return out;
}
function sendToApp(buffer){for(const frame of splitFrames(buffer))port.postMessage(frame,[frame]);}
function fail(){status('failed');close(false)}
async function createSession(hello){
 try{
  const response=await fetch(cfg.origin+'/api/v1/session',{method:'POST',headers:{Authorization:'Bearer '+cfg.bootstrap,'Content-Type':'application/octet-stream','X-Carrier-Mode':'websocket'},body:hello,cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});
  if(!response.ok||response.headers.get('X-Carrier-Mode')!=='websocket')throw Error('session');
  sessionToken=response.headers.get('X-Session-Token')||'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(sessionToken))throw Error('token');
  sendToApp(await response.arrayBuffer());
  openSocket();
 }catch(e){fail()}
}
function openSocket(){
 const target=cfg.origin.replace(/^https:/,'wss:')+'/api/v1/ws';
 socket=new WebSocket(target,'tproxy-v1.'+sessionToken); socket.binaryType='arraybuffer';
 socket.onopen=()=>{status('connected');while(pending.length)socket.send(pending.shift())};
 socket.onmessage=e=>{if(!(e.data instanceof ArrayBuffer)||!e.data.byteLength)return fail();try{sendToApp(e.data)}catch{return fail()}};
 socket.onerror=()=>{}; socket.onclose=()=>{if(!closed)fail()};
}
function fromApp(data){
 if(data instanceof ArrayBuffer){
  try{splitFrames(data)}catch{return fail()}
  if(!creating){creating=true;createSession(data);return}
  if(!sessionToken||!socket||socket.readyState!==WebSocket.OPEN){pending.push(data);return}
  if(socket.bufferedAmount>cfg.batchLimit)return fail();
  socket.send(data);
 }else if(data&&data.t==='close')close(true);
}
function activate(next){port=next;port.onmessage=e=>fromApp(e.data);port.start&&port.start();status('connecting')}
const native=globalThis.TelegramWebProxy;
if(nonce&&native&&typeof native.postMessage==='function'){
 const adapter={onmessage:null,start(){},close(){native.onmessage=null},postMessage(value){
  if(value instanceof ArrayBuffer){for(const frame of splitFrames(value))native.postMessage(frame)}
  else native.postMessage(JSON.stringify(value));
 }};
 native.onmessage=e=>{let d=e.data;if(typeof d==='string'){try{d=JSON.parse(d)}catch{return}}adapter.onmessage&&adapter.onmessage({data:d})};
 activate(adapter);native.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce}));
}
addEventListener('message',e=>{
 if(port||e.source!==parent||!e.data||e.data.t!=='tproxy-init'||e.data.v!==1||e.ports.length!==1)return;
 try{const u=new URL(e.origin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port)return}catch{return}
 activate(e.ports[0]);
});
function close(notify){if(closed)return;closed=true;try{socket&&socket.close()}catch{}if(notify&&sessionToken)fetch(cfg.origin+'/api/v1/session',{method:'DELETE',headers:{Authorization:'Bearer '+sessionToken},keepalive:true,credentials:'omit'}).catch(()=>{});try{port&&port.close()}catch{}}
addEventListener('pagehide',()=>close(true),{once:true});
})();
</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self' wss:; style-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:*",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    },
  });
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
  return new TextEncoder().encode(String(env.SESSION_SIGNING_KEY || env.PROXY_SECRET || ""));
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

function encodeFrame(type, streamId, payload = new Uint8Array()) {
  if (streamId < 0 || streamId > 0xffffff || payload.length > MAX_PAYLOAD) throw new Error("invalid frame");
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out[0] = type; out[1] = streamId >>> 16; out[2] = streamId >>> 8; out[3] = streamId;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, HEADER_SIZE);
  return out;
}

function parseFrames(input) {
  const frames = []; let offset = 0;
  while (offset < input.length) {
    if (frames.length >= MAX_BATCH_FRAMES || input.length - offset < HEADER_SIZE) throw new Error("bad batch");
    const view = new DataView(input.buffer, input.byteOffset + offset, HEADER_SIZE);
    const length = view.getUint32(4);
    if (length > MAX_PAYLOAD || offset + HEADER_SIZE + length > input.length) throw new Error("bad payload");
    frames.push({ type: input[offset], streamId: (input[offset + 1] << 16) | (input[offset + 2] << 8) | input[offset + 3], payload: input.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length) });
    offset += HEADER_SIZE + length;
  }
  if (!frames.length) throw new Error("empty batch");
  return frames;
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
function canonicalHost(value) { return String(value || "").trim().toLowerCase().replace(/\.$/, ""); }
function clampInt(value, min, max, fallback) { const n = Number.parseInt(value, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function u32(value) { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; }
function randomToken(bytes) { const value = new Uint8Array(bytes); crypto.getRandomValues(value); return base64url(value); }
function hexToBytes(hex) { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16); return out; }
function base64url(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64urlDecode(value) { const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4); const raw = atob(padded); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
function safeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 240);
  return String(error).slice(0, 240);
}

function hexPrefix(bytes, limit = 16) {
  return [...bytes.subarray(0, limit)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }

export const _test = { FRAME, encodeFrame, parseFrames, isHello, exactBridgeQuery };







