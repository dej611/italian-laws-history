#!/usr/bin/env node
// Rebuild all OpenNorme static data artifacts.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function run(script) {
  console.log(`\n→ ${script}`);
  const r = spawnSync("node", [path.join(here, script)], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("copy-codemotion-data.mjs");
run("build-acts.mjs");
run("build-blame.mjs");
run("build-rag.mjs");
run("build-manifest.mjs");
console.log("\nrefresh complete");
