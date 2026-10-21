// Independent MIT implementation of Telegram's obfuscated WebSocket transport.
// Only official DC hosts are selectable; no client-provided URL reaches fetch.
export const KWS_LIMITS = Object.freeze({
  openTimeout: 10000, writeTimeout: 30000, pollInterval: 10,
  maxMessage: 4 * 1024 * 1024, queueBytes: 8 * 1024 * 1024,
  queueItems: 128, writeHighWater: 256 * 1024,
});

export function relayTransport(env) {
  const value = env.RELAY_TRANSPORT ?? "tcp";
  if (value !== "tcp" && value !== "kws") throw new Error("RELAY_TRANSPORT must be tcp or kws");
  return value;
}

export function kwsUrls(dcId) {
  if (!Number.isInteger(dcId) || Math.abs(dcId) < 1 || Math.abs(dcId) > 5) throw new Error("invalid KWS DC");
  const dc = Math.abs(dcId);
  const urls = [`wss://kws${dc}.web.telegram.org/apiws`, `wss://kws${dc}-1.web.telegram.org/apiws`];
  return dcId < 0 ? urls.reverse() : urls;
}

// Parse BEFORE encryption: CTR output cannot reveal packet boundaries. Retain
// at most one bounded packet, copying fragments once (not quadratic concat).
export class PacketFramer {
  constructor(tag) {
    if (![0xefefefef, 0xeeeeeeee, 0xdddddddd].includes(tag)) throw new Error("unsupported transport tag");
    this.tag = tag; this.header = new Uint8Array(4); this.reset();
  }
  reset() { this.headerBytes = 0; this.packet = null; this.pendingBytes = 0; }
  async push(bytes, emit) {
    let offset = 0;
    while (offset < bytes.length) {
      if (!this.packet) {
        let need = this.tag === 0xefefefef ? 1 : 4;
        if (this.headerBytes) {
          if (this.tag === 0xefefefef && (this.header[0] & 127) === 127) need = 4;
        }
        const take = Math.min(need - this.headerBytes, bytes.length - offset);
        this.header.set(bytes.subarray(offset, offset + take), this.headerBytes);
        this.headerBytes += take; offset += take; this.pendingBytes = this.headerBytes;
        if (this.headerBytes < need) continue;
        let body;
        if (this.tag === 0xefefefef) {
          const short = this.header[0] & 127; // top bit requests a quick ACK
          if (short === 127 && this.headerBytes === 1) continue;
          const words = short === 127 ? this.header[1] + this.header[2] * 256 + this.header[3] * 65536 : short;
          if (short === 127 && words < 127) throw new Error("invalid packet length");
          body = words * 4;
        } else {
          body = new DataView(this.header.buffer).getUint32(0, true) & 0x7fffffff;
          if (this.tag === 0xeeeeeeee && body % 4) throw new Error("unaligned packet length");
        }
        if (!body || body + this.headerBytes > KWS_LIMITS.maxMessage) throw new Error("packet length limit");
        this.packet = new Uint8Array(body + this.headerBytes);
        this.packet.set(this.header.subarray(0, this.headerBytes));
      }
      const take = Math.min(this.packet.length - this.pendingBytes, bytes.length - offset);
      this.packet.set(bytes.subarray(offset, offset + take), this.pendingBytes);
      this.pendingBytes += take; offset += take;
      if (this.pendingBytes === this.packet.length) {
        const packet = this.packet; this.reset();
        await emit(packet);
      }
    }
  }
}

// Fetch Upgrade is supported in both Workers and Pages, unlike depending on a
// browser-style outbound WebSocket constructor. Injection is for unit tests.
async function upgrade(url, signal) {
  const response = await fetch(url.replace(/^wss:/, "https:"), {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "binary" },
    redirect: "manual", signal,
  });
  if (response.status !== 101 || !response.webSocket) throw new Error("KWS upgrade rejected");
  const ws = response.webSocket;
  if (response.headers.get("Sec-WebSocket-Protocol") !== "binary") {
    ws.accept(); ws.close(1000, "invalid subprotocol");
    throw new Error("KWS binary subprotocol required");
  }
  ws.accept();
  return ws;
}

export function connectKws(dcId, options = {}) {
  const urls = kwsUrls(dcId), signal = options.signal;
  let ws, generation = 0, ended = false, connected = false, timer;
  let resolveOpen, rejectOpen, resolveClosed, controller, wakeRead;
  let queue = [], queueBytes = 0, failure;
  const waits = new Set(), dialAbort = new AbortController();
  const opened = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  opened.catch(() => {});
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const closeWs = socket => { try { socket?.close(1000, "relay closed"); } catch {} };
  function finish(error) {
    if (ended) return;
    ended = true; failure = error; clearTimeout(timer); generation++;
    dialAbort.abort(); signal?.removeEventListener("abort", aborted);
    closeWs(ws); queue = []; queueBytes = 0;
    if (!connected) rejectOpen(error || new Error("KWS closed"));
    // cancel() has already closed the ReadableStream before invoking us.
    try { if (error) controller.error(error); else controller.close(); } catch {}
    wakeRead?.();
    for (const wake of [...waits]) wake();
    resolveClosed();
  }
  const aborted = () => finish(new Error("KWS aborted"));
  const readable = new ReadableStream({
    start(c) { controller = c; },
    async pull(c) {
      if (!queue.length && !ended) await new Promise(resolve => { wakeRead = resolve; });
      wakeRead = null;
      if (ended || !queue.length) return;
      const bytes = queue.shift(); queueBytes -= bytes.length; c.enqueue(bytes);
    },
    cancel() { finish(); },
  }, { highWaterMark: 0 });
  async function pause() {
    await new Promise(resolve => {
      let timeout;
      const wake = () => { clearTimeout(timeout); waits.delete(wake); resolve(); };
      waits.add(wake); timeout = setTimeout(wake, KWS_LIMITS.pollInterval);
    });
  }
  const writable = new WritableStream({
    async write(value) {
      await opened;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      if (!bytes.length || bytes.length > KWS_LIMITS.maxMessage) throw new Error("KWS write limit");
      const deadline = Date.now() + KWS_LIMITS.writeTimeout;
      // Cloudflare may not expose bufferedAmount: session FIFO still bounds
      // writes there, but send() does not promise network-level drainage.
      while (!ended && (ws.bufferedAmount || 0) >= KWS_LIMITS.writeHighWater) {
        if (Date.now() >= deadline) { finish(new Error("KWS write timeout")); break; }
        await pause();
      }
      if (ended) throw failure || new Error("KWS closed");
      if ((ws.bufferedAmount || 0) + bytes.length > KWS_LIMITS.queueBytes) {
        const error = new Error("KWS send buffer limit"); finish(error); throw error;
      }
      try { ws.send(bytes); } catch (error) { finish(error); throw error; }
    },
    close() { finish(); }, abort() { finish(); },
  }, { highWaterMark: 1 });
  function attempt(index) {
    if (ended) return;
    const current = ++generation;
    let candidate;
    const failed = error => {
      if (ended || current !== generation) return;
      clearTimeout(timer); generation++;
      if (ws === candidate) ws = null;
      closeWs(candidate);
      if (index + 1 < urls.length && !connected) attempt(index + 1);
      else finish(error);
    };
    const attach = socket => {
      candidate = socket;
      if (ended || current !== generation) { closeWs(socket); return; }
      ws = socket; socket.binaryType = "arraybuffer";
      const onOpen = () => {
        if (ended || current !== generation || connected) return;
        if (socket.protocol && socket.protocol !== "binary") return failed(new Error("KWS binary subprotocol required"));
        connected = true; clearTimeout(timer); resolveOpen();
      };
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", () => {
        if (connected && current === generation) finish(new Error("KWS error"));
        else failed(new Error("KWS open failed"));
      });
      socket.addEventListener("close", () => {
        if (ended || current !== generation) return;
        if (connected) finish(); else failed(new Error("KWS closed before open"));
      });
      socket.addEventListener("message", event => {
        if (ended || current !== generation || !connected) return;
        const value = event.data;
        if (!(value instanceof ArrayBuffer) && !(value instanceof Uint8Array)) return finish(new Error("KWS requires binary messages"));
        const bytes = new Uint8Array(value);
        if (!bytes.length || bytes.length > KWS_LIMITS.maxMessage || queue.length >= KWS_LIMITS.queueItems ||
            queueBytes + bytes.length > KWS_LIMITS.queueBytes) return finish(new Error("KWS receive queue limit"));
        queue.push(bytes); queueBytes += bytes.length; wakeRead?.();
      });
      if (socket.readyState === 1) onOpen();
    };
    timer = setTimeout(() => failed(new Error("KWS open timeout")), KWS_LIMITS.openTimeout / urls.length);
    try {
      if (options.WebSocket) attach(new options.WebSocket(urls[index], "binary"));
      else upgrade(urls[index], dialAbort.signal).then(attach, failed);
    } catch (error) { failed(error); }
  }
  if (signal?.aborted) aborted();
  else { signal?.addEventListener("abort", aborted, { once: true }); attempt(0); }
  return { readable, writable, opened, closed, close() { finish(); return closed; } };
}
