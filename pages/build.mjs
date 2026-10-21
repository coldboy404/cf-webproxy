import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const out = new URL("./dist/", import.meta.url);
await mkdir(out, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/pages/index.js", import.meta.url))],
  outfile: fileURLToPath(new URL("_worker.js", out)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:sockets"],
  sourcemap: false,
  legalComments: "none",
});
// Run Functions for EVERY path, including /?bridge=...; never fall through to a
// cached index.html for the authenticated Bridge. No source files are copied.
await writeFile(new URL("_routes.json", out), JSON.stringify({ version: 1, include: ["/*"], exclude: [] }));
await writeFile(new URL("index.html", out), "<!doctype html><meta charset=utf-8><title>Welcome</title><h1>Welcome</h1>\n");
console.log("Pages output: pages/dist (_worker.js, _routes.json, index.html)");
