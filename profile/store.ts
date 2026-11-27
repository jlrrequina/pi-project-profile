import { mkdirSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DETECTOR_VERSION, detectProject } from "../detect/index.ts";
import { fileStamp, sha1, withLockSync } from "../fs-utils.ts";
import type { DetectedProfile, ProfileConfig, StoredProfile, UserData } from "../types.ts";
import { migrateNotes } from "./memory.ts";

export function profilesDir(agentDir: string): string {
  return join(agentDir, "project-profile", "profiles");
}

export function profilePath(agentDir: string, root: string): string {
  return join(profilesDir(agentDir), `${sha1(root).slice(0, 16)}.json`);
}

/** Held while an automatic dream of the repository runs, so two π processes do not dream at once. */
export function dreamLockPath(agentDir: string, root: string): string {
  return join(profilesDir(agentDir), `${sha1(root).slice(0, 16)}.dream.lock`);
}

export function emptyUserData(): UserData {
  return { overrides: {}, notes: [], permissions: {} };
}

export function loadStored(agentDir: string, root: string): StoredProfile | undefined {
  try {
    const raw = readFileSync(profilePath(agentDir, root), "utf8");
    const parsed = JSON.parse(raw) as StoredProfile;
    if (!parsed || typeof parsed !== "object" || !parsed.detected) return undefined;
    parsed.user = { ...emptyUserData(), ...(parsed.user ?? {}) };
    parsed.user.notes = migrateNotes(parsed.user.notes);
    return parsed;
  } catch {
    return undefined;
  }
}

export function saveStored(agentDir: string, stored: StoredProfile): void {
  const p = profilePath(agentDir, stored.detected.root);
  mkdirSync(profilesDir(agentDir), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(stored, null, 2));
  renameSync(tmp, p);
}

/** True when any fingerprinted file changed (mtime/size) since detection. */
export function isStale(detected: DetectedProfile, root: string): boolean {
  if (detected.version !== DETECTOR_VERSION) return true;
  if (detected.root !== root) return true;
  for (const [rel, stamp] of Object.entries(detected.fingerprint)) {
    if (fileStamp(join(root, rel)) !== stamp) return true;
  }
  return false;
}

/**
 * Load the profile for a root, re-detecting when the cache is missing or stale.
 * User data (overrides, notes, permissions) always survives re-detection.
 */
export function loadOrDetect(agentDir: string, root: string, config: ProfileConfig, gitRoot: string | undefined, force = false): { stored: StoredProfile; refreshed: boolean } {
  const existing = loadStored(agentDir, root);
  if (existing && !force && !isStale(existing.detected, root)) {
    // A visit counts as use: pruning drops profiles (and their notes) not visited for a long time, not profiles that merely never changed.
    try {
      const now = new Date();
      utimesSync(profilePath(agentDir, root), now, now);
    } catch {
      /* read-only cache dir */
    }
    return { stored: existing, refreshed: false };
  }
  const detected = detectProject(root, config, gitRoot);
  const stored: StoredProfile = { detected, user: existing?.user ?? emptyUserData(), updatedAt: new Date().toISOString() };
  try {
    saveStored(agentDir, stored);
  } catch {
    // cache dir not writable: still usable in-memory
  }
  return { stored, refreshed: true };
}

/**
 * Change the user data of a profile. Another session on the same repository, or the automatic dream,
 * may have written since this one loaded the profile: the change starts from the file, under a lock,
 * so it never writes back an older copy of the notes.
 */
export function updateUser<T>(agentDir: string, stored: StoredProfile, mutate: (u: UserData) => T): T {
  return withLockSync(`${profilePath(agentDir, stored.detected.root)}.lock`, () => {
    const disk = loadStored(agentDir, stored.detected.root);
    if (disk) stored.user = disk.user;
    const result = mutate(stored.user);
    stored.updatedAt = new Date().toISOString();
    saveStored(agentDir, stored);
    return result;
  });
}
