import test from "node:test";
import assert from "node:assert/strict";
import { AesCtrStream, parseProxySecret, createTelegramHandshake } from "../src/mtproxy.js";

test("AES CTR is independent of chunk boundaries", async()=>{
 const key=Uint8Array.from({length:32},(_,i)=>i), iv=Uint8Array.from({length:16},(_,i)=>255-i), data=Uint8Array.from({length:1003},(_,i)=>i%251);
 const a=new AesCtrStream(key,iv), b=new AesCtrStream(key,iv);
 const whole=await a.crypt(data), parts=[];
 for(const [s,e] of [[0,1],[1,18],[18,511],[511,1003]]) parts.push(await b.crypt(data.subarray(s,e)));
 assert.deepEqual(Buffer.concat(parts.map(Buffer.from)),Buffer.from(whole));
});
test("secret modes",()=>{ assert.equal(parseProxySecret("00".repeat(16)).inner.length,16); assert.equal(parseProxySecret("dd"+"11".repeat(16)).inner.length,16); assert.throws(()=>parseProxySecret("ee"+"22".repeat(16))); });
test("Telegram handshake advances cipher and keeps first 56 bytes plain",async()=>{ const h=await createTelegramHandshake(0xeeeeeeee,2); assert.equal(h.wire.length,64); assert.equal(new DataView(h.wire.buffer).getUint32(56,true)===0xeeeeeeee,false); });

// Compare with Node/OpenSSL, not another copy of the implementation under test.
async function nativeCtr(key, iv, data) {
  const { createCipheriv } = await import("node:crypto");
  const cipher = createCipheriv("aes-256-ctr", key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
test("AES CTR aligned fast path matches native crypto and leaves input unchanged", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
  const iv = new Uint8Array(16).fill(255); iv[0] = 1;
  const backing = Uint8Array.from({ length: 65552 }, (_, i) => i % 251);
  const data = backing.subarray(8, 65544), saved = new Uint8Array(backing);
  const stream = new AesCtrStream(key, iv);
  assert.deepEqual(Buffer.from(await stream.crypt(data)), await nativeCtr(key, iv, data));
  assert.deepEqual(backing, saved); assert.equal(stream.spare.length, 0);
});
test("AES CTR mixed aligned, empty and partial chunks match native crypto across counter carry", async () => {
  const key = Uint8Array.from({ length: 32 }, (_, i) => i * 3);
  const iv = new Uint8Array(16).fill(255); iv[0] = 2;
  const data = Uint8Array.from({ length: 70013 }, (_, i) => (i * 17) % 251);
  const expected = await nativeCtr(key, iv, data);
  for (const sizes of [[16, 32, 64, 65536, 0, 1, 15], [1, 0, 15, 17, 65536, 31], [7, 9, 513, 1024, 65536], [65537, 2, 3, 5, 8, 13, 16]]) {
    const stream = new AesCtrStream(key, iv), parts = [];
    let offset = 0, i = 0;
    while (offset < data.length) {
      const size = Math.min(sizes[i++ % sizes.length], data.length - offset);
      parts.push(await stream.crypt(data.subarray(offset, offset + size))); offset += size;
      assert.ok(stream.spare.buffer.byteLength <= 15, "keystream tail must not retain a full payload buffer");
    }
    assert.deepEqual(Buffer.concat(parts.map(Buffer.from)), expected);
    assert.equal((await stream.crypt(new Uint8Array())).length, 0);
  }
});
test("AES CTR covers every partial-block boundary and resumes the aligned path", async () => {
  const key = new Uint8Array(32).fill(23), iv = new Uint8Array(16).fill(71);
  const data = Uint8Array.from({ length: 96 }, (_, i) => i);
  const expected = await nativeCtr(key, iv, data);
  for (let first = 1; first < 32; first++) {
    const stream = new AesCtrStream(key, iv);
    const parts = [await stream.crypt(data.subarray(0, first)), await stream.crypt(data.subarray(first, 32)), await stream.crypt(data.subarray(32))];
    assert.deepEqual(Buffer.concat(parts.map(Buffer.from)), expected);
    assert.equal(stream.spare.length, 0);
  }
});
