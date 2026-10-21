import { mkdir, writeFile, copyFile } from "node:fs/promises";

const out = new URL("./dist/", import.meta.url);
await mkdir(out, { recursive: true });
// Pages requires this deployed filename; the maintained source is page.js.
await copyFile(new URL("../page.js", import.meta.url), new URL("_worker.js", out));
await writeFile(new URL("_routes.json", out), JSON.stringify({ version: 1, include: ["/*"], exclude: [] }));
await writeFile(new URL("index.html", out), "<!doctype html><meta charset=utf-8><title>Welcome</title><h1>Welcome</h1>\n");
console.log("Pages ready: page.js → pages/dist/_worker.js");
