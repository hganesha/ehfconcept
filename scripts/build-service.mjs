import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const entries = {
  "control-api": "apps/control-api/src/server.ts",
  "capability-gateway": "apps/capability-gateway/src/server.ts",
  "case-api": "apps/case-api/src/server.ts",
  "runtime-host": "apps/runtime-host/src/server.ts",
  "runtime-worker": "apps/runtime-worker/src/worker.ts",
};

const service = process.argv[2];
const selected = service === "all" ? Object.keys(entries) : [service];
for (const name of selected) {
  const entry = entries[name];
  if (!entry) throw new Error(`build.service_invalid:${name ?? "missing"}`);
  const outputDirectory = resolve("dist/services", name);
  await mkdir(outputDirectory, { recursive: true });
  await build({
    entryPoints: [resolve(entry)],
    outfile: resolve(outputDirectory, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    banner: { js: "import { createRequire as __createRequire } from 'node:module';const require=__createRequire(import.meta.url);" },
  });
}
