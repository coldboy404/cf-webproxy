import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Regenerate deployment files from the maintained sources. No local imports
// remain; cloudflare:sockets is provided by the Cloudflare runtime itself.
for (const [entry, output] of [
  ["../src/index.js", "../worker.js"],
  ["../src/pages/index.js", "./_worker.js"],
]) {
  await build({
    absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    outfile: fileURLToPath(new URL(output, import.meta.url)),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:sockets"],
    sourcemap: false,
    legalComments: "none",
    banner: { js: "// cf-webproxy | MIT | Generated deployment file; edit src/ and run npm run bundle.\n// Configure PROXY_SECRET; optional RELAY_TRANSPORT=kws. Never put secrets in this file." },
  });
  console.log(`Single-file output: ${output}`);
}
