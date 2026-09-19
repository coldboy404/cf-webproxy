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

import { configuredHosts } from "../src/config.js";

test("configured hosts include primary and preferred aliases", () => {
  assert.deepEqual(
    [...configuredHosts({ PUBLIC_HOSTNAME: "Proxy.Example.com", PREFERRED_HOSTNAMES: " a.example.com, B.example.com " })],
    ["proxy.example.com", "a.example.com", "b.example.com"],
  );
});
