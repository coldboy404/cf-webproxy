// cf-webproxy | MIT | Generated deployment file; edit src/ and run npm run bundle.
// Configure PROXY_SECRET; optional RELAY_TRANSPORT=kws. Never put secrets in this file.

// src/index.js
import { connect } from "cloudflare:sockets";

// src/mtproxy.js
var TAGS = /* @__PURE__ */ new Set([4025479151, 4008636142, 3722304989]);
var TELEGRAM_DCS = Object.freeze({ 1: "149.154.175.50", 2: "149.154.167.51", 3: "149.154.175.100", 4: "149.154.167.91", 5: "149.154.171.5" });
var AesCtrStream = class {
  constructor(keyBytes, ivBytes) {
    if (keyBytes.length !== 32 || ivBytes.length !== 16) throw new Error("bad AES material");
    this.keyPromise = crypto.subtle.importKey("raw", keyBytes, "AES-CTR", false, ["encrypt"]);
    this.counter = new Uint8Array(ivBytes);
    this.spare = new Uint8Array();
  }
  async crypt(input) {
    const src = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!this.spare.length && src.length && src.length % 16 === 0) {
      const key = await this.keyPromise;
      const out2 = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: this.counter, length: 128 }, key, src));
      addBlocks(this.counter, src.length / 16);
      return out2;
    }
    const out = new Uint8Array(src.length);
    let pos = 0;
    if (this.spare.length) {
      const n = Math.min(this.spare.length, src.length);
      for (let i = 0; i < n; i++) out[i] = src[i] ^ this.spare[i];
      this.spare = this.spare.subarray(n);
      pos = n;
    }
    if (pos < src.length) {
      const need = src.length - pos, blocks = Math.ceil(need / 16);
      const padded = new Uint8Array(blocks * 16);
      padded.set(src.subarray(pos));
      const key = await this.keyPromise;
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: this.counter, length: 128 }, key, padded));
      addBlocks(this.counter, blocks);
      out.set(encrypted.subarray(0, need), pos);
      if (need < encrypted.length) this.spare = encrypted.slice(need);
    }
    return out;
  }
};
function addBlocks(counter, blocks) {
  let carry = blocks;
  for (let i = 15; i >= 0 && carry; i--) {
    const sum = counter[i] + (carry & 255);
    counter[i] = sum & 255;
    carry = Math.floor(carry / 256) + (sum >>> 8);
  }
}
function reverse(bytes) {
  return Uint8Array.from(bytes).reverse();
}
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}
function parseProxySecret(value) {
  const s = String(value || "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(s)) return { bridge: hex(s), inner: hex(s), mode: "plain" };
  if (/^dd[0-9a-f]{32}$/.test(s)) return { bridge: hex(s), inner: hex(s.slice(2)), mode: "dd" };
  if (/^ee/.test(s)) throw new Error("FakeTLS secrets are not supported in WEB mode");
  throw new Error("PROXY_SECRET must be 32 hex characters, optionally prefixed with dd");
}
function hex(s) {
  const x = new Uint8Array(s.length / 2);
  for (let i = 0; i < x.length; i++) x[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return x;
}
async function acceptClientHandshake(packet, secret) {
  if (packet.length !== 64) throw new Error("bad handshake length");
  const material = packet.subarray(8, 56), rev = reverse(material);
  const decKey = await sha256(concat(material.subarray(0, 32), secret));
  const dec = new AesCtrStream(decKey, material.subarray(32, 48));
  const encKey = await sha256(concat(rev.subarray(0, 32), secret));
  const enc = new AesCtrStream(encKey, rev.subarray(32, 48));
  const plain = await dec.crypt(packet);
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const tag = view.getUint32(56, true), dcId = view.getInt16(60, true);
  if (!TAGS.has(tag) || !TELEGRAM_DCS[Math.abs(dcId)]) throw new Error("invalid MTProxy handshake");
  return { tag, dcId, clientDecrypt: dec, clientEncrypt: enc };
}
async function createTelegramHandshake(tag, dcId) {
  let nonce;
  do {
    nonce = new Uint8Array(64);
    crypto.getRandomValues(nonce);
  } while (reserved(nonce));
  const v = new DataView(nonce.buffer);
  v.setUint32(56, tag, true);
  v.setInt16(60, dcId, true);
  nonce[62] = nonce[63] = 0;
  const material = nonce.subarray(8, 56), rev = reverse(material);
  const encrypt = new AesCtrStream(material.subarray(0, 32), material.subarray(32, 48));
  const decrypt = new AesCtrStream(rev.subarray(0, 32), rev.subarray(32, 48));
  const encrypted = await encrypt.crypt(nonce);
  const wire = new Uint8Array(nonce);
  wire.set(encrypted.subarray(56), 56);
  return { wire, encrypt, decrypt };
}
function reserved(n) {
  const v = new DataView(n.buffer, n.byteOffset, n.byteLength), x = v.getUint32(0, true);
  return n[0] === 239 || x === 1145128264 || x === 1414745936 || x === 542393671 || x === 4008636142 || x === 3722304989 || v.getUint32(4, true) === 0;
}

// src/kws.js
var KWS_LIMITS = Object.freeze({
  openTimeout: 1e4,
  writeTimeout: 3e4,
  pollInterval: 10,
  maxMessage: 4 * 1024 * 1024,
  queueBytes: 8 * 1024 * 1024,
  queueItems: 128,
  writeHighWater: 256 * 1024
});
function relayTransport(env) {
  const value = env.RELAY_TRANSPORT ?? "tcp";
  if (value !== "tcp" && value !== "kws") throw new Error("RELAY_TRANSPORT must be tcp or kws");
  return value;
}
function kwsUrls(dcId) {
  if (!Number.isInteger(dcId) || Math.abs(dcId) < 1 || Math.abs(dcId) > 5) throw new Error("invalid KWS DC");
  const dc = Math.abs(dcId);
  const urls = [`wss://kws${dc}.web.telegram.org/apiws`, `wss://kws${dc}-1.web.telegram.org/apiws`];
  return dcId < 0 ? urls.reverse() : urls;
}
var PacketFramer = class {
  constructor(tag) {
    if (![4025479151, 4008636142, 3722304989].includes(tag)) throw new Error("unsupported transport tag");
    this.tag = tag;
    this.header = new Uint8Array(4);
    this.reset();
  }
  reset() {
    this.headerBytes = 0;
    this.packet = null;
    this.pendingBytes = 0;
  }
  async push(bytes, emit) {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.packet) {
        let need = this.tag === 4025479151 ? 1 : 4;
        if (this.headerBytes) {
          if (this.tag === 4025479151 && (this.header[0] & 127) === 127) need = 4;
        }
        const take2 = Math.min(need - this.headerBytes, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + take2), this.headerBytes);
        this.headerBytes += take2;
        offset += take2;
        this.pendingBytes = this.headerBytes;
        if (this.headerBytes < need) continue;
        let body;
        if (this.tag === 4025479151) {
          const short = this.header[0] & 127;
          if (short === 127 && this.headerBytes === 1) continue;
          const words = short === 127 ? this.header[1] + this.header[2] * 256 + this.header[3] * 65536 : short;
          if (short === 127 && words < 127) throw new Error("invalid packet length");
          body = words * 4;
        } else {
          body = new DataView(this.header.buffer).getUint32(0, true) & 2147483647;
          if (this.tag === 4008636142 && body % 4) throw new Error("unaligned packet length");
        }
        if (!body || body + this.headerBytes > KWS_LIMITS.maxMessage) throw new Error("packet length limit");
        this.packet = new Uint8Array(body + this.headerBytes);
        this.packet.set(this.header.subarray(0, this.headerBytes));
      }
      const take = Math.min(this.packet.length - this.pendingBytes, bytes.length - offset);
      this.packet.set(bytes.subarray(offset, offset + take), this.pendingBytes);
      this.pendingBytes += take;
      offset += take;
      if (this.pendingBytes === this.packet.length) {
        const packet = this.packet;
        this.reset();
        await emit(packet);
      }
    }
  }
};
async function upgrade(url, signal) {
  const response = await fetch(url.replace(/^wss:/, "https:"), {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "binary" },
    redirect: "manual",
    signal
  });
  if (response.status !== 101 || !response.webSocket) throw new Error("KWS upgrade rejected");
  const ws = response.webSocket;
  if (response.headers.get("Sec-WebSocket-Protocol") !== "binary") {
    ws.accept();
    ws.close(1e3, "invalid subprotocol");
    throw new Error("KWS binary subprotocol required");
  }
  ws.accept();
  return ws;
}
function connectKws(dcId, options = {}) {
  const urls = kwsUrls(dcId), signal = options.signal;
  let ws, generation = 0, ended = false, connected = false, timer;
  let resolveOpen, rejectOpen, resolveClosed, controller, wakeRead;
  let queue = [], queueBytes = 0, failure;
  const waits = /* @__PURE__ */ new Set(), dialAbort = new AbortController();
  const opened = new Promise((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  opened.catch(() => {
  });
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const closeWs = (socket) => {
    try {
      socket?.close(1e3, "relay closed");
    } catch {
    }
  };
  function finish(error) {
    if (ended) return;
    ended = true;
    failure = error;
    clearTimeout(timer);
    generation++;
    dialAbort.abort();
    signal?.removeEventListener("abort", aborted);
    closeWs(ws);
    queue = [];
    queueBytes = 0;
    if (!connected) rejectOpen(error || new Error("KWS closed"));
    try {
      if (error) controller.error(error);
      else controller.close();
    } catch {
    }
    wakeRead?.();
    for (const wake of [...waits]) wake();
    resolveClosed();
  }
  const aborted = () => finish(new Error("KWS aborted"));
  const readable = new ReadableStream({
    start(c) {
      controller = c;
    },
    async pull(c) {
      if (!queue.length && !ended) await new Promise((resolve) => {
        wakeRead = resolve;
      });
      wakeRead = null;
      if (ended || !queue.length) return;
      const bytes = queue.shift();
      queueBytes -= bytes.length;
      c.enqueue(bytes);
    },
    cancel() {
      finish();
    }
  }, { highWaterMark: 0 });
  async function pause() {
    await new Promise((resolve) => {
      let timeout;
      const wake = () => {
        clearTimeout(timeout);
        waits.delete(wake);
        resolve();
      };
      waits.add(wake);
      timeout = setTimeout(wake, KWS_LIMITS.pollInterval);
    });
  }
  const writable = new WritableStream({
    async write(value) {
      await opened;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (!bytes.length || bytes.length > KWS_LIMITS.maxMessage) throw new Error("KWS write limit");
      const deadline = Date.now() + KWS_LIMITS.writeTimeout;
      while (!ended && (ws.bufferedAmount || 0) >= KWS_LIMITS.writeHighWater) {
        if (Date.now() >= deadline) {
          finish(new Error("KWS write timeout"));
          break;
        }
        await pause();
      }
      if (ended) throw failure || new Error("KWS closed");
      if ((ws.bufferedAmount || 0) + bytes.length > KWS_LIMITS.queueBytes) {
        const error = new Error("KWS send buffer limit");
        finish(error);
        throw error;
      }
      try {
        ws.send(bytes);
      } catch (error) {
        finish(error);
        throw error;
      }
    },
    close() {
      finish();
    },
    abort() {
      finish();
    }
  }, { highWaterMark: 1 });
  function attempt(index) {
    if (ended) return;
    const current = ++generation;
    let candidate;
    const failed = (error) => {
      if (ended || current !== generation) return;
      clearTimeout(timer);
      generation++;
      if (ws === candidate) ws = null;
      closeWs(candidate);
      if (index + 1 < urls.length && !connected) attempt(index + 1);
      else finish(error);
    };
    const attach = (socket) => {
      candidate = socket;
      if (ended || current !== generation) {
        closeWs(socket);
        return;
      }
      ws = socket;
      socket.binaryType = "arraybuffer";
      const onOpen = () => {
        if (ended || current !== generation || connected) return;
        if (socket.protocol && socket.protocol !== "binary") return failed(new Error("KWS binary subprotocol required"));
        connected = true;
        clearTimeout(timer);
        resolveOpen();
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", () => {
        if (connected && current === generation) finish(new Error("KWS error"));
        else failed(new Error("KWS open failed"));
      });
      socket.addEventListener("close", () => {
        if (ended || current !== generation) return;
        if (connected) finish();
        else failed(new Error("KWS closed before open"));
      });
      socket.addEventListener("message", (event) => {
        if (ended || current !== generation || !connected) return;
        const value = event.data;
        if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) return finish(new Error("KWS requires binary messages"));
        const bytes = new Uint8Array(value);
        if (!bytes.length || bytes.length > KWS_LIMITS.maxMessage || queue.length >= KWS_LIMITS.queueItems || queueBytes + bytes.length > KWS_LIMITS.queueBytes) return finish(new Error("KWS receive queue limit"));
        queue.push(bytes);
        queueBytes += bytes.length;
        wakeRead?.();
      });
      if (socket.readyState === 1) onOpen();
    };
    timer = setTimeout(() => failed(new Error("KWS open timeout")), KWS_LIMITS.openTimeout / urls.length);
    try {
      if (options.WebSocket) attach(new options.WebSocket(urls[index], "binary"));
      else upgrade(urls[index], dialAbort.signal).then(attach, failed);
    } catch (error) {
      failed(error);
    }
  }
  if (signal?.aborted) aborted();
  else {
    signal?.addEventListener("abort", aborted, { once: true });
    attempt(0);
  }
  return { readable, writable, opened, closed, close() {
    finish();
    return closed;
  } };
}

// src/protocol.js
var FRAME = Object.freeze({
  OPEN: 1,
  DATA: 2,
  CLOSE: 3,
  WINDOW: 4,
  PING: 5,
  PONG: 6,
  HELLO: 16,
  WELCOME: 17,
  BYE: 31
});
var HEADER_SIZE = 8;
var MAX_PAYLOAD = 1024 * 1024;
var MAX_BATCH_FRAMES = 4096;
var INITIAL_WINDOW = 4 * 1024 * 1024;
var DATA_CHUNK = 64 * 1024;
var MAX_WS_MESSAGE = 2 * 1024 * 1024;
function encodeFrame(type, streamId, payload = new Uint8Array()) {
  if (streamId < 0 || streamId > 16777215 || payload.length > MAX_PAYLOAD) throw new Error("invalid frame");
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out[0] = type;
  out[1] = streamId >>> 16;
  out[2] = streamId >>> 8;
  out[3] = streamId;
  new DataView(out.buffer).setUint32(4, payload.length);
  out.set(payload, HEADER_SIZE);
  return out;
}
function parseFrames(input) {
  const frames = [];
  let offset = 0;
  while (offset < input.length) {
    if (frames.length >= MAX_BATCH_FRAMES || input.length - offset < HEADER_SIZE) throw new Error("bad batch");
    const view = new DataView(input.buffer, input.byteOffset + offset, HEADER_SIZE);
    const length = view.getUint32(4);
    if (length > MAX_PAYLOAD || offset + HEADER_SIZE + length > input.length) throw new Error("bad payload");
    frames.push({ type: input[offset], streamId: input[offset + 1] << 16 | input[offset + 2] << 8 | input[offset + 3], payload: input.subarray(offset + HEADER_SIZE, offset + HEADER_SIZE + length) });
    offset += HEADER_SIZE + length;
  }
  if (!frames.length) throw new Error("empty batch");
  return frames;
}
function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// src/session.js
var LIMITS = Object.freeze({
  itemCost: 256,
  ingressBytes: 8 * 1024 * 1024,
  ingressItems: 128,
  uplinkBytes: 8 * 1024 * 1024,
  uplinkItems: 8192,
  uplinkBatchBytes: DATA_CHUNK,
  uplinkBatchItems: 64,
  streamBytes: INITIAL_WINDOW + 1024 * 1024,
  streamItems: 4096,
  downlinkBytes: 8 * 1024 * 1024,
  downlinkItems: 8192,
  sessionConnectTimeout: 10 * 60 * 1e3,
  handshakeTimeout: 15e3,
  connectTimeout: 1e4,
  writeTimeout: 3e4
});
var RelaySession = class {
  constructor(ctx, env, connect2, kwsConnect = connectKws) {
    this.ctx = ctx;
    this.env = env;
    this.connect = connect2;
    this.transport = relayTransport(env);
    this.kwsConnect = kwsConnect;
    this.initialized = false;
    this.closed = false;
    this.ws = null;
    this.streams = /* @__PURE__ */ new Map();
    this.closedIds = /* @__PURE__ */ new Set();
    this.maxStreams = clampInt(env.MAX_STREAMS, 1, 128, 64);
    this.diagnostics = String(env.DIAGNOSTICS || "") === "1";
    this.traceId = this.diagnostics ? crypto.randomUUID().slice(0, 8) : null;
    this.messageCount = 0;
    this.messageChain = Promise.resolve();
    this.ingressBytes = 0;
    this.ingressItems = 0;
    this.uplinkBytes = 0;
    this.uplinkItems = 0;
    this.downlinkBytes = 0;
    this.downlinkItems = 0;
    this.downlinkWaiters = /* @__PURE__ */ new Set();
    this.secret = null;
  }
  trace(event, details = {}) {
    if (this.diagnostics) console.log("webproxy", { traceId: this.traceId, event, ...details });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (this.closed) return new Response("session closed", { status: 404 });
    if (url.pathname === "/internal/init" && request.method === "POST") {
      if (!this.initialized) {
        const expiresAt = await this.ctx.storage.transaction(async (storage) => {
          const saved = await storage.get("expiresAt");
          const deadline = saved ?? Date.now() + LIMITS.sessionConnectTimeout;
          if (!Number.isSafeInteger(deadline) || deadline <= Date.now()) return null;
          await storage.put({ expiresAt: deadline });
          await storage.setAlarm(deadline);
          return deadline;
        });
        if (this.closed || expiresAt === null) {
          this.shutdown("session_connect_expired");
          return new Response("session expired", { status: 404 });
        }
        this.initialized = true;
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/internal/ws" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      if (this.ws) return new Response("already connected", { status: 409 });
      const expiresAt = await this.ctx.storage.get("expiresAt");
      if (this.closed) return new Response("session closed", { status: 404 });
      if (this.ws) return new Response("already connected", { status: 409 });
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
        this.shutdown("session_connect_expired");
        return new Response("unknown session", { status: 404 });
      }
      this.initialized = true;
      this.ctx.waitUntil(this.ctx.storage.deleteAlarm().catch(() => {
      }));
      return this.acceptWebSocket(request.headers.get("X-TProxy-Protocol") || "");
    }
    if (url.pathname === "/internal/close" && request.method === "POST") {
      this.shutdown("session_delete");
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }
  // Connection-local relay used by both Durable Objects and Pages.
  acceptWebSocket(protocol) {
    if (this.closed) return new Response("session closed", { status: 404 });
    if (this.ws) return new Response("already connected", { status: 409 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.ws = server;
    this.trace("websocket_accepted");
    server.addEventListener("message", (event) => this.enqueueMessage(event.data));
    server.addEventListener("close", (event) => {
      this.trace("websocket_closed", { code: event.code, clean: event.wasClean });
      this.shutdown("websocket_close");
    });
    server.addEventListener("error", () => this.shutdown("websocket_error"));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {}
    });
  }
  async alarm() {
    if (this.ws && !this.closed) return;
    const expiresAt = await this.ctx.storage.get("expiresAt");
    if (this.ws && !this.closed) return;
    if (!this.closed && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }
    this.shutdown("session_connect_expired", false);
    await this.clearSessionState();
  }
  async clearSessionState() {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.delete("expiresAt");
      await storage.deleteAlarm();
    });
  }
  enqueueMessage(data) {
    if (this.closed) return;
    const length = data instanceof Blob ? data.size : data instanceof ArrayBuffer ? data.byteLength : 0;
    if (!length || length > MAX_WS_MESSAGE) return this.protocolError("invalid_websocket_message");
    const cost = length + LIMITS.itemCost;
    if (this.ingressBytes + cost > LIMITS.ingressBytes || this.ingressItems >= LIMITS.ingressItems) {
      return this.protocolError("ingress_queue_limit");
    }
    this.ingressBytes += cost;
    this.ingressItems++;
    this.messageChain = this.messageChain.then(() => this.onMessage(data)).catch(() => this.protocolError("message_handler_failed")).finally(() => {
      this.ingressBytes -= cost;
      this.ingressItems--;
    });
    this.ctx.waitUntil(this.messageChain);
    return this.messageChain;
  }
  async onMessage(data) {
    if (this.closed) return;
    if (data instanceof Blob) data = await data.arrayBuffer();
    if (this.closed) return;
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > MAX_WS_MESSAGE) {
      return this.protocolError("invalid_websocket_message");
    }
    let frames;
    try {
      frames = parseFrames(new Uint8Array(data));
    } catch {
      return this.protocolError("frame_parse_failed");
    }
    if (this.diagnostics) {
      this.trace("frames_received", {
        message: ++this.messageCount,
        bytes: data.byteLength,
        frames: frames.map(({ type, streamId, payload }) => ({ type, streamId, length: payload.length }))
      });
    }
    for (const frame of frames) {
      if (frame.streamId === 0) {
        if (frame.type !== FRAME.PONG || frame.payload.length > 64) return this.protocolError("invalid_control_frame");
      } else if (frame.type === FRAME.OPEN) this.openStream(frame);
      else if (frame.type === FRAME.DATA) this.queueWrite(frame);
      else if (frame.type === FRAME.WINDOW) this.addWindow(frame);
      else if (frame.type === FRAME.CLOSE) {
        if (frame.payload.length) return this.protocolError("invalid_close");
        if (!this.streams.has(frame.streamId) && !this.closedIds.has(frame.streamId)) return this.protocolError("unknown_stream");
        this.closeStream(frame.streamId, false);
      } else return this.protocolError("unknown_frame_type");
      if (this.closed) return;
    }
  }
  openStream(frame) {
    const id = frame.streamId;
    if (!id || frame.payload.length || this.streams.has(id) || this.closedIds.has(id)) return this.protocolError("invalid_open");
    if (this.streams.size >= this.maxStreams) {
      this.rememberClosed(id);
      return this.sendFrame(FRAME.CLOSE, id);
    }
    const stream = {
      id,
      socket: null,
      writer: null,
      handshake: new Uint8Array(),
      handshakeBytes: 0,
      receiveWindow: INITIAL_WINDOW,
      sendCredit: INITIAL_WINDOW,
      closed: false,
      queue: [],
      queueHead: 0,
      pendingBytes: 0,
      pendingItems: 0,
      draining: false,
      abort: new AbortController(),
      sent: [],
      sentHead: 0,
      downlinkBytes: 0,
      downlinkItems: 0
    };
    stream.handshakeTimer = setTimeout(() => {
      this.trace("handshake_timeout", { streamId: id });
      this.closeStream(id, true);
    }, LIMITS.handshakeTimeout);
    this.streams.set(id, stream);
    this.trace("stream_opened", { streamId: id });
  }
  queueWrite(frame) {
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if (this.closedIds.has(frame.streamId) && frame.payload.length) return;
      return this.protocolError("unknown_stream");
    }
    const length = frame.payload.length;
    if (!length || length > stream.receiveWindow) return this.protocolError("invalid_data_window");
    const cost = length + HEADER_SIZE + LIMITS.itemCost;
    if (stream.pendingBytes + cost > LIMITS.streamBytes || stream.pendingItems >= LIMITS.streamItems || this.uplinkBytes + cost > LIMITS.uplinkBytes || this.uplinkItems >= LIMITS.uplinkItems) {
      this.trace("uplink_queue_limit", { streamId: stream.id });
      return this.closeStream(stream.id, true);
    }
    stream.receiveWindow -= length;
    stream.pendingBytes += cost;
    stream.pendingItems++;
    this.uplinkBytes += cost;
    this.uplinkItems++;
    stream.queue.push({ payload: new Uint8Array(frame.payload), cost });
    if (!stream.draining) {
      stream.draining = true;
      this.ctx.waitUntil(this.drainStream(stream));
    }
  }
  releaseWrite(stream, item) {
    stream.pendingBytes -= item.cost;
    stream.pendingItems--;
    this.uplinkBytes -= item.cost;
    this.uplinkItems--;
  }
  async drainStream(stream) {
    try {
      while (!stream.closed && !this.closed && stream.queueHead < stream.queue.length) {
        const items = [stream.queue[stream.queueHead]];
        stream.queue[stream.queueHead++] = null;
        let length = items[0].payload.length;
        while (stream.queueHead < stream.queue.length && items.length < LIMITS.uplinkBatchItems) {
          const next = stream.queue[stream.queueHead];
          if (length + next.payload.length > LIMITS.uplinkBatchBytes) break;
          items.push(next);
          length += next.payload.length;
          stream.queue[stream.queueHead++] = null;
        }
        try {
          let payload = items[0].payload;
          if (items.length > 1) {
            payload = new Uint8Array(length);
            let offset = 0;
            for (const item of items) {
              payload.set(item.payload, offset);
              offset += item.payload.length;
            }
          }
          await this.writeStream(stream, payload);
        } finally {
          for (const item of items) this.releaseWrite(stream, item);
        }
        if (stream.queueHead === stream.queue.length) {
          stream.queue = [];
          stream.queueHead = 0;
        } else if (stream.queueHead >= 64) {
          stream.queue = stream.queue.slice(stream.queueHead);
          stream.queueHead = 0;
        }
      }
    } catch (error) {
      this.trace("stream_write_failed", { streamId: stream.id, stage: stream.writer ? "relay" : "handshake_or_connect", error: safeError(error) });
      this.closeStream(stream.id, true);
    } finally {
      stream.draining = false;
    }
  }
  active(stream) {
    if (stream.closed || this.closed) throw new Error("stream closed");
  }
  async writeStream(stream, payload) {
    this.active(stream);
    let grant = payload.length;
    if (!stream.writer) {
      const take = Math.min(64 - stream.handshake.length, payload.length);
      const joined = new Uint8Array(stream.handshake.length + take);
      joined.set(stream.handshake);
      joined.set(payload.subarray(0, take), stream.handshake.length);
      stream.handshake = joined;
      stream.handshakeBytes += take;
      if (joined.length < 64) return;
      if (!this.secret) this.secret = parseProxySecret(this.env.PROXY_SECRET).inner;
      const client = await acceptClientHandshake(joined, this.secret);
      this.active(stream);
      const tg = await createTelegramHandshake(client.tag, client.dcId);
      this.active(stream);
      clearTimeout(stream.handshakeTimer);
      stream.handshakeTimer = null;
      const started = this.diagnostics ? Date.now() : 0;
      const socket = this.transport === "kws" ? this.kwsConnect(client.dcId, { signal: stream.abort.signal }) : this.connect({ hostname: TELEGRAM_DCS[Math.abs(client.dcId)], port: 443 }, { allowHalfOpen: false });
      stream.socket = socket;
      Promise.resolve(socket.closed).catch(() => {
      });
      await waitFor(socket.opened, stream.abort.signal, LIMITS.connectTimeout, "connect timeout");
      this.active(stream);
      this.trace("telegram_dc_connected", { streamId: stream.id, dcId: client.dcId, connectMs: started ? Date.now() - started : void 0 });
      stream.writer = socket.writable.getWriter();
      stream.clientDecrypt = client.clientDecrypt;
      stream.clientEncrypt = client.clientEncrypt;
      stream.tgEncrypt = tg.encrypt;
      stream.tgDecrypt = tg.decrypt;
      if (this.transport === "kws") stream.packetFramer = new PacketFramer(client.tag);
      stream.handshake = new Uint8Array();
      await waitFor(stream.writer.write(tg.wire), stream.abort.signal, LIMITS.writeTimeout, "write timeout");
      this.active(stream);
      this.ctx.waitUntil(this.readStream(stream));
      grant = stream.handshakeBytes + payload.length - take;
      stream.handshakeBytes = 0;
      payload = payload.subarray(take);
    }
    for (let offset = 0; offset < payload.length; offset += DATA_CHUNK) {
      const plain = await stream.clientDecrypt.crypt(payload.subarray(offset, offset + DATA_CHUNK));
      this.active(stream);
      const send = async (packet) => {
        this.active(stream);
        const encrypted = await stream.tgEncrypt.crypt(packet);
        this.active(stream);
        await waitFor(stream.writer.write(encrypted), stream.abort.signal, LIMITS.writeTimeout, "write timeout");
      };
      if (stream.packetFramer) await stream.packetFramer.push(plain, send);
      else await send(plain);
      this.active(stream);
    }
    this.grantWindow(stream, grant);
  }
  grantWindow(stream, length) {
    if (stream.closed || this.closed || !length) return;
    stream.receiveWindow += length;
    this.sendFrame(FRAME.WINDOW, stream.id, u32(length));
  }
  addWindow(frame) {
    if (frame.payload.length !== 4) return this.protocolError("invalid_window");
    const amount = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0);
    if (!amount) return this.protocolError("invalid_window");
    const stream = this.streams.get(frame.streamId);
    if (!stream) {
      if (this.closedIds.has(frame.streamId)) return;
      return this.protocolError("unknown_stream");
    }
    if (amount > INITIAL_WINDOW - stream.sendCredit) return this.protocolError("window_overflow");
    stream.sendCredit += amount;
    let remaining = amount;
    while (remaining) {
      const item = stream.sent[stream.sentHead];
      const used = Math.min(remaining, item.remaining);
      item.remaining -= used;
      remaining -= used;
      stream.downlinkBytes -= used;
      this.downlinkBytes -= used;
      if (!item.remaining) {
        const overhead = HEADER_SIZE + LIMITS.itemCost;
        stream.downlinkBytes -= overhead;
        this.downlinkBytes -= overhead;
        stream.downlinkItems--;
        this.downlinkItems--;
        stream.sent[stream.sentHead++] = null;
      }
    }
    if (stream.sentHead === stream.sent.length) {
      stream.sent = [];
      stream.sentHead = 0;
    } else if (stream.sentHead >= 64) {
      stream.sent = stream.sent.slice(stream.sentHead);
      stream.sentHead = 0;
    }
    this.wakeDownlink();
  }
  downlinkRoom(stream) {
    if (this.downlinkItems >= LIMITS.downlinkItems) return 0;
    return Math.max(0, Math.min(
      DATA_CHUNK,
      stream.sendCredit,
      LIMITS.downlinkBytes - this.downlinkBytes - HEADER_SIZE - LIMITS.itemCost
    ));
  }
  async waitDownlink(stream) {
    while (!stream.closed && !this.closed && !this.downlinkRoom(stream)) {
      await new Promise((resolve) => this.downlinkWaiters.add(resolve));
    }
    return !stream.closed && !this.closed;
  }
  wakeDownlink() {
    const waiters = [...this.downlinkWaiters];
    this.downlinkWaiters.clear();
    for (const resolve of waiters) resolve();
  }
  async readStream(stream) {
    const reader = stream.socket.readable.getReader();
    try {
      while (await this.waitDownlink(stream)) {
        const { value, done } = await reader.read();
        if (done || stream.closed || this.closed) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        let offset = 0;
        while (offset < bytes.length && await this.waitDownlink(stream)) {
          const size = Math.min(bytes.length - offset, this.downlinkRoom(stream));
          if (!size) continue;
          const cost = size + HEADER_SIZE + LIMITS.itemCost;
          stream.sendCredit -= size;
          stream.sent.push({ remaining: size });
          stream.downlinkBytes += cost;
          stream.downlinkItems++;
          this.downlinkBytes += cost;
          this.downlinkItems++;
          const plain = await stream.tgDecrypt.crypt(bytes.subarray(offset, offset + size));
          this.active(stream);
          const encrypted = await stream.clientEncrypt.crypt(plain);
          this.active(stream);
          this.sendFrame(FRAME.DATA, stream.id, encrypted);
          offset += size;
        }
      }
    } catch (error) {
      this.trace("stream_read_failed", { streamId: stream.id, error: safeError(error) });
    } finally {
      ignoreFailure(() => reader.cancel());
      try {
        reader.releaseLock();
      } catch {
      }
      this.closeStream(stream.id, true);
    }
  }
  closeStream(id, notify) {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    this.rememberClosed(id);
    stream.closed = true;
    clearTimeout(stream.handshakeTimer);
    stream.handshakeTimer = null;
    stream.abort.abort();
    for (let i = stream.queueHead; i < stream.queue.length; i++) this.releaseWrite(stream, stream.queue[i]);
    stream.queue = [];
    stream.queueHead = 0;
    stream.handshake = new Uint8Array();
    stream.packetFramer?.reset();
    this.downlinkBytes -= stream.downlinkBytes;
    this.downlinkItems -= stream.downlinkItems;
    stream.downlinkBytes = 0;
    stream.downlinkItems = 0;
    stream.sent = [];
    stream.sentHead = 0;
    this.wakeDownlink();
    ignoreFailure(() => stream.writer?.abort());
    ignoreFailure(() => stream.socket?.close());
    this.trace("stream_closed", { streamId: id, notify });
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
      this.shutdown("websocket_send_failed");
    }
  }
  protocolError(reason = "protocol_error") {
    this.trace("protocol_error", { reason });
    this.sendFrame(FRAME.BYE, 0);
    this.shutdown(reason);
  }
  shutdown(reason = "shutdown", cleanup = true) {
    if (this.closed) return;
    this.trace("session_shutdown", { reason, streams: this.streams.size });
    this.closed = true;
    for (const id of [...this.streams.keys()]) this.closeStream(id, false);
    this.wakeDownlink();
    try {
      this.ws?.close(1e3, "session closed");
    } catch {
    }
    this.ws = null;
    if (cleanup) this.ctx.waitUntil(this.clearSessionState().catch(() => {
    }));
  }
};
function waitFor(promise, signal, timeout, reason) {
  return new Promise((resolve, reject) => {
    const aborted = () => finish(reject, new Error("stream closed"));
    let timer, settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      settle(value);
    };
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => finish(reject, new Error(reason)), timeout);
  });
}
function ignoreFailure(fn) {
  try {
    Promise.resolve(fn()).catch(() => {
    });
  } catch {
  }
}
function safeError(error) {
  return error instanceof Error ? error.name + ": " + error.message.slice(0, 160) : "I/O error";
}

// src/bridge.js
function bridgePage(host, bootstrap) {
  const scriptNonce = randomNonce();
  const config = JSON.stringify({ origin: `https://${host}`, bootstrap, batchLimit: MAX_WS_MESSAGE, maxPendingItems: 1024, connectTimeout: 15e3, sendHighWater: 512 * 1024, sendRetry: 10, writeTimeout: 3e4 });
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Web Proxy</title></head>
<body><main><h1>Connection bridge</h1><p>This page is opened by a compatible Telegram client.</p></main>
<script nonce="${scriptNonce}">
(()=>{'use strict';
const cfg=${config};
let port=null, sessionToken='', socket=null, creating=false, closed=false;
const pending=[]; let pendingHead=0,pendingBytes=0,sendTimer=null,stalledAt=null,lastBuffered=0;
const bootstrapAbort=new AbortController(); let connectTimer=null;
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
function fail(){if(closed)return;status('failed');close(false)}
async function createSession(hello){
 try{
  const response=await fetch(cfg.origin+'/api/v1/session',{method:'POST',headers:{Authorization:'Bearer '+cfg.bootstrap,'Content-Type':'application/octet-stream','X-Carrier-Mode':'websocket'},body:hello,mode:'same-origin',redirect:'error',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:bootstrapAbort.signal});
  if(!response.ok||response.headers.get('X-Carrier-Mode')!=='websocket')throw Error('session');
  sessionToken=response.headers.get('X-Session-Token')||'';
  if(!/^[A-Za-z0-9_-]{43}$/.test(sessionToken))throw Error('token');
  const welcome=await response.arrayBuffer();
  if(closed)return;
  if(welcome.byteLength!==8||new Uint8Array(welcome)[0]!==0x11||new Uint8Array(welcome).slice(1).some(v=>v!==0))throw Error('welcome');
  sendToApp(welcome);
  if(!closed)openSocket();
 }catch(e){fail()}
}
function openSocket(){
 const target=cfg.origin.replace(/^https:/,'wss:')+'/api/v1/ws';
 socket=new WebSocket(target,'tproxy-v1.'+sessionToken); socket.binaryType='arraybuffer';
 socket.onopen=()=>{
  if(closed)return; clearTimeout(connectTimer);connectTimer=null;status('connected');
  pump();
 };
 socket.onmessage=e=>{if(closed)return;if(!(e.data instanceof ArrayBuffer)||!e.data.byteLength||e.data.byteLength>cfg.batchLimit)return fail();try{sendToApp(e.data)}catch{return fail()}};
 socket.onerror=()=>{}; socket.onclose=()=>{if(!closed)fail()};
}
// Bound the application queue separately from the browser's send buffer.
// Pause on congestion instead of dropping an otherwise healthy carrier.
function pump(){
 clearTimeout(sendTimer);sendTimer=null;
 if(closed||!socket||socket.readyState!==WebSocket.OPEN)return;
 while(pendingHead<pending.length){
  const data=pending[pendingHead],buffered=socket.bufferedAmount;
  if(buffered>cfg.batchLimit)return fail();
  // One valid large message may exceed the soft watermark on an empty socket.
  if(buffered>0&&buffered+data.byteLength>cfg.sendHighWater){
   const now=performance.now();
   if(stalledAt===null||buffered<lastBuffered)stalledAt=now;
   lastBuffered=buffered;
   if(now-stalledAt>=cfg.writeTimeout)return fail();
   sendTimer=setTimeout(pump,cfg.sendRetry);return;
  }
  try{socket.send(data)}catch{return fail()}
  pending[pendingHead++]=null;pendingBytes-=data.byteLength;stalledAt=null;lastBuffered=0;
  if(pendingHead===pending.length){pending.length=0;pendingHead=0}
  else if(pendingHead>=64){pending.splice(0,pendingHead);pendingHead=0}
 }
}
function fromApp(data){
 if(closed)return;
 if(data instanceof ArrayBuffer){
  if(!data.byteLength||data.byteLength>cfg.batchLimit)return fail();
  try{splitFrames(data)}catch{return fail()}
  if(!creating){creating=true;connectTimer=setTimeout(fail,cfg.connectTimeout);createSession(data);return}
  if(pending.length-pendingHead>=cfg.maxPendingItems||pendingBytes+data.byteLength>cfg.batchLimit)return fail();
  pending.push(data);pendingBytes+=data.byteLength;pump();
 }else if(data&&data.t==='close')close(true);
}
function activate(next){port=next;port.onmessage=e=>fromApp(e.data);port.start&&port.start();status('connecting')}
const native=globalThis.TelegramWebProxy;
if(/^[A-Za-z0-9_-]{43}$/.test(nonce)&&native&&typeof native.postMessage==='function'){
 const adapter={onmessage:null,start(){},close(){native.onmessage=null},postMessage(value){
  if(value instanceof ArrayBuffer){for(const frame of splitFrames(value))native.postMessage(frame)}
  else native.postMessage(JSON.stringify(value));
 }};
 native.onmessage=e=>{let d=e.data;if(typeof d==='string'){try{d=JSON.parse(d)}catch{return}}adapter.onmessage&&adapter.onmessage({data:d})};
 activate(adapter);native.postMessage(JSON.stringify({t:'tproxy-android-init',v:1,nonce}));
}
addEventListener('message',e=>{
 if(closed||port||e.source!==parent||!e.data||e.data.t!=='tproxy-init'||e.data.v!==1||e.ports.length!==1)return;
 try{const u=new URL(e.origin);if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port)return}catch{return}
 activate(e.ports[0]);
});
function close(notify){if(closed)return;closed=true;clearTimeout(connectTimer);connectTimer=null;clearTimeout(sendTimer);sendTimer=null;bootstrapAbort.abort();pending.length=0;pendingHead=0;pendingBytes=0;stalledAt=null;try{socket&&socket.close()}catch{}if(notify&&sessionToken)fetch(cfg.origin+'/api/v1/session',{method:'DELETE',headers:{Authorization:'Bearer '+sessionToken},keepalive:true,mode:'same-origin',redirect:'error',cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'}).catch(()=>{});try{port&&port.close()}catch{}}
addEventListener('pagehide',()=>close(true),{once:true});
})();
<\/script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${scriptNonce}'; connect-src https://${host} wss://${host}; style-src 'none'; img-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:*; sandbox allow-same-origin allow-scripts`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
    }
  });
}
function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
}

// src/auth.js
function createHmacSigner(subtle = crypto.subtle, maxKeys = 4) {
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new RangeError("invalid key cache limit");
  const keys = /* @__PURE__ */ new Map();
  return async function hmac2(keyBytes, data) {
    const bytes = new Uint8Array(keyBytes);
    const id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    let pending = keys.get(id);
    if (pending) keys.delete(id);
    else {
      pending = subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      pending.catch(() => {
        if (keys.get(id) === pending) keys.delete(id);
      });
    }
    keys.set(id, pending);
    if (keys.size > maxKeys) keys.delete(keys.keys().next().value);
    return new Uint8Array(await subtle.sign("HMAC", await pending, data));
  };
}
var hmac = createHmacSigner();

// src/config.js
function canonicalHost(value) {
  const host = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !host.includes(".") || host.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("Expected a DNS hostname without scheme, port or path");
  }
  return host;
}
function entranceHost(env, hostname) {
  const host = canonicalHost(hostname);
  const pinned = env.PUBLIC_HOSTNAME ? canonicalHost(env.PUBLIC_HOSTNAME) : null;
  const list = env.ALLOWED_HOSTNAMES ? String(env.ALLOWED_HOSTNAMES).split(",").map(canonicalHost) : [];
  if (pinned && pinned !== host) return null;
  if (list.length && !list.includes(host)) return null;
  return host;
}
function validateConfig(env) {
  if (!/^(?:[0-9a-f]{32}|dd[0-9a-f]{32})$/.test(String(env.PROXY_SECRET || ""))) {
    throw new Error("Invalid PROXY_SECRET");
  }
  const transport = env.RELAY_TRANSPORT ?? "tcp";
  if (transport !== "tcp" && transport !== "kws") throw new Error("RELAY_TRANSPORT must be tcp or kws");
  return transport;
}

// src/http.js
function createProxyHandler(backend) {
  return {
    async fetch(request, env, ctx) {
      try {
        return await route(request, env, ctx, backend);
      } catch (error) {
        console.error("unhandled request error", error);
        return camouflage();
      }
    }
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
    return url.pathname === "/healthz" || url.pathname === "/health" ? Response.json({ ok: false, error: "invalid_configuration" }, { status: 500, headers: noStore() }) : camouflage();
  }
  if (url.pathname === "/api/v1/session" || url.pathname === "/api/v1/ws") {
    if (request.headers.has("Origin") && request.headers.get("Origin") !== url.origin) return camouflage();
  }
  if (url.pathname === "/" && request.method === "GET") {
    const capability = exactBridgeQuery(url);
    if (!capability || !await capabilityMatches(capability, expectedHost, env.PROXY_SECRET)) {
      return publicPage();
    }
    const bootstrap = await createBootstrap(env, request.headers.get("CF-Connecting-IP") || "");
    return bridgePage(expectedHost, bootstrap);
  }
  if (url.pathname === "/api/v1/session") {
    if (request.headers.has("Cookie")) return camouflage();
    if (request.method === "DELETE") {
      const token = bearer(request);
      if (!await backend.verifyToken(env, expectedHost, token)) return camouflage();
      return backend.close(env, token);
    }
    if (request.method !== "POST" || !isBinary(request.headers.get("Content-Type"))) return camouflage();
    const bootstrap = bearer(request);
    if (!bootstrap || !await verifyBootstrap(env, bootstrap, request.headers.get("CF-Connecting-IP") || "")) return camouflage();
    const hello = await readHello(request);
    if (!isHello(hello)) return camouflage();
    const sessionToken = await backend.createToken(env, expectedHost);
    if (!await backend.initialize(env, sessionToken)) return camouflage();
    const welcome = encodeFrame(FRAME.WELCOME, 0);
    return new Response(welcome, {
      status: 200,
      headers: {
        ...noStore(),
        "Content-Type": "application/octet-stream",
        "X-Session-Token": sessionToken,
        "X-Carrier-Mode": "websocket",
        "X-Down-Cursor": "0"
      }
    });
  }
  if (url.pathname === "/api/v1/ws" && request.method === "GET" && !request.headers.has("Cookie") && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    const protocols = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((v) => v.trim());
    const protocol = protocols.find((v) => v.startsWith("tproxy-v1."));
    const token = protocol?.slice("tproxy-v1.".length);
    if (!await backend.verifyToken(env, expectedHost, token)) return camouflage();
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
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }
  });
}
function camouflage() {
  return new Response("<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>", {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
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
  const context = new TextEncoder().encode(`tdesktop-web-proxy-bridge-v1
${host}`);
  const expected = base64url(await hmac(secret, context));
  return constantTimeEqual(candidate, expected);
}
async function createBootstrap(env, _ip) {
  const ttl = clampInt(env.SESSION_TTL_SECONDS, 30, 600, 300);
  const payload = base64url(new TextEncoder().encode(JSON.stringify({ exp: Math.floor(Date.now() / 1e3) + ttl, n: randomToken(16) })));
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
    return Number.isInteger(data.exp) && data.exp >= Math.floor(Date.now() / 1e3);
  } catch {
    return false;
  }
}
function signingKey(env) {
  return new TextEncoder().encode(`cf-webproxy/session-signing/v1
${String(env.PROXY_SECRET || "")}`);
}
async function createSessionToken(env, host) {
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const mac = await sessionMac(env, host, nonce);
  const bytes = new Uint8Array(32);
  bytes.set(nonce);
  bytes.set(mac.subarray(0, 16), 16);
  return base64url(bytes);
}
async function verifySessionToken(env, host, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || "")) return false;
  const bytes = base64urlDecode(token);
  if (base64url(bytes) !== token) return false;
  const mac = await sessionMac(env, host, bytes.subarray(0, 16));
  return constantTimeEqual(base64url(bytes.subarray(16)), base64url(mac.subarray(0, 16)));
}
function sessionMac(env, host, nonce) {
  const context = new TextEncoder().encode("cf-webproxy/session-token/v1\n" + host + "\n");
  const bytes = new Uint8Array(context.length + nonce.length);
  bytes.set(context);
  bytes.set(nonce, context.length);
  return hmac(signingKey(env), bytes);
}
async function readHello(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), bytes = new Uint8Array(9);
  let length = 0;
  try {
    for (; ; ) {
      const { value, done } = await reader.read();
      if (done) return bytes.subarray(0, length);
      if (length + value.length > bytes.length) {
        await reader.cancel();
        return new Uint8Array();
      }
      bytes.set(value, length);
      length += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}
function isHello(bytes) {
  try {
    const frames = parseFrames(bytes);
    return frames.length === 1 && frames[0].type === FRAME.HELLO && frames[0].streamId === 0 && frames[0].payload.length === 1 && frames[0].payload[0] === 1;
  } catch {
    return false;
  }
}
function bearer(request) {
  const value = request.headers.get("Authorization") || "";
  return value.startsWith("Bearer ") ? value.slice(7) : "";
}
function isBinary(value) {
  return /^application\/octet-stream(?:\s*;.*)?$/i.test(value || "");
}
function noStore() {
  return { "Cache-Control": "no-store" };
}
function randomToken(bytes) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64url(value);
}
function hexToBytes(hex2) {
  const out = new Uint8Array(hex2.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex2.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function base64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
var _check = { FRAME, encodeFrame, parseFrames, isHello, exactBridgeQuery };
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// src/index.js
var index_default = createProxyHandler({
  createToken: createSessionToken,
  verifyToken: verifySessionToken,
  async initialize(env, token) {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    const response = await stub.fetch("https://session/internal/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    return response.ok;
  },
  attach(env, token, protocol) {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    return stub.fetch("https://session/internal/ws", {
      headers: { Upgrade: "websocket", "X-TProxy-Protocol": protocol }
    });
  },
  async close(env, token) {
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(token));
    await stub.fetch("https://session/internal/close", { method: "POST" });
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
});
var WebProxySession = class extends RelaySession {
  constructor(ctx, env) {
    super(ctx, env, connect);
  }
};
export {
  WebProxySession,
  _check,
  index_default as default
};
