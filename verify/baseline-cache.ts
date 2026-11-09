/**
 * The pre-existing-failure baseline across sessions.
 *
 * Within a session, the diagnostics of the last full run of each project-wide check are the
 * baseline for the next prompt (index.ts `lastDiag`). This module keeps that map between sessions
 * under ~/.pi/agent/project-profile/baselines/, keyed by a fingerprint of the tree state the
 * diagnostics describe: git HEAD, every dirty or untracked file with its content stamp, the
 * detected manifests, and the installed-dependency markers. A session that starts on a tree with
 * the same fingerprint begins with the baseline at once, so the first prompt knows what already
 * failed without a background run, and without the race of a run that finishes after the first write.
 *
 * A stale baseline would be worse than none (an old failure hidden as "known", or a fixed one
 * blamed on the agent), so the fingerprint invalidates on any of its inputs, no entry outlives
 * BASELINE_MAX_AGE_MS, and repositories without git, or with an unreadable status, are not cached.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileStamp, sha1 } from "../fs-utils.ts";
import type { Snapshot } from "./changes.ts";
import type { DiagSet } from "./baseline.ts";

export const BASELINE_MAX_AGE_MS = 3 * 86_400_000;
/** A check with more distinct diagnostics than this is not cached (the file would not stay small). */
const MAX_KEYS_PER_CHECK = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Files below a project directory whose stamp changes when dependencies are installed or updated. */
const INSTALL_MARKERS = ["node_modules", "node_modules/.package-lock.json", "node_modules/.modules.yaml", "node_modules/.yarn-integrity", "node_modules/.pnpm/lock.yaml", ".venv", "venv", "vendor", "Pods", ".dart_tool/package_config.json"];

export interface BaselineEntry {
  label: string;
  cwd: string;
  /** [normalised diagnostic key, count] */
  diag: Array<[string, number]>;
}

export interface BaselineCache {
  fingerprint: string;
  at: string;
  /** checkKey (`id@cwd`) → entry */
  checks: Record<string, BaselineEntry>;
}

export function baselinesDir(agentDir: string): string {
  return join(agentDir, "project-profile", "baselines");
}

export function baselinePath(agentDir: string, root: string): string {
  return join(baselinesDir(agentDir), `${sha1(root).slice(0, 16)}.json`);
}

/** `git rev-parse HEAD` in `gitRoot`, or undefined (no commits, no git, timeout). */
export function gitHead(gitRoot: string, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let proc;
    try {
      proc = spawn("git", ["rev-parse", "HEAD"], { cwd: gitRoot, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolve(undefined);
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const sha = out.trim();
      resolve(code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined);
    });
  });
}

export interface FingerprintInput {
  head: string | undefined;
  /** Dirty and untracked files with their content stamps (verify/changes.ts); undefined when git status failed. */
  snapshot: Snapshot | undefined;
  /** The detected profile's manifest stamps. */
  manifests: Record<string, string>;
  /** Project directories whose installed dependencies the checks depend on. */
  dirs: string[];
}

/**
 * The tree state as one hash, or undefined when it cannot be known (no HEAD, no status): then
 * nothing is cached. Stamps are "mtime:size", so a reinstall, a checkout or any edit changes it.
 */
export function treeFingerprint(input: FingerprintInput): string | undefined {
  if (!input.head || !input.snapshot) return undefined;
  const parts: string[] = [`head=${input.head}`];
  for (const [rel, stamp] of Array.from(input.snapshot.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))) parts.push(`dirty=${rel}|${stamp.slice(stamp.indexOf("|") + 1)}`);
  for (const [rel, stamp] of Object.entries(input.manifests).sort()) parts.push(`manifest=${rel}|${stamp}`);
  for (const dir of Array.from(new Set(input.dirs)).sort()) for (const m of INSTALL_MARKERS) parts.push(`install=${dir}/${m}|${fileStamp(join(dir, m))}`);
  return sha1(parts.join("\n"));
}

export function saveBaseline(agentDir: string, root: string, fingerprint: string, diags: Map<string, { label: string; cwd: string; diag: DiagSet }>, now = new Date()): boolean {
  const checks: Record<string, BaselineEntry> = {};
  for (const [key, v] of diags) {
    if (v.diag.size > MAX_KEYS_PER_CHECK) continue;
    checks[key] = { label: v.label, cwd: v.cwd, diag: Array.from(v.diag.entries()) };
  }
  if (Object.keys(checks).length === 0) return false;
  const body = JSON.stringify({ fingerprint, at: now.toISOString(), checks } satisfies BaselineCache);
  if (body.length > MAX_FILE_BYTES) return false;
  try {
    mkdirSync(baselinesDir(agentDir), { recursive: true });
    const p = baselinePath(agentDir, root);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The cached baseline when it describes exactly this tree and is young enough; otherwise undefined.
 * `fingerprintFor` receives the cached checks' directories (their install markers are part of the hash).
 */
export function loadBaseline(agentDir: string, root: string, fingerprintFor: (dirs: string[]) => string | undefined, now = Date.now()): { at: string; checks: Map<string, { label: string; cwd: string; diag: DiagSet }> } | undefined {
  const p = baselinePath(agentDir, root);
  if (!existsSync(p)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as BaselineCache;
    if (!parsed || typeof parsed !== "object" || typeof parsed.fingerprint !== "string" || !parsed.checks) return undefined;
    const age = now - Date.parse(parsed.at);
    if (!(age >= 0 && age <= BASELINE_MAX_AGE_MS)) return undefined;
    const dirs = Object.values(parsed.checks).map((e) => e.cwd);
    if (fingerprintFor(dirs) !== parsed.fingerprint) return undefined;
    const checks = new Map<string, { label: string; cwd: string; diag: DiagSet }>();
    for (const [key, e] of Object.entries(parsed.checks)) checks.set(key, { label: e.label, cwd: e.cwd, diag: new Map(e.diag) });
    return { at: parsed.at, checks };
  } catch {
    return undefined;
  }
}
