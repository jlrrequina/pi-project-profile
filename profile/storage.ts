/**
 * Everything the extension stores, in one place, so it stays small and inspectable:
 *
 *   ~/.pi/agent/project-profile/config.json        settings
 *   ~/.pi/agent/project-profile/profiles/<h>.json   detected profile + user data (overrides, notes, permissions) per repository
 *   ~/.pi/agent/project-profile/history/<h>.jsonl   gate history per repository (bounded, see history.ts)
 *   ~/.pi/agent/project-profile/baselines/<h>.json  pre-existing-failure baseline per repository (bounded, 3-day life)
 *   $TMPDIR/pi-project-profile/*.log                full check output (24 h, 40 files, see verify/run.ts)
 *
 * `<h>` is the first 16 hex characters of sha1(project root), so the files of one repository share a
 * name. `/profile storage` reports sizes; pruning (session start and `/profile storage prune`) removes
 * what nothing can use any more: files of repositories whose root is gone (unless the profile holds
 * notes or overrides: an unmounted disk is not a deleted project), baselines past their life, history
 * and profiles not visited for 120 days, and leftovers of torn writes.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tildify } from "../fs-utils.ts";
import { configPath } from "../config.ts";
import { baselinePath, baselinesDir, BASELINE_MAX_AGE_MS } from "../verify/baseline-cache.ts";
import { historyDir, historyPath } from "./history.ts";
import { profilePath, profilesDir } from "./store.ts";

const DAY = 86_400_000;
export const PROFILE_MAX_AGE_MS = 120 * DAY;
const TMP_MAX_AGE_MS = 3_600_000;

export interface DirUsage {
  name: string;
  path: string;
  files: number;
  bytes: number;
}

export interface StorageReport {
  dirs: DirUsage[];
  /** This repository's files, with sizes (undefined = not present). */
  repo: Array<{ name: string; path: string; bytes?: number }>;
  totalBytes: number;
}

function usage(name: string, path: string): DirUsage {
  let files = 0;
  let bytes = 0;
  try {
    for (const f of readdirSync(path)) {
      try {
        const st = statSync(join(path, f));
        if (!st.isFile()) continue;
        files++;
        bytes += st.size;
      } catch {
        /* vanished */
      }
    }
  } catch {
    /* no dir */
  }
  return { name, path, files, bytes };
}

function sizeOf(p: string): number | undefined {
  try {
    return statSync(p).size;
  } catch {
    return undefined;
  }
}

export function storageReport(agentDir: string, root: string | undefined, logDir: string): StorageReport {
  const dirs = [usage("profiles", profilesDir(agentDir)), usage("history", historyDir(agentDir)), usage("baselines", baselinesDir(agentDir)), usage("logs", logDir)];
  const config = sizeOf(configPath(agentDir));
  const repo = root
    ? [
        { name: "profile", path: profilePath(agentDir, root), bytes: sizeOf(profilePath(agentDir, root)) },
        { name: "history", path: historyPath(agentDir, root), bytes: sizeOf(historyPath(agentDir, root)) },
        { name: "baseline", path: baselinePath(agentDir, root), bytes: sizeOf(baselinePath(agentDir, root)) },
      ]
    : [];
  return { dirs, repo, totalBytes: dirs.reduce((n, d) => n + d.bytes, 0) + (config ?? 0) };
}

export function formatSize(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function renderStorage(report: StorageReport, agentDir: string): string {
  const out: string[] = ["# project-profile storage", ""];
  out.push(`Total ${formatSize(report.totalBytes)} under ${tildify(join(agentDir, "project-profile"))} and the log directory. Nothing is written into any repository.`);
  out.push("");
  for (const d of report.dirs) out.push(`- ${d.name}: ${d.files} file${d.files === 1 ? "" : "s"}, ${formatSize(d.bytes)} — ${tildify(d.path)}`);
  out.push(`- config: ${tildify(configPath(agentDir))}${existsSync(configPath(agentDir)) ? "" : " (defaults; `/profile config` creates it)"}`);
  if (report.repo.length) {
    out.push("");
    out.push("## This repository");
    for (const r of report.repo) out.push(`- ${r.name}: ${r.bytes === undefined ? "none" : formatSize(r.bytes)} — ${tildify(r.path)}`);
  }
  out.push("");
  out.push("Pruning runs at session start and with `/profile storage prune`: files of repositories whose root is gone (profiles with notes or overrides are kept), baselines past their 3-day life, history and profiles not visited for 120 days, leftovers of interrupted writes. `/profile forget` drops this repository's profile, notes, history and baseline. Logs keep 24 hours / 40 files.");
  return out.join("\n");
}

/**
 * Remove what nothing can use any more. Best effort and cheap: one directory listing each, one
 * small JSON read per profile to learn its root. Returns the removed paths.
 */
export function pruneStorage(agentDir: string, now = Date.now()): string[] {
  const removed: string[] = [];
  const rm = (p: string) => {
    try {
      rmSync(p, { force: true });
      removed.push(p);
    } catch {
      /* ignore */
    }
  };
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).map((f) => join(dir, f));
    } catch {
      return [];
    }
  };
  const mtime = (p: string): number | undefined => {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return undefined;
    }
  };
  const live = new Set<string>(); // hashes of profiles that stay
  for (const p of list(profilesDir(agentDir))) {
    const m = mtime(p);
    if (m === undefined) continue;
    if (p.endsWith(".tmp")) {
      if (now - m > TMP_MAX_AGE_MS) rm(p);
      continue;
    }
    if (!p.endsWith(".json")) continue;
    if (now - m > PROFILE_MAX_AGE_MS) {
      rm(p);
      continue;
    }
    let root: unknown;
    let userData = true;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as { detected?: { root?: unknown }; user?: { notes?: unknown[]; overrides?: Record<string, unknown>; permissions?: Record<string, unknown>; verify?: unknown } };
      root = parsed.detected?.root;
      const u = parsed.user;
      userData = !!u && ((u.notes?.length ?? 0) > 0 || Object.keys(u.overrides ?? {}).length > 0 || Object.keys(u.permissions ?? {}).length > 0 || u.verify !== undefined);
    } catch {
      /* unreadable: keep, loadStored re-detects over it */
    }
    if (typeof root === "string" && !existsSync(root) && !userData) {
      rm(p);
      continue;
    }
    live.add(basename(p, ".json"));
  }
  for (const p of list(historyDir(agentDir))) {
    const m = mtime(p);
    if (m === undefined) continue;
    if (p.endsWith(".tmp")) {
      if (now - m > TMP_MAX_AGE_MS) rm(p);
      continue;
    }
    if (!p.endsWith(".jsonl")) continue;
    if (!live.has(basename(p, ".jsonl")) || now - m > PROFILE_MAX_AGE_MS) rm(p);
  }
  for (const p of list(baselinesDir(agentDir))) {
    const m = mtime(p);
    if (m === undefined) continue;
    if (p.endsWith(".tmp")) {
      if (now - m > TMP_MAX_AGE_MS) rm(p);
      continue;
    }
    if (!p.endsWith(".json")) continue;
    if (!live.has(basename(p, ".json")) || now - m > BASELINE_MAX_AGE_MS + DAY) rm(p);
  }
  return removed;
}

/** Drop every file of one repository (profile, history, baseline). */
export function forgetRepo(agentDir: string, root: string): string[] {
  const removed: string[] = [];
  for (const p of [profilePath(agentDir, root), historyPath(agentDir, root), baselinePath(agentDir, root)]) {
    if (!existsSync(p)) continue;
    try {
      rmSync(p, { force: true });
      removed.push(p);
    } catch {
      /* ignore */
    }
  }
  return removed;
}
