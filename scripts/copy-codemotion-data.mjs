#!/usr/bin/env node
// Rebuild data.json + graph.json with the builders borrowed from
// codemotion-milan (scripts/codemotion), then copy them into public/data.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PUBLIC_DATA, LAWS_REPO } from "./repo-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const borrowed = path.join(here, "codemotion");

function run(script) {
  const r = spawnSync(process.execPath, [path.join(borrowed, script)], {
    cwd: borrowed,
    env: { ...process.env, LAWS_REPO },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`${script} failed`);
}

mkdirSync(PUBLIC_DATA, { recursive: true });
run("build-data.mjs");
run("build-graph.mjs");
copyFileSync(path.join(borrowed, "data.json"), path.join(PUBLIC_DATA, "data.json"));
copyFileSync(path.join(borrowed, "graph.json"), path.join(PUBLIC_DATA, "graph.json"));
console.log("Copied data.json + graph.json → public/data/");
