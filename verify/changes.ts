/**
 * Which files did the agent change since the last verification?
 *
 * Two sources, unioned:
 *  1. write/edit tool calls (exact, cheap)
 *  2. a git working-tree snapshot diff (catches `sed -i`, scripts, custom edit
 *     tools, generated files)
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type Snapshot = Map<string, string>; // repo-relative path → "status|mtime:size"

export interface ChangeTracker {
  gitRoot?: string;
  tracked: Set<string>; // absolute paths from tools
  bashRan: boolean;
  snapshot?: Snapshot;
}

export function newTracker(gitRoot: string | undefined): ChangeTracker {
  return { gitRoot, tracked: new Set(), bashRan: false };
}

export function trackToolWrite(t: ChangeTracker, cwd: string, path: unknown): void {
  if (typeof path !== "string" || !path) return;
  t.tracked.add(isAbsolute(path) ? resolve(path) : resolve(cwd, path));
}

function gitStatus(gitRoot: string, signal?: AbortSignal): Promise<Snapshot | undefined> {
  return new Promise((resolvePromise) => {
    let out = "";
    let proc;
    try {
      proc = spawn("git", ["-c", "core.quotepath=off", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: gitRoot, stdio: ["ignore", "pipe", "ignore"], signal });
    } catch {
      resolvePromise(undefined);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      resolvePromise(undefined);
    }, 20_000);
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > 64 * 1024 * 1024) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolvePromise(undefined);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolvePromise(undefined);
        return;
      }
      const snap: Snapshot = new Map();
      const entries = out.split("\0").filter(Boolean);
      if (entries.length > 20_000) {
        // Absurdly dirty tree (unignored build output?) — snapshotting would be too slow to be useful.
        resolvePromise(undefined);
        return;
      }
      for (const e of entries) {
        const status = e.slice(0, 2);
        const rel = e.slice(3);
        if (!rel) continue;
        let stamp = "-";
        try {
          const st = statSync(join(gitRoot, rel));
          stamp = `${Math.floor(st.mtimeMs)}:${st.size}`;
        } catch {
          /* deleted */
        }
        snap.set(rel, `${status}|${stamp}`);
      }
      resolvePromise(snap);
    });
  });
}

/** Take the "before" snapshot at the start of an agent run. */
export async function snapshotStart(t: ChangeTracker): Promise<void> {
  t.tracked.clear();
  t.bashRan = false;
  t.snapshot = t.gitRoot ? await gitStatus(t.gitRoot) : undefined;
}

/** Compute changed files (absolute) since the snapshot; also refreshes the snapshot. */
export async function collectChanges(t: ChangeTracker): Promise<{ files: string[]; gitDetected: number; unknownChanges: boolean }> {
  const files = new Set<string>(t.tracked);
  let gitDetected = 0;
  let unknownChanges = false;
  if (t.gitRoot) {
    const now = await gitStatus(t.gitRoot);
    if (now && t.snapshot) {
      for (const [rel, v] of now) {
        if (t.snapshot.get(rel) !== v) {
          files.add(join(t.gitRoot, rel));
          gitDetected++;
        }
      }
      for (const rel of t.snapshot.keys()) {
        if (!now.has(rel)) {
          files.add(join(t.gitRoot, rel)); // reverted or deleted
          gitDetected++;
        }
      }
      t.snapshot = now;
    } else if (!now || !t.snapshot) {
      // git unavailable/too slow: rely on tool tracking; if bash ran we cannot be sure
      unknownChanges = t.bashRan;
      if (now) t.snapshot = now;
    }
  } else {
    unknownChanges = t.bashRan;
  }
  t.tracked.clear();
  t.bashRan = false;
  return { files: Array.from(files).sort(), gitDetected, unknownChanges };
}

/** Repo-relative display path. */
export function displayPath(base: string, file: string): string {
  const r = relative(base, file);
  return r.startsWith("..") ? file : r.split(sep).join("/");
}
