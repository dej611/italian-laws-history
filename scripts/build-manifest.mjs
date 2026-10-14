#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { PUBLIC_DATA, PROGRESS_PATH, assertRepo } from "./repo-config.mjs";

assertRepo();
mkdirSync(PUBLIC_DATA, { recursive: true });

const progress = JSON.parse(readFileSync(PROGRESS_PATH, "utf8"));
const asOf =
  progress.lastFullyScannedDate ??
  (typeof progress.lastRun === "string" ? progress.lastRun.slice(0, 10) : null) ??
  new Date().toISOString().slice(0, 10);

const artifacts = [
  "data.json",
  "graph.json",
  "acts.json",
  "manifest.json",
  "blame/",
  "rag/index.json",
].filter((a) => {
  if (a.endsWith("/")) return existsSync(path.join(PUBLIC_DATA, a.replace(/\/$/, "")));
  return existsSync(path.join(PUBLIC_DATA, a));
});

const manifest = {
  asOf,
  generatedAt: new Date().toISOString(),
  artifacts,
};

writeFileSync(path.join(PUBLIC_DATA, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`manifest.json asOf=${asOf}`);
