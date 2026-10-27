// Shared configuration for OpenNorme data scripts.
// Override with LAWS_REPO. Defaults to this checkout: progress-rs.json at the
// root, law texts on the history branch. Codemotion builders are borrowed
// under scripts/codemotion.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXPLORE_DIR = path.resolve(here, "..");
export const PUBLIC_DATA = path.join(EXPLORE_DIR, "public", "data");
export const CACHE_DIR = path.join(EXPLORE_DIR, "cache");

function gitToplevel(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return EXPLORE_DIR;
  }
}

export const LAWS_REPO = path.resolve(process.env.LAWS_REPO ?? gitToplevel(EXPLORE_DIR));

export const HISTORY_BRANCH = process.env.LAWS_BRANCH ?? "history";
export const PROGRESS_PATH = path.join(LAWS_REPO, "progress-rs.json");

export function assertRepo() {
  if (!existsSync(PROGRESS_PATH)) {
    throw new Error(
      `Cannot find ${PROGRESS_PATH}.\n` +
        `Set LAWS_REPO to the italian-laws-history checkout (currently: ${LAWS_REPO}).`,
    );
  }
}

export function git(args, { maxBuffer = 1024 * 1024 * 512 } = {}) {
  return execFileSync("git", ["-C", LAWS_REPO, ...args], {
    encoding: "utf8",
    maxBuffer,
  });
}

/** Tip file on the history branch: one commit subject per line, oldest first.
 *  A naming commit adds a tab and the act `.txt`. The history tip is enough. */
export const COMMIT_INDEX = "commit-index.tsv";

export function commitIndex() {
  return git(["show", `${HISTORY_BRANCH}:${COMMIT_INDEX}`])
    .split("\n")
    .filter(Boolean);
}

export function subjectOf(line) {
  const tab = line.indexOf("\t");
  return tab < 0 ? line : line.slice(0, tab);
}

export function processingLogs(root = LAWS_REPO) {
  const LOG_RE = /^processing-(\d{4}-\d{2}-\d{2})-rs\.log$/;
  return readdirSync(root)
    .map((name) => {
      const m = name.match(LOG_RE);
      return m ? { name, day: m[1], path: path.join(root, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.day.localeCompare(b.day));
}
