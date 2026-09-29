/**
 * Pre-existing failures. A check that was already failing before the agent's
 * change must not cost repair rounds for the part that was already broken.
 *
 * Each run of a project-wide check is reduced to a multiset of normalised
 * diagnostic keys (line/column numbers, durations and addresses removed; error
 * codes such as TS2322 or E0308 kept). The keys recorded before a prompt form
 * its baseline; afterwards only the keys whose count went up are "new".
 * Counting matters: a second instance of a known message in the same file is
 * new. Output without recognisable diagnostics falls back to a fingerprint of
 * its tail, so an unrecognised failure is new unless the output is identical.
 */
import { sep } from "node:path";
import { sha1 } from "../fs-utils.ts";
import { isDiagnosticLine, splitLines } from "./prune.ts";

export type DiagSet = Map<string, number>;

export interface DiagAnalysis {
  keys: DiagSet;
  /** Diagnostic line indices (into splitLines(text)) with their keys, in output order. */
  lines: Array<{ index: number; key: string }>;
}

const TAIL = "tail:";

/** Normalise one diagnostic line into a location- and timing-independent key. */
export function normalizeDiag(line: string, cwd?: string): string {
  let s = line;
  if (cwd) {
    for (const prefix of [cwd + sep, cwd.split(sep).join("/") + "/"]) s = s.split(prefix).join("");
  }
  s = s.replace(/0x[0-9a-f]+/gi, "0xN");
  // Keep code-like tokens (TS2322, E0308, F401, SA1019); every other digit run becomes N.
  s = s.replace(/\b[A-Z]{1,6}\d{1,6}\b|\d+/g, (m) => (/^[A-Z]/.test(m) ? m : "N"));
  return s.replace(/\s+/g, " ").trim();
}

export function analyzeDiagnostics(text: string, cwd?: string): DiagAnalysis {
  const all = splitLines(text);
  const keys: DiagSet = new Map();
  const lines: DiagAnalysis["lines"] = [];
  for (let i = 0; i < all.length; i++) {
    if (!isDiagnosticLine(all[i]!)) continue;
    const key = normalizeDiag(all[i]!, cwd);
    if (!key) continue;
    lines.push({ index: i, key });
    keys.set(key, (keys.get(key) ?? 0) + 1);
  }
  if (lines.length === 0) {
    const tail = all.filter((l) => l.trim() !== "").slice(-12).map((l) => normalizeDiag(l, cwd)).join("\n");
    if (tail) keys.set(TAIL + sha1(tail).slice(0, 16), 1);
  }
  return { keys, lines };
}

/**
 * Split a failing run into pre-existing and new diagnostics. The first
 * baseline-count occurrences of a key are pre-existing, the rest are new.
 */
export function splitByBaseline(analysis: DiagAnalysis, baseline: DiagSet): { preexisting: Set<number>; newKeys: DiagSet } {
  const preexisting = new Set<number>();
  const newKeys: DiagSet = new Map();
  if (analysis.lines.length === 0) {
    for (const [k, n] of analysis.keys) if (!baseline.has(k)) newKeys.set(k, n);
    return { preexisting, newKeys };
  }
  const remaining = new Map(baseline);
  for (const { index, key } of analysis.lines) {
    const left = remaining.get(key) ?? 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      preexisting.add(index);
    } else newKeys.set(key, (newKeys.get(key) ?? 0) + 1);
  }
  return { preexisting, newKeys };
}

export function diagCount(set: DiagSet): number {
  let n = 0;
  for (const v of set.values()) n += v;
  return n;
}
