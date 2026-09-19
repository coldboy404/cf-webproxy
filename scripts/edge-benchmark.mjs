#!/usr/bin/env node
import https from "node:https";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";

const args = parseArgs(process.argv.slice(2));
if (!args.host && !args.hosts && !args.file) usage("请使用 --host 或 --hosts 指定域名");
const hosts = unique([
  ...(args.host ? [args.host] : []),
  ...(args.hosts ? args.hosts.split(",") : []),
  ...(args.file ? (await fs.readFile(args.file, "utf8")).split(/\r?\n/) : []),
].map(normalizeHost).filter(Boolean));
const rounds = clamp(Number(args.rounds || 4), 1, 10);
const timeout = clamp(Number(args.timeout || 5000), 1000, 30000);

console.log(`测试 ${hosts.length} 个入口，每个 ${rounds} 次；指标为 HTTPS /healthz 建连及响应耗时。\n`);
const results = [];
for (const host of hosts) {
  const samples = [];
  let colo = "-";
  let error = "";
  for (let i = 0; i < rounds; i++) {
    try {
      const result = await probe(host, timeout);
      samples.push(result.ms);
      colo = result.colo || colo;
    } catch (cause) {
      error = cause?.message || String(cause);
    }
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : Infinity;
  results.push({ host, median, ok: samples.length, colo, error });
}
results.sort((a, b) => a.median - b.median);
console.table(results.map((r) => ({ 域名: r.host, 中位耗时: Number.isFinite(r.median) ? `${Math.round(r.median)} ms` : "失败", 成功次数: `${r.ok}/${rounds}`, CF节点: r.colo, 错误: r.ok ? "" : r.error })));
const best = results.find((r) => Number.isFinite(r.median));
if (!best) process.exitCode = 1;
else {
  console.log(`\n建议先在 Telegram 中测试：${best.host}`);
  console.log(`链接模板：https://t.me/webproxy?server=${best.host}&secret=你的PROXY_SECRET`);
  console.log("注意：这里测的是客户端到 Worker 入口的 HTTPS 延迟，不等于 Telegram 最终显示延迟。");
}

function probe(host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = https.request({ hostname: host, port: 443, path: "/healthz", method: "GET", servername: host, headers: { Host: host, "User-Agent": "cf-webproxy-edge-test/1" }, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (body.ok !== true) throw new Error("healthz 返回异常");
          resolve({ ms: performance.now() - started, colo: res.headers["cf-ray"]?.split("-").at(-1) || "" });
        } catch (error) { reject(error); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("超时")));
    req.once("error", reject);
    req.end();
  });
}
function parseArgs(items) { const out = {}; for (let i = 0; i < items.length; i++) { const item = items[i]; if (!item.startsWith("--")) continue; const [key, inline] = item.slice(2).split("=", 2); out[key] = inline ?? items[++i] ?? ""; } return out; }
function normalizeHost(value) { return String(value).trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase(); }
function unique(values) { return [...new Set(values)]; }
function clamp(value, min, max) { return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }
function usage(message) { console.error(message); console.error("示例：npm run edge:test -- --hosts proxy-a.example.com,proxy-b.example.com"); process.exit(2); }
