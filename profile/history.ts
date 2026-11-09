/**
 * Gate history: a compact per-repository log of what verification observed. It is the
 * "transcript" the sleep phase replays: `/profile history` summarises it for the user and
 * `/profile dream` hands the summary to the agent. One JSON line per event; dates, check labels,
 * repair rounds, environment reasons, review kinds and note ids only, never code or check output.
 * The file is bounded and pruned with the profile.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha1, tildify } from "../fs-utils.ts";

export type HistoryEvent = { t: string; s: string } & (
  | { kind: "verdict"; seq: number; status: "green" | "red" | "env" | "skipped"; round: number; failed: string[]; known: number; ms: number; hints?: string[] }
  | { kind: "giveup"; seq: number; reason: string; failed: string[] }
  | { kind: "env"; seq: number; reason: string; checks: string[] }
  | { kind: "findings"; seq: number; kinds: string[]; cont: boolean }
  | { kind: "baseline"; dir: string; failed: Array<{ label: string; count: number }> }
  | { kind: "note"; action: "add" | "remove"; by: "user" | "agent"; id: string; text: string }
  | { kind: "dream" }
);
export type HistoryInput = HistoryEvent extends infer E ? (E extends { t: string; s: string } ? Omit<E, "t" | "s"> : never) : never;

/** Bytes after which the file is rewritten with its newest lines only (down to half this size). */
export const HISTORY_MAX_BYTES = 256 * 1024;

export function historyDir(agentDir: string): string {
  return join(agentDir, "project-profile", "history");
}

export function historyPath(agentDir: string, root: string): string {
  return join(historyDir(agentDir), `${sha1(root).slice(0, 16)}.jsonl`);
}

/** Append one event. Best effort: an unwritable state directory must never stop the gate. */
export function appendHistory(agentDir: string, root: string, session: string, ev: HistoryInput, now = new Date()): void {
  try {
    const p = historyPath(agentDir, root);
    mkdirSync(historyDir(agentDir), { recursive: true });
    appendFileSync(p, JSON.stringify({ t: now.toISOString(), s: session, ...ev }) + "\n");
    if (statSync(p).size > HISTORY_MAX_BYTES) {
      const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
      const keep: string[] = [];
      let bytes = 0;
      for (let i = lines.length - 1; i >= 0 && bytes + lines[i]!.length + 1 <= HISTORY_MAX_BYTES / 2; i--) {
        keep.unshift(lines[i]!);
        bytes += lines[i]!.length + 1;
      }
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, keep.join("\n") + "\n");
      renameSync(tmp, p);
    }
  } catch {
    /* ignore */
  }
}

export function readHistory(agentDir: string, root: string): HistoryEvent[] {
  const p = historyPath(agentDir, root);
  if (!existsSync(p)) return [];
  const out: HistoryEvent[] = [];
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as HistoryEvent;
        if (e && typeof e === "object" && typeof e.t === "string" && typeof e.kind === "string") out.push(e);
      } catch {
        /* a torn line */
      }
    }
  } catch {
    /* unreadable */
  }
  return out;
}

export interface TaskSummary {
  /** `${session}:${seq}` */
  key: string;
  date: string;
  /** Labels that failed on the first verification of the task (new failures attributed to the agent). */
  firstFailed: string[];
  /** Repair rounds the agent needed (verdicts after the first). */
  rounds: number;
  final: "green" | "red" | "env" | "skipped";
  gaveUp?: string;
  hints: string[];
}

export interface HistorySummary {
  days: number;
  events: number;
  tasks: TaskSummary[];
  /** Label → tasks where it failed on the first attempt. */
  firstFailures: Map<string, number>;
  /** Label → auto-fix hints shown with it. */
  hintsByLabel: Map<string, Map<string, number>>;
  /** Environment reason → distinct sessions it occurred in. */
  env: Map<string, Set<string>>;
  findings: Map<string, number>;
  /** Pre-existing failures on the untouched tree, last seen per check label. */
  baseline: Map<string, { count: number; date: string }>;
  notes: { added: number; addedByAgent: number; removed: number };
  dreams: number;
  patterns: string[];
}

/** Reduce the log to what a reviewer wants to know. Only events within `days` count. */
export function summarizeHistory(events: HistoryEvent[], opts: { days?: number; now?: number } = {}): HistorySummary {
  const days = opts.days ?? 30;
  const cutoff = (opts.now ?? Date.now()) - days * 86_400_000;
  const recent = events.filter((e) => Date.parse(e.t) >= cutoff);
  const tasks = new Map<string, TaskSummary>();
  const firstFailures = new Map<string, number>();
  const hintsByLabel = new Map<string, Map<string, number>>();
  const env = new Map<string, Set<string>>();
  const findings = new Map<string, number>();
  const baseline = new Map<string, { count: number; date: string }>();
  const notes = { added: 0, addedByAgent: 0, removed: 0 };
  let dreams = 0;
  const task = (e: HistoryEvent & { seq: number }) => {
    const key = `${e.s}:${e.seq}`;
    let t = tasks.get(key);
    if (!t) {
      t = { key, date: e.t.slice(0, 10), firstFailed: [], rounds: 0, final: "skipped", hints: [] };
      tasks.set(key, t);
    }
    return t;
  };
  for (const e of recent) {
    switch (e.kind) {
      case "verdict": {
        const t = task(e);
        if (e.round === 0) {
          t.firstFailed = e.failed;
          for (const l of e.failed) firstFailures.set(l, (firstFailures.get(l) ?? 0) + 1);
          for (const l of e.failed) for (const h of e.hints ?? []) {
            const m = hintsByLabel.get(l) ?? new Map<string, number>();
            m.set(h, (m.get(h) ?? 0) + 1);
            hintsByLabel.set(l, m);
          }
        } else t.rounds = Math.max(t.rounds, e.round);
        t.final = e.status;
        for (const h of e.hints ?? []) if (!t.hints.includes(h)) t.hints.push(h);
        break;
      }
      case "giveup": {
        const t = task(e);
        t.gaveUp = e.reason;
        t.final = "red";
        break;
      }
      case "env": {
        const set = env.get(e.reason) ?? new Set<string>();
        set.add(e.s);
        env.set(e.reason, set);
        break;
      }
      case "findings":
        for (const k of e.kinds) findings.set(k, (findings.get(k) ?? 0) + 1);
        break;
      case "baseline":
        for (const f of e.failed) baseline.set(f.label, { count: f.count, date: e.t.slice(0, 10) });
        break;
      case "note":
        if (e.action === "add") {
          notes.added++;
          if (e.by === "agent") notes.addedByAgent++;
        } else notes.removed++;
        break;
      case "dream":
        dreams++;
        break;
    }
  }
  const list = Array.from(tasks.values());
  const patterns: string[] = [];
  for (const [label, n] of Array.from(firstFailures.entries()).sort((a, b) => b[1] - a[1])) {
    if (n >= 3 && n * 10 >= list.length * 3) {
      const hint = Array.from(hintsByLabel.get(label)?.entries() ?? []).sort((a, b) => b[1] - a[1])[0];
      patterns.push(`${label} failed on the first attempt in ${n} of ${list.length} tasks${hint ? ` (auto-fix shown: \`${hint[0]}\`)` : ""} — a project fact may be missing from the profile: a note, or a check the agent should run before it finishes`);
    }
  }
  for (const [reason, sessions] of env) if (sessions.size >= 2) patterns.push(`"${reason}" disabled checks in ${sessions.size} sessions — \`/profile doctor\` names the fix; until then nothing verifies those checks`);
  const gaveUp = list.filter((t) => t.gaveUp).length;
  if (gaveUp >= 2) patterns.push(`automatic repair stopped unresolved in ${gaveUp} tasks — read those failures: a pre-existing problem the baseline missed, or a check the agent cannot satisfy`);
  return { days, events: recent.length, tasks: list, firstFailures, hintsByLabel, env, findings, baseline, notes, dreams, patterns };
}

const FINDING_NAMES: Record<string, string> = { secret: "possible secret", "env-file": "unignored .env", lockfile: "stale lockfile", focus: "focused test", suppression: "check suppression", skip: "skipped test", stub: "stub", loosen: "loosened check config", "deleted-test": "deleted test file", "removed-tests": "removed test cases" };

/** Markdown for `/profile history`. */
export function renderHistory(name: string, sum: HistorySummary, file: { path: string; bytes: number; events: number }): string {
  const out: string[] = [`# Verification history: ${name} (last ${sum.days} days)`, ""];
  if (sum.tasks.length === 0 && sum.events === 0) {
    out.push("Nothing recorded yet. The gate records each verified task here (dates, checks, rounds — no code or output).");
  } else {
    const first = sum.tasks.filter((t) => t.firstFailed.length === 0 && t.final !== "skipped").length;
    const repaired = sum.tasks.filter((t) => t.rounds > 0);
    const avg = repaired.length ? (repaired.reduce((n, t) => n + t.rounds, 0) / repaired.length).toFixed(1) : "0";
    const unresolved = sum.tasks.filter((t) => t.gaveUp).length;
    out.push(`- ${sum.tasks.length} task${sum.tasks.length === 1 ? "" : "s"} verified · ${first} green on the first attempt · ${repaired.length} repaired (avg ${avg} round${avg === "1.0" ? "" : "s"}) · ${unresolved} stopped unresolved`);
    if (sum.firstFailures.size) {
      const parts = Array.from(sum.firstFailures.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([l, n]) => {
          const hint = Array.from(sum.hintsByLabel.get(l)?.entries() ?? []).sort((a, b) => b[1] - a[1])[0];
          return `${l} ${n}${hint ? ` (auto-fix shown ${hint[1]}×: \`${hint[0]}\`)` : ""}`;
        });
      out.push(`- First-attempt failures by check: ${parts.join(" · ")}`);
    }
    if (sum.env.size) out.push(`- Environment: ${Array.from(sum.env.entries()).map(([r, s]) => `${r} (${s.size} session${s.size === 1 ? "" : "s"})`).join(" · ")}`);
    if (sum.findings.size) out.push(`- Review findings: ${Array.from(sum.findings.entries()).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${FINDING_NAMES[k] ?? k} ${n}`).join(" · ")}`);
    if (sum.baseline.size) out.push(`- Pre-existing on the untouched tree: ${Array.from(sum.baseline.entries()).map(([l, b]) => `${l} ${b.count} diagnostic${b.count === 1 ? "" : "s"} (last seen ${b.date})`).join(" · ")}`);
    if (sum.notes.added || sum.notes.removed) out.push(`- Notes: ${sum.notes.added} added (${sum.notes.addedByAgent} by the agent) · ${sum.notes.removed} removed${sum.dreams ? ` · ${sum.dreams} dream${sum.dreams === 1 ? "" : "s"}` : ""}`);
    if (sum.patterns.length) {
      out.push("");
      out.push("## Patterns");
      for (const p of sum.patterns) out.push(`- ${p}`);
    }
    const recent = sum.tasks.slice(-8).reverse();
    if (recent.length) {
      out.push("");
      out.push("## Recent tasks");
      for (const t of recent) out.push(`- ${t.date}: ${describeTask(t)}`);
    }
  }
  out.push("");
  out.push(`File: ${tildify(file.path)} (${file.bytes >= 1024 ? `${Math.round(file.bytes / 1024)} KB` : `${file.bytes} B`}, ${file.events} event${file.events === 1 ? "" : "s"}) · \`/profile dream\` asks the agent to consolidate the notes against this history · \`/profile storage\` shows all state`);
  return out.join("\n");
}

export function describeTask(t: TaskSummary): string {
  if (t.firstFailed.length === 0) return t.final === "green" ? "✓ green on the first attempt" : t.final === "env" ? "⚠ checks unavailable" : t.final === "skipped" ? "– nothing to verify" : "✗ red";
  const head = `✗ ${t.firstFailed.join(", ")}`;
  if (t.gaveUp) return `${head} → stopped: ${t.gaveUp}`;
  if (t.final === "green") return `${head} → fixed in ${t.rounds} round${t.rounds === 1 ? "" : "s"}`;
  return `${head} → still ${t.final} after ${t.rounds} round${t.rounds === 1 ? "" : "s"}`;
}

/** Compact lines for the dream message: what recurred, what the environment lacked, what already fails. */
export function historyForDream(sum: HistorySummary): string[] {
  const out: string[] = [];
  if (sum.tasks.length) out.push(`${sum.tasks.length} tasks verified in the last ${sum.days} days; first-attempt failures: ${sum.firstFailures.size ? Array.from(sum.firstFailures.entries()).map(([l, n]) => `${l} ×${n}`).join(", ") : "none"}`);
  for (const p of sum.patterns) out.push(p);
  if (sum.baseline.size) out.push(`already failing on the untouched tree (not the agent's work): ${Array.from(sum.baseline.entries()).map(([l, b]) => `${l} (${b.count}, ${b.date})`).join(", ")}`);
  const recent = sum.tasks.filter((t) => t.firstFailed.length).slice(-5);
  if (recent.length) out.push(`recent failed tasks: ${recent.map((t) => `${t.date} ${describeTask(t)}`).join("; ")}`);
  return out;
}
