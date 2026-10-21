import "./bundle.mjs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";

const out = new URL("./dist/", import.meta.url);
await mkdir(out, { recursive: true });
await copyFile(new URL("./_worker.js", import.meta.url), new URL("_worker.js", out));
// Every path must reach Functions, including the authenticated Bridge.
await writeFile(new URL("_routes.json", out), JSON.stringify({ version: 1, include: ["/*"], exclude: [] }));
await writeFile(new URL("index.html", out), "<!doctype html><meta charset=utf-8><title>Welcome</title><h1>Welcome</h1>\n");
console.log("Pages output: pages/dist (_worker.js, _routes.json, index.html)");
