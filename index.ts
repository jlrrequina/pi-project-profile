/**
 * project-profile — a global, project-agnostic Pi extension.
 *
 *  v1  Profile: detect stack / commands / conventions / instruction files for the
 *      current project at session start, cache it under ~/.pi/agent/project-profile
 *      (never inside the repo) and inject a static <project_profile> section into
 *      the system prompt. `/profile` inspects and corrects it.
 *
 *  v2  Verify: when the agent finishes a run that changed files, run the project's
 *      own read-only checks (typecheck/lint) automatically, tests/builds only after
 *      a one-time per-repo confirmation, never installs or migrations. Red results
 *      are pruned and sent back to the agent for a bounded number of repair rounds;
 *      environment failures go to the user instead. `/verify` and the `run_checks`
 *      tool run the same machinery on demand.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { basename, isAbsolute, join } from "node:path";
import { agentDir, configPath, loadConfig, writeDefaultConfig } from "./config.ts";
import { findProjectRoot } from "./detect/index.ts";
import { realpath, tildify, uniq } from "./fs-utils.ts";
import { availability, effectiveChecks, renderPromptSection, renderReport, tierAllowed } from "./profile/render.ts";
import { deleteStored, loadOrDetect, profilePath, pruneProfiles, updateUser } from "./profile/store.ts";
import type { GateVerdict, ProfileConfig, StoredProfile, Tier } from "./types.ts";
import { collectChanges, displayPath, newTracker, peekChanges, snapshotStart, toolPath, type ChangeTracker } from "./verify/changes.ts";
import { describeRuns, runGate, type GateHooks } from "./verify/gate.ts";
import { buildPlan, TIER_ORDER, type PlannedCheck } from "./verify/plan.ts";
import { logDir, pruneLogs } from "./verify/run.ts";
import { appendFileSync } from "node:fs";

const VERIFY_MSG = "project-profile/verify";
const DEBUG = !!process.env.PI_PROJECT_PROFILE_DEBUG;
function debug(event: string, data: Record<string, unknown> = {}): void {
  if (!DEBUG) return;
  try {
    appendFileSync(join(logDir(), "debug.jsonl"), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n");
  } catch {
    /* ignore */
  }
}
const REPORT_ENTRY = "project-profile/report";
const STATUS_KEY = "verify";

interface PromptState {
  seq: number;
  repairRound: number;
  pendingRepair: boolean;
  finalized: boolean;
  lastSignature?: string;
  mustRun: PlannedCheck[];
}

interface SessionState {
  config: ProfileConfig;
  root: string;
  gitRoot?: string;
  stored?: StoredProfile;
  profiles: Map<string, StoredProfile>;
  tracker: ChangeTracker;
  /** Files written by tools during the current turn (verify.perTurn). */
  turnFiles: Set<string>;
  /** A shell tool ran during the current turn: files may have changed outside tool tracking. */
  turnBash: boolean;
  broken: Map<string, string>;
  notifiedBroken: Set<string>;
  askedThisSession: Set<Tier>;
  prompt: PromptState;
  gateRunning: boolean;
  abort: AbortController;
  renderedSection?: string;
  renderedKey?: string;
  lastVerdict?: string;
  supersededIds: Set<string>;
  mode: string;
  hasUI: boolean;
}

export default function projectProfile(pi: ExtensionAPI) {
  let s: SessionState | undefined;

  // ------------------------------------------------------------------ helpers
  const dir = agentDir();

  function verifyEnabled(): boolean {
    if (!s) return false;
    if (s.stored?.user.verify !== undefined) return s.stored.user.verify;
    if (!s.config.verify.enabled) return false;
    if (!s.hasUI && !s.config.verify.headless) return false;
    return true;
  }

  function profileFor(root: string): StoredProfile | undefined {
    if (!s) return undefined;
    if (root === s.root) return s.stored;
    const cached = s.profiles.get(root);
    if (cached) return cached;
    try {
      const { stored } = loadOrDetect(dir, root, s.config, s.gitRoot);
      s.profiles.set(root, stored);
      return stored;
    } catch {
      return undefined;
    }
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined) {
    try {
      ctx.ui.setStatus(STATUS_KEY, text);
    } catch {
      /* no UI */
    }
  }

  function notify(ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") {
    try {
      ctx.ui.notify(msg, type);
    } catch {
      /* no UI */
    }
  }

  function makeHooks(ctx: ExtensionContext, signal: AbortSignal, opts: { interactive: boolean }): GateHooks {
    return {
      broken: s!.broken,
      signal,
      progress: (t) => setStatus(ctx, `⏳ ${t}`),
      permission: async (tier, planned) => {
        const st = s!;
        const stored = st.stored;
        if (!stored) return "skip";
        const cur = tierAllowed(tier, stored, st.config);
        if (cur !== "ask") return cur;
        if (!ctx.hasUI || !opts.interactive) return "skip";
        if (st.askedThisSession.has(tier)) return "skip";
        const cmds = uniq(planned.map((p) => p.check.cmd.replace(" <files>", "")));
        const name = stored.detected.name ?? basename(st.root);
        setStatus(ctx, `? ${tier} permission`);
        const label = tier === "test" ? "tests" : "builds";
        let choice: string | undefined;
        try {
          choice = await ctx.ui.select(`project-profile: run ${label} in ${name} after the agent's changes?`, [`Yes, always for this repo — ${cmds.join(" · ")}`, "Not now (ask again next session)", `Never for this repo`], { timeout: 90_000 });
        } catch {
          choice = undefined;
        }
        if (choice?.startsWith("Yes")) {
          updateUser(dir, stored, (u) => {
            u.permissions[tier === "test" ? "tests" : "build"] = "allow";
          });
          invalidateSection();
          return "allow";
        }
        if (choice?.startsWith("Never")) {
          updateUser(dir, stored, (u) => {
            u.permissions[tier === "test" ? "tests" : "build"] = "deny";
          });
          invalidateSection();
          return "deny";
        }
        st.askedThisSession.add(tier);
        return "skip";
      },
    };
  }

  function invalidateSection() {
    if (s) {
      s.renderedSection = undefined;
      s.renderedKey = undefined;
    }
  }

  function reportEnvFailures(ctx: ExtensionContext, verdict: GateVerdict) {
    for (const r of verdict.runs) {
      if (r.status !== "env") continue;
      const key = r.check.id + "@" + r.check.cwd;
      if (s!.notifiedBroken.has(key)) continue;
      s!.notifiedBroken.add(key);
      notify(ctx, `verify: ${r.check.label} (\`${r.check.cmd.replace(" <files>", "")}\`) disabled this session — ${r.reason}${r.logPath ? ` · log: ${tildify(r.logPath)}` : ""}`, "warning");
    }
  }

  function failureMessage(verdict: GateVerdict, round: number, max: number): string {
    const st = s!;
    const failing = verdict.runs.filter((r) => r.status === "fail");
    const passed = verdict.runs.filter((r) => r.status === "pass").map((r) => r.check.label);
    const lines: string[] = [];
    for (const r of failing) {
      const where = r.check.cwd === st.root ? "" : ` (in ${displayPath(st.root, r.check.cwd)})`;
      lines.push(`[verification] ✗ ${r.check.label} — \`${r.check.cmd.replace(" <files>", "")}\` exited ${r.exitCode ?? "?"} in ${(r.durationMs / 1000).toFixed(1)}s${where} — repair round ${round} of ${max}`);
      lines.push("```");
      lines.push(...r.summary);
      lines.push("```");
      const shown = r.summary.length;
      if (r.totalLines > shown) lines.push(`(${r.totalLines - shown} more lines${r.logPath ? `; full log: ${r.logPath}` : ""})`);
      else if (r.logPath) lines.push(`(full log: ${r.logPath})`);
    }
    if (passed.length) lines.push(`Passed: ${uniq(passed).join(", ")}.`);
    const changed = verdict.changedFiles.map((f) => displayPath(st.root, f));
    if (changed.length) lines.push(`Files changed this run: ${changed.slice(0, 12).join(", ")}${changed.length > 12 ? ` (+${changed.length - 12})` : ""}.`);
    lines.push("");
    lines.push("Fix the underlying cause in the code, then end your turn; verification re-runs automatically. Do not skip, disable, or loosen the check, do not add ignore/suppress comments to silence it, and do not claim success while it fails. If the failure is pre-existing and unrelated to your change, say so explicitly and stop.");
    return lines.join("\n");
  }

  function giveUpMessage(verdict: GateVerdict, reason: string, summarize: boolean): string {
    const failing = verdict.runs.filter((r) => r.status === "fail").map((r) => `${r.check.label} (\`${r.check.cmd.replace(" <files>", "")}\`)`);
    const head = `[verification] automatic repair stopped: ${reason}. Still failing: ${failing.join(", ")}.`;
    if (!summarize) return `${head} The user has been notified. Do not claim the task is complete.`;
    return `${head}\nDo not make further code changes now. Reply with a short summary for the user: what is failing, what you tried, your best hypothesis, and what you recommend next. Do not claim the task is complete.`;
  }

  /** Replace earlier failure / per-turn messages from this prompt with a one-liner to save context. */
  function supersedeDrafts(ctx: ExtensionContext, kinds: string[] = ["failure", "perturn"]): SessionBoundaryDraft[] {
    const st = s!;
    const drafts: SessionBoundaryDraft[] = [];
    try {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== "custom_message" || entry.customType !== VERIFY_MSG) continue;
        const det = entry.details as { seq?: number; kind?: string } | undefined;
        if (det?.seq !== st.prompt.seq || !kinds.includes(det.kind ?? "")) continue;
        if (st.supersededIds.has(entry.id)) continue;
        st.supersededIds.add(entry.id);
        drafts.push({ type: "context_edit", targetId: entry.id, replacement: { content: [{ type: "text", text: "[verification] an earlier check failure in this task was superseded by a later verification run." }] } });
      }
    } catch {
      /* ignore */
    }
    return drafts;
  }

  async function buildGatePlan(files: string[], opts: { unscoped: boolean; mustRun?: PlannedCheck[] }) {
    const st = s!;
    return buildPlan(files, {
      projectRoot: st.root,
      gitRoot: st.gitRoot,
      ignoreDirs: st.config.ignoreDirs,
      profileFor,
      checksFor: (stored) => effectiveChecks(stored),
      mustRun: opts.mustRun,
      unscoped: opts.unscoped,
    });
  }

  function verdictLine(v: GateVerdict): string {
    const icon = v.status === "green" ? "✓" : v.status === "red" ? "✗" : v.status === "env" ? "⚠" : "–";
    return `${icon} ${describeRuns(v.runs)}`;
  }

  /** Short footer text: "✓ typecheck·test 1.5s" / "✗ lint" / "⚠ typecheck unavailable". */
  function statusText(v: GateVerdict): string {
    const labels = (status: string) => uniq(v.runs.filter((r) => r.status === status && r.check.tier !== "syntax").map((r) => r.check.label));
    const secs = `${(v.durationMs / 1000).toFixed(1)}s`;
    if (v.status === "red") return `✗ ${labels("fail").join("·")}`;
    if (v.status === "green") return `✓ ${labels("pass").join("·") || "syntax"} ${secs}`;
    if (v.status === "env") return `⚠ ${labels("env").join("·")} unavailable`;
    return "– nothing to verify";
  }

  // ------------------------------------------------------------------ renderers
  pi.registerMessageRenderer(VERIFY_MSG, (message, { expanded, outputPad }, theme) => {
    const details = message.details as { kind?: string; headline?: string } | undefined;
    const kind = details?.kind ?? "info";
    const color = kind === "failure" ? "error" : kind === "giveup" || kind === "perturn" ? "warning" : "success";
    const head = `${theme.fg(color, "[verify]")} ${details?.headline ?? ""}`;
    const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(head, 0, 0));
    if (expanded) {
      const body = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
    } else box.addChild(new Text(theme.fg("dim", "  (ctrl+o to expand)"), 0, 0));
    return box;
  });

  pi.registerEntryRenderer<{ markdown: string }>(REPORT_ENTRY, (entry, { expanded }, theme) => {
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    const md = entry.data?.markdown ?? "";
    box.addChild(new Markdown(expanded ? md : md.split("\n").slice(0, 14).join("\n") + (md.split("\n").length > 14 ? "\n\n_(ctrl+o to expand)_" : ""), 0, 0, getMarkdownTheme()));
    return box;
  });

  function showReport(markdown: string) {
    pi.appendEntry(REPORT_ENTRY, { markdown });
  }

  // ------------------------------------------------------------------ session lifecycle
  pi.on("session_start", async (_event, ctx) => {
    const { config, issues } = loadConfig(dir);
    const { root, gitRoot } = findProjectRoot(ctx.cwd);
    s = {
      config,
      root,
      gitRoot,
      profiles: new Map(),
      tracker: newTracker(gitRoot),
      turnFiles: new Set(),
      turnBash: false,
      broken: new Map(),
      notifiedBroken: new Set(),
      askedThisSession: new Set(),
      prompt: { seq: 0, repairRound: 0, pendingRepair: false, finalized: false, mustRun: [] },
      gateRunning: false,
      abort: new AbortController(),
      supersededIds: new Set(),
      mode: ctx.mode,
      hasUI: ctx.hasUI,
    };
    for (const i of issues) notify(ctx, `project-profile config: ${i}`, "warning");
    try {
      const { stored, refreshed } = loadOrDetect(dir, root, config, gitRoot);
      s.stored = stored;
      debug("session_start", { cwd: ctx.cwd, root, gitRoot, refreshed, mode: ctx.mode, hasUI: ctx.hasUI, checks: effectiveChecks(stored).map((c) => `${c.tier}:${c.cmd}`) });
      const checks = effectiveChecks(stored);
      const auto = checks.filter((c) => (c.tier === "fast" || c.tier === "lint") && !availability(c)).length;
      const langs = stored.detected.languages.slice(0, 3).join("/") || "unknown stack";
      const trusted = ctx.isProjectTrusted();
      setStatus(ctx, !trusted ? `${langs} · verify off (untrusted project)` : verifyEnabled() ? `${langs} · ${auto} auto-check${auto === 1 ? "" : "s"}` : `${langs} · verify off`);
      if (refreshed && ctx.hasUI && ctx.mode === "tui") {
        const cmds = Object.entries(stored.detected.commands)
          .filter(([k]) => ["typecheck", "lint", "test", "build"].includes(k))
          .map(([k, v]) => `${k} \`${v.cmd}\``);
        notify(ctx, `project-profile: ${stored.detected.name ?? basename(root)} — ${langs}${cmds.length ? " · " + cmds.join(" · ") : ""} (/profile for details)`, "info");
      }
    } catch (err) {
      notify(ctx, `project-profile: detection failed — ${(err as Error).message}`, "warning");
    }
    pruneLogs();
    pruneProfiles(dir);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    s?.abort.abort();
    setStatus(ctx, undefined);
  });

  // ------------------------------------------------------------------ prompt injection + per-prompt reset
  pi.on("before_agent_start", async (event, ctx) => {
    if (!s) return;
    // new user prompt → new repair budget
    s.prompt = { seq: s.prompt.seq + 1, repairRound: 0, pendingRepair: false, finalized: false, mustRun: [] };
    s.turnFiles.clear();
    s.turnBash = false;
    if (verifyEnabled()) await snapshotStart(s.tracker);
    if (!s.config.profile.inject || !s.stored) return;
    const loaded = (event.systemPromptOptions.contextFiles ?? []).map((f) => f.path);
    const key = `${s.stored.updatedAt}|${verifyEnabled()}|${loaded.join(",")}`;
    if (s.renderedKey !== key || !s.renderedSection) {
      s.renderedSection = renderPromptSection(s.stored, s.config, { verifyEnabled: verifyEnabled(), piLoadedContextFiles: loaded });
      s.renderedKey = key;
    }
    event.systemPromptOptions.sections["project_profile"] = s.renderedSection;
    void ctx;
  });

  // ------------------------------------------------------------------ change tracking
  pi.on("tool_result", async (event, ctx) => {
    if (!s) return;
    const st = s;
    const name = event.toolName;
    const track = (path: unknown) => {
      const p = toolPath(ctx.cwd, path);
      if (!p) return;
      st.tracker.tracked.add(p);
      st.turnFiles.add(p);
    };
    if (name === "write" || name === "edit") {
      if (!event.isError) track(event.input.path);
      return;
    }
    const shell = () => {
      st.tracker.bashRan = true;
      st.turnBash = true;
    };
    if (name === "bash" || name === "powershell" || name === "hypa_shell" || name === "interactive_shell") shell();
    else if (/edit|write|patch|apply|replace|insert|move|rename|delete|create/i.test(name) && !/read|grep|find|search|list|ls|describe|status/i.test(name)) {
      // third-party mutation tools (hashline editors etc.): path arg if present, else assume unknown changes
      if (typeof event.input.path === "string") track(event.input.path);
      else if (typeof event.input.file === "string") track(event.input.file);
      else shell();
    }
  });

  // ------------------------------------------------------------------ the gate
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!s || !s.stored || !verifyEnabled()) return;
    if (event.outcome !== "completed") return;
    if (s.gateRunning) return;
    if (!ctx.isProjectTrusted()) return;
    const st = s;
    st.gateRunning = true;
    try {
      const { files, unknownChanges, gitDetected } = await collectChanges(st.tracker);
      debug("settle", { seq: st.prompt.seq, round: st.prompt.repairRound, files, gitDetected, unknownChanges, pendingRepair: st.prompt.pendingRepair, finalized: st.prompt.finalized });
      if (files.length === 0 && !unknownChanges) {
        if (st.prompt.pendingRepair && !st.prompt.finalized) {
          // The agent ended its turn without changing anything: no progress.
          st.prompt.pendingRepair = false;
          st.prompt.finalized = true;
          setStatus(ctx, "✗ unresolved");
          notify(ctx, "verify: agent made no changes after the last failure — stopping automatic repair", "warning");
          return { entries: [...event.entries, { type: "custom_message", customType: VERIFY_MSG, content: "[verification] the previous check failure is still unresolved and no files were changed in the last turn; automatic repair stopped. Do not claim the task is complete.", display: true, details: { seq: st.prompt.seq, kind: "giveup", headline: "no changes since last failure — stopped" } }] };
        }
        return;
      }
      const plan = await buildGatePlan(files, { unscoped: unknownChanges && files.length === 0, mustRun: st.prompt.mustRun });
      const total = TIER_ORDER.reduce((n, t) => n + (plan.byTier.get(t)?.length ?? 0), 0);
      if (total === 0) return;
      const hooks = makeHooks(ctx, st.abort.signal, { interactive: true });
      setStatus(ctx, "⏳ verifying…");
      const verdict = await runGate(plan, st.config, hooks);
      st.lastVerdict = verdictLine(verdict);
      debug("verdict", { seq: st.prompt.seq, status: verdict.status, ms: verdict.durationMs, runs: verdict.runs.map((r) => ({ id: r.check.id, status: r.status, code: r.exitCode, ms: r.durationMs, reason: r.reason, lines: r.summary.length })) });
      reportEnvFailures(ctx, verdict);
      const max = st.config.verify.maxRepairRounds;
      if (verdict.status === "green") {
        setStatus(ctx, statusText(verdict));
        const drafts = supersedeDrafts(ctx);
        if (st.prompt.pendingRepair) {
          notify(ctx, `verify: checks pass after ${st.prompt.repairRound} repair round${st.prompt.repairRound === 1 ? "" : "s"} (${describeRuns(verdict.runs)})`, "info");
          drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: `[verification] ✓ all checks pass now: ${describeRuns(verdict.runs)}.`, display: true, details: { seq: st.prompt.seq, kind: "pass", headline: `passed — ${describeRuns(verdict.runs)}` } });
        }
        st.prompt.pendingRepair = false;
        st.prompt.mustRun = [];
        // Boundary results replace the draft chain: always carry earlier handlers' entries.
        return drafts.length ? { entries: [...event.entries, ...drafts] } : undefined;
      }
      if (verdict.status === "red") {
        const failingPlanned: PlannedCheck[] = [];
        for (const t of TIER_ORDER) for (const p of plan.byTier.get(t) ?? []) if (verdict.runs.some((r) => r.status === "fail" && r.check.id === p.check.id && r.check.cwd === p.check.cwd)) failingPlanned.push(p);
        const failingLabels = uniq(verdict.runs.filter((r) => r.status === "fail").map((r) => r.check.label)).join(", ");
        setStatus(ctx, `✗ ${failingLabels}`);
        if (st.prompt.finalized) {
          notify(ctx, `verify: still failing (${failingLabels}); automatic repair already stopped for this prompt`, "warning");
          return;
        }
        const drafts = supersedeDrafts(ctx);
        const round = st.prompt.repairRound + 1;
        let stopReason: string | undefined;
        if (round > max) stopReason = `${max} repair rounds exhausted`;
        else if (st.prompt.lastSignature && st.prompt.lastSignature === verdict.signature) stopReason = "the same failure repeated with no progress";
        if (stopReason) {
          debug("giveup", { seq: st.prompt.seq, stopReason });
          st.prompt.finalized = true;
          st.prompt.pendingRepair = false;
          st.prompt.mustRun = [];
          notify(ctx, `verify: ${stopReason} — ${failingLabels} still failing; see the transcript`, "warning");
          const summarize = st.config.verify.summarizeOnGiveUp;
          drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: giveUpMessage(verdict, stopReason, summarize), display: true, details: { seq: st.prompt.seq, kind: "giveup", headline: `stopped — ${stopReason} (${failingLabels})` } });
          return { entries: [...event.entries, ...drafts], continue: summarize };
        }
        st.prompt.repairRound = round;
        st.prompt.lastSignature = verdict.signature;
        st.prompt.pendingRepair = true;
        st.prompt.mustRun = failingPlanned;
        debug("repair", { seq: st.prompt.seq, round, failing: failingLabels });
        notify(ctx, `verify: ${failingLabels} failed — sending the agent back (round ${round}/${max})`, "info");
        drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: failureMessage(verdict, round, max), display: true, details: { seq: st.prompt.seq, kind: "failure", headline: `${failingLabels} failed — round ${round}/${max}` } });
        return { entries: [...event.entries, ...drafts], continue: true };
      }
      // env / skipped
      setStatus(ctx, verdict.status === "env" ? "⚠ checks unavailable" : "– nothing to verify");
      return;
    } catch (err) {
      notify(ctx, `verify: internal error — ${(err as Error).message}`, "error");
      return;
    } finally {
      st.gateRunning = false;
    }
  });

  // ------------------------------------------------------------------ optional per-turn fast check
  function perTurnMessage(verdict: GateVerdict): string {
    const st = s!;
    const lines: string[] = [];
    for (const r of verdict.runs.filter((x) => x.status === "fail")) {
      const where = r.check.cwd === st.root ? "" : ` (in ${displayPath(st.root, r.check.cwd)})`;
      lines.push(`[verification] fast check after this turn: ✗ ${r.check.label} — \`${r.check.cmd.replace(" <files>", "")}\` exited ${r.exitCode ?? "?"}${where}`);
      lines.push("```");
      lines.push(...r.summary.slice(0, Math.max(8, Math.floor(st.config.verify.maxOutputLines / 2))));
      lines.push("```");
      if (r.totalLines > r.summary.length && r.logPath) lines.push(`(full log: ${r.logPath})`);
    }
    lines.push("Informational: you are mid-task, so failures from work still in progress are expected. Address them as you continue; the full verification runs when you finish and will send a repair request if anything still fails.");
    return lines.join("\n");
  }

  pi.on("turn_end", async (event, ctx) => {
    if (!s || !s.stored || !s.config.verify.perTurn || !verifyEnabled()) return;
    const st = s;
    const files = new Set(st.turnFiles);
    const bash = st.turnBash;
    st.turnFiles.clear();
    st.turnBash = false;
    if (event.outcome !== "completed" || st.gateRunning || !ctx.isProjectTrusted()) return;
    if (files.size === 0 && !bash) return;
    st.gateRunning = true;
    try {
      // Shell tools may have edited files: peek at git (everything changed since the prompt started) without moving the settle snapshot.
      if (bash) for (const f of (await peekChanges(st.tracker)) ?? []) files.add(f);
      if (files.size === 0) return;
      const plan = await buildGatePlan(Array.from(files).sort(), { unscoped: false });
      for (const t of TIER_ORDER) if (t !== "syntax" && t !== "fast") plan.byTier.set(t, []);
      if ((plan.byTier.get("syntax")?.length ?? 0) + (plan.byTier.get("fast")?.length ?? 0) === 0) return;
      const hooks = makeHooks(ctx, st.abort.signal, { interactive: false });
      setStatus(ctx, "⏳ fast check…");
      const verdict = await runGate(plan, st.config, hooks);
      debug("perturn", { seq: st.prompt.seq, turn: event.turnIndex, files: Array.from(files).sort(), bash, status: verdict.status, ms: verdict.durationMs, runs: verdict.runs.map((r) => ({ id: r.check.id, status: r.status, code: r.exitCode })) });
      reportEnvFailures(ctx, verdict);
      if (verdict.status !== "red") {
        setStatus(ctx, statusText(verdict));
        return;
      }
      const failingLabels = uniq(verdict.runs.filter((r) => r.status === "fail").map((r) => r.check.label)).join(", ");
      setStatus(ctx, `✗ ${failingLabels} (mid-task)`);
      const drafts = supersedeDrafts(ctx, ["perturn"]);
      drafts.push({ type: "custom_message", customType: VERIFY_MSG, content: perTurnMessage(verdict), display: true, details: { seq: st.prompt.seq, kind: "perturn", headline: `${failingLabels} failing after this turn (fast check, informational)` } });
      // Never `continue` here: the agent is still working and gets the note with its next model request.
      return { entries: [...event.entries, ...drafts] };
    } catch (err) {
      notify(ctx, `verify: per-turn check error — ${(err as Error).message}`, "warning");
      return;
    } finally {
      st.gateRunning = false;
    }
  });

  // ------------------------------------------------------------------ manual verification (command + tool)
  async function manualVerify(ctx: ExtensionContext, opts: { tiers?: Tier[]; files?: string[]; interactive: boolean }): Promise<GateVerdict | undefined> {
    if (!s || !s.stored) return undefined;
    const st = s;
    if (st.gateRunning) {
      notify(ctx, "verify: a verification run is already in progress", "warning");
      return undefined;
    }
    st.gateRunning = true;
    try {
      const files = (opts.files ?? []).map((f) => (isAbsolute(f) ? f : join(ctx.cwd, f))).map(realpath);
      const plan = await buildGatePlan(files, { unscoped: files.length === 0 });
      if (opts.tiers) for (const t of TIER_ORDER) if (!opts.tiers.includes(t)) plan.byTier.set(t, []);
      const hooks = makeHooks(ctx, st.abort.signal, { interactive: opts.interactive });
      hooks.stopOnRed = false;
      setStatus(ctx, "⏳ verifying…");
      const verdict = await runGate(plan, st.config, hooks);
      st.lastVerdict = verdictLine(verdict);
      reportEnvFailures(ctx, verdict);
      setStatus(ctx, statusText(verdict));
      return verdict;
    } finally {
      st.gateRunning = false;
    }
  }

  function verdictReport(verdict: GateVerdict): string {
    const out: string[] = [];
    for (const r of verdict.runs) {
      const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : r.status === "env" ? "⚠" : "–";
      out.push(`${icon} **${r.check.label}** \`${r.check.cmd.replace(" <files>", "")}\` — ${r.status}${r.reason ? ` (${r.reason})` : ""} · ${(r.durationMs / 1000).toFixed(1)}s${r.check.cwd !== s!.root ? ` · ${displayPath(s!.root, r.check.cwd)}` : ""}`);
      if (r.summary.length) out.push("```\n" + r.summary.join("\n") + "\n```" + (r.logPath ? `\n(full log: ${r.logPath})` : ""));
    }
    if (verdict.runs.length === 0) out.push("(no applicable checks)");
    return out.join("\n");
  }

  pi.registerCommand("verify", {
    description: "Run the project's checks now: /verify [fast|lint|test|build|all] [file…]",
    getArgumentCompletions: (prefix) => ["fast", "lint", "test", "build", "all", "cancel"].filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      if (!s) return;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "cancel") {
        s.abort.abort();
        s.abort = new AbortController();
        notify(ctx, "verify: cancelled", "info");
        return;
      }
      let tiers: Tier[] | undefined;
      if (parts[0] && ["fast", "lint", "test", "build"].includes(parts[0])) tiers = ["syntax", parts.shift() as Tier];
      else if (parts[0] === "all") {
        parts.shift();
        tiers = undefined;
      } else if (!parts[0]) tiers = ["syntax", "fast", "lint"];
      const files = parts;
      const verdict = await manualVerify(ctx, { tiers, files, interactive: true });
      if (!verdict) return;
      const md = `## /verify — ${verdict.status} (${(verdict.durationMs / 1000).toFixed(1)}s)\n\n${verdictReport(verdict)}`;
      showReport(md);
      if (verdict.status === "red") {
        // make the failure visible to the model on its next turn without triggering one
        pi.sendMessage({ customType: VERIFY_MSG, content: `[verification] manual /verify found failures:\n${verdictReport(verdict)}`, display: false, details: { seq: -1, kind: "failure", headline: "manual /verify failed" } }, { triggerTurn: false });
      }
    },
  });

  pi.registerTool({
    name: "run_checks",
    label: "Run project checks",
    description: "Run this project's own verification checks (typecheck/lint automatically; tests/build only if the user has allowed them for this repo). Returns pruned diagnostics. Use it after substantial changes instead of guessing commands.",
    promptSnippet: "Run the project's typecheck/lint/tests and get pruned diagnostics",
    promptGuidelines: ["Prefer run_checks over ad-hoc test/lint commands when you want to verify your changes; it knows the project's tooling."],
    parameters: Type.Object({
      tier: Type.Optional(Type.Union([Type.Literal("fast"), Type.Literal("lint"), Type.Literal("test"), Type.Literal("build"), Type.Literal("all")], { description: "Which tier to run. Default: fast+lint. 'all' includes tests/build when permitted." })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Limit per-file checks to these paths (relative to cwd). Omit to run project-wide." })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const tiers: Tier[] | undefined = params.tier === "all" ? undefined : params.tier ? ["syntax", params.tier] : ["syntax", "fast", "lint"];
      const verdict = await manualVerify(ctx, { tiers, files: params.files, interactive: true });
      if (!verdict) return { content: [{ type: "text", text: "verification unavailable (no profile or a run is already in progress)" }], details: undefined };
      const text = `verification: ${verdict.status} (${(verdict.durationMs / 1000).toFixed(1)}s)\n${verdictReport(verdict).replace(/\*\*/g, "")}`;
      return { content: [{ type: "text", text }], details: { status: verdict.status, runs: verdict.runs.map((r) => ({ id: r.check.id, status: r.status, exitCode: r.exitCode, durationMs: r.durationMs })) } };
    },
  });

  // ------------------------------------------------------------------ /profile
  const SUBS = ["show", "refresh", "set", "note", "notes", "tests", "build", "verify", "forget", "config", "path", "help"];
  pi.registerCommand("profile", {
    description: "Project profile: /profile [show|refresh|set <key> <cmd|->|note <text>|notes clear|tests allow|deny|ask|build allow|deny|ask|verify on|off|forget|config|path]",
    getArgumentCompletions: (prefix) => SUBS.filter((x) => x.startsWith(prefix)).map((x) => ({ value: x, label: x })),
    handler: async (args, ctx) => {
      if (!s) return;
      const st = s;
      const [sub = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const restStr = args.trim().slice(args.trim().indexOf(sub) + sub.length).trim();
      const requireStored = () => {
        if (!st.stored) {
          notify(ctx, "project-profile: no profile for this directory", "warning");
          return undefined;
        }
        return st.stored;
      };
      switch (sub) {
        case "show": {
          const stored = requireStored();
          if (!stored) return;
          showReport(renderReport(stored, st.config, { verifyEnabled: verifyEnabled(), cachePath: profilePath(dir, st.root), brokenChecks: st.broken, lastVerdict: st.lastVerdict }));
          return;
        }
        case "refresh": {
          const { stored } = loadOrDetect(dir, st.root, st.config, st.gitRoot, true);
          st.stored = stored;
          st.profiles.clear();
          st.broken.clear();
          st.notifiedBroken.clear();
          invalidateSection();
          notify(ctx, `project-profile: re-detected (${stored.detected.languages.join("/") || "unknown"}, ${effectiveChecks(stored).length} checks)`, "info");
          showReport(renderReport(stored, st.config, { verifyEnabled: verifyEnabled(), cachePath: profilePath(dir, st.root), brokenChecks: st.broken }));
          return;
        }
        case "set": {
          const stored = requireStored();
          if (!stored) return;
          const key = rest[0];
          const cmd = restStr.slice(key?.length ?? 0).trim();
          if (!key || !cmd) {
            notify(ctx, "usage: /profile set <typecheck|lint|format|test|build|dev|…> <command>   (use - to disable)", "warning");
            return;
          }
          updateUser(dir, stored, (u) => {
            if (cmd === "-") u.overrides[key] = null;
            else u.overrides[key] = cmd;
          });
          invalidateSection();
          notify(ctx, cmd === "-" ? `project-profile: ${key} disabled for this repo` : `project-profile: ${key} = \`${cmd}\` (runs via sh -c from ${tildify(st.root)})`, "info");
          return;
        }
        case "note": {
          const stored = requireStored();
          if (!stored) return;
          if (!restStr) {
            notify(ctx, "usage: /profile note <text>", "warning");
            return;
          }
          updateUser(dir, stored, (u) => {
            u.notes.push(restStr);
          });
          invalidateSection();
          notify(ctx, `project-profile: note saved (${stored.user.notes.length} total)`, "info");
          return;
        }
        case "notes": {
          const stored = requireStored();
          if (!stored) return;
          if (rest[0] === "clear") {
            updateUser(dir, stored, (u) => {
              u.notes = [];
            });
            invalidateSection();
            notify(ctx, "project-profile: notes cleared", "info");
          } else notify(ctx, stored.user.notes.length ? stored.user.notes.map((n, i) => `${i + 1}. ${n}`).join("\n") : "no notes", "info");
          return;
        }
        case "tests":
        case "build": {
          const stored = requireStored();
          if (!stored) return;
          const v = rest[0];
          if (!v || !["allow", "deny", "ask"].includes(v)) {
            notify(ctx, `usage: /profile ${sub} allow|deny|ask`, "warning");
            return;
          }
          updateUser(dir, stored, (u) => {
            if (v === "ask") delete u.permissions[sub];
            else u.permissions[sub] = v as "allow" | "deny";
          });
          st.askedThisSession.delete(sub === "tests" ? "test" : "build");
          invalidateSection();
          notify(ctx, `project-profile: ${sub} → ${v}`, "info");
          return;
        }
        case "verify": {
          const stored = requireStored();
          if (!stored) return;
          const v = rest[0];
          if (!v || !["on", "off", "default"].includes(v)) {
            notify(ctx, `verify is ${verifyEnabled() ? "on" : "off"} — usage: /profile verify on|off|default`, "info");
            return;
          }
          updateUser(dir, stored, (u) => {
            if (v === "default") delete u.verify;
            else u.verify = v === "on";
          });
          invalidateSection();
          notify(ctx, `project-profile: verify ${v} for this repo`, "info");
          return;
        }
        case "forget": {
          const ok = deleteStored(dir, st.root);
          st.stored = undefined;
          const { stored } = loadOrDetect(dir, st.root, st.config, st.gitRoot, true);
          st.stored = stored;
          invalidateSection();
          notify(ctx, ok ? "project-profile: cache and user data removed; re-detected fresh" : "project-profile: nothing cached; re-detected", "info");
          return;
        }
        case "config": {
          const p = configPath(dir);
          try {
            const { issues } = loadConfig(dir);
            const exists = (await import("node:fs")).existsSync(p);
            const created = exists ? p : writeDefaultConfig(dir);
            notify(ctx, `${exists ? "config" : "created default config"}: ${tildify(created)}${issues.length ? ` — issues: ${issues.join("; ")}` : ""}`, "info");
          } catch (err) {
            notify(ctx, `project-profile: ${(err as Error).message}`, "error");
          }
          return;
        }
        case "path": {
          notify(ctx, `root ${tildify(st.root)}${st.gitRoot ? ` · git ${tildify(st.gitRoot)}` : ""} · cache ${tildify(profilePath(dir, st.root))} · config ${tildify(configPath(dir))}`, "info");
          return;
        }
        default:
          notify(ctx, "usage: /profile [show|refresh|set <key> <cmd|->|note <text>|notes clear|tests allow|deny|ask|build allow|deny|ask|verify on|off|forget|config|path]", "info");
      }
    },
  });
}
