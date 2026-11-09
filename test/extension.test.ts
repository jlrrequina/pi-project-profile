/**
 * Integration tests of the π wiring (index.ts): the real extension driven
 * through π's event sequence with a mock ExtensionAPI and context.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { profilePath } from "../profile/store.ts";
import { historyPath } from "../profile/history.ts";

type Handler = (event: any, ctx: any) => any;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pp-ext-"));
}
function write(root: string, rel: string, content: string) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Load the extension against a mock π API with its own agent dir (no ~/.pi pollution); pass one to continue "the next session". */
async function load(agent = tmp()) {
  process.env.PI_CODING_AGENT_DIR = agent;
  const mod = await import("../index.ts");
  const handlers: Record<string, Handler[]> = {};
  const tools: string[] = [];
  const impl: Record<string, { annotations?: Record<string, boolean>; outputSchema?: unknown; execute: (...a: any[]) => Promise<{ content: Array<{ text: string }>; structuredContent?: unknown; isError?: boolean }> }> = {};
  const commands: string[] = [];
  const commandImpl: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const sent: Array<{ content: string; details?: any }> = [];
  const reports: string[] = [];
  mod.default({
    on: (event: string, h: Handler) => {
      (handlers[event] ??= []).push(h);
      return () => {};
    },
    registerTool: (t: { name: string; execute: (...a: any[]) => any }) => {
      tools.push(t.name);
      impl[t.name] = t;
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.push(name);
      commandImpl[name] = options;
    },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    appendEntry: (_type: string, data: { markdown: string }) => reports.push(data.markdown),
    sendMessage: (m: { content: string; details?: any }) => sent.push(m),
  } as any);
  const notes: Array<[string, string]> = [];
  const statuses: string[] = [];
  const ctxFor = (cwd: string) => ({
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify: (m: string, t: string) => notes.push([t, m]), setStatus: (_k: string, t?: string) => statuses.push(t ?? ""), select: async () => undefined },
    sessionManager: { getBranch: () => [] },
  });
  /** Fire an event through every handler, composing tool_result content like π does. */
  const emit = async (name: string, event: any, ctx: any) => {
    let last: any;
    for (const h of handlers[name] ?? []) {
      const r = await h(event, ctx);
      if (name === "tool_result" && r?.content) event.content = r.content;
      if (r !== undefined) last = r;
    }
    return last;
  };
  const cleanup = () => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(agent, { recursive: true, force: true });
  };
  const runChecksResult = async (ctx: any, params: Record<string, unknown> = {}) => impl["run_checks"]!.execute("id", params, undefined, undefined, ctx);
  const runChecks = async (ctx: any, params: Record<string, unknown> = {}) => (await runChecksResult(ctx, params)).content.map((c) => c.text).join("\n");
  const command = (line: string, ctx: any) => {
    const [name, ...rest] = line.replace(/^\//, "").split(" ");
    return commandImpl[name!]!.handler(rest.join(" "), ctx);
  };
  return { handlers, tools, commands, notes, statuses, sent, reports, impl, agent, ctxFor, emit, cleanup, runChecks, runChecksResult, command };
}

/** Wait until `pred` holds (background baseline runs finish on their own schedule). */
async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const prompt = () => ({ systemPromptOptions: { sections: {} as Record<string, string>, contextFiles: [] } });
const settle = () => ({ outcome: "completed", entries: [] as unknown[], continue: false });
const text = (r: any) => (r?.entries ?? []).map((e: any) => (typeof e.content === "string" ? e.content : "")).join("\n");

test("registration: run_checks and the two note tools, /profile and /verify, every lifecycle hook", async () => {
  const x = await load();
  assert.deepEqual(x.tools, ["run_checks", "remember", "forget_note"]);
  assert.deepEqual(x.commands.sort(), ["profile", "verify"]);
  for (const e of ["session_start", "session_shutdown", "before_agent_start", "tool_call", "tool_result", "agent_before_settle", "turn_end", "session_compact"]) assert.ok(x.handlers[e]?.length, e);
  x.cleanup();
});

test("prompt section is injected and identical across prompts", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
  write(root, "package-lock.json", "{}");
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  const a = prompt();
  const b = prompt();
  await x.emit("before_agent_start", a, ctx);
  await x.emit("before_agent_start", b, ctx);
  const section = a.systemPromptOptions.sections["project_profile"] ?? "";
  assert.ok(section.includes("- Project: ") && section.includes("test `npm test`"), section);
  assert.equal(a.systemPromptOptions.sections["project_profile"], b.systemPromptOptions.sections["project_profile"]);
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("a session started in the home directory gets no profile: nothing injected, nothing cached", async () => {
  const x = await load();
  const fakeHome = tmp();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  try {
    write(fakeHome, "package.json", "{}");
    mkdirSync(join(fakeHome, "Documents/private"), { recursive: true });
    const ctx = x.ctxFor(fakeHome);
    await x.emit("session_start", {}, ctx);
    const p = prompt();
    await x.emit("before_agent_start", p, ctx);
    assert.equal(p.systemPromptOptions.sections["project_profile"], undefined);
    assert.ok(!existsSync(join(process.env.PI_CODING_AGENT_DIR!, "project-profile", "profiles")) || readdirSync(join(process.env.PI_CODING_AGENT_DIR!, "project-profile", "profiles")).length === 0, "no profile written for ~");
    assert.equal(await x.emit("agent_before_settle", settle(), ctx), undefined);
  } finally {
    process.env.HOME = prev.HOME;
    if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prev.USERPROFILE;
    x.cleanup();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("scoped instructions reach the tool result once per session", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo" }));
  write(root, "packages/api/AGENTS.md", "Document every exported function.");
  write(root, "packages/api/index.ts", "export const x = 1;\n");
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  const read = () => ({ toolName: "read", input: { path: "packages/api/index.ts" }, content: [{ type: "text", text: "export const x = 1;" }], isError: false });
  const first = read();
  await x.emit("tool_result", first, ctx);
  const injected = first.content.map((c: any) => c.text).join("\n");
  assert.ok(injected.includes("### packages/api/AGENTS.md") && injected.includes("Document every exported function."));
  const second = read();
  await x.emit("tool_result", second, ctx);
  assert.equal(second.content.length, 1, "delivered only once per session");
  await x.emit("session_compact", {}, ctx);
  const third = read();
  await x.emit("tool_result", third, ctx);
  assert.ok(third.content.map((c: any) => c.text).join("\n").includes("Document every exported function."), "delivered again after compaction dropped it");
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("gate: a failing check sends the agent back; on the next prompt the same failure is pre-existing", async () => {
  const x = await load();
  const root = tmp();
  const failing = `node -e "console.error('src/old.ts(1,14): error TS2322: Type string is not assignable to type number.'); process.exit(2)"`;
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck: failing } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  const edit = async (content: string) => {
    const event = { toolName: "write", input: { path: "src/a.ts", content }, content: [{ type: "text", text: "ok" }], isError: false };
    await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
    write(root, "src/a.ts", content);
    await x.emit("tool_result", event, ctx);
  };
  // prompt 1: no baseline yet → the failure is sent back for a repair round
  await x.emit("before_agent_start", prompt(), ctx);
  await edit("export const a = 1;\n");
  const first = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(first?.continue, true);
  assert.ok(text(first).includes("TS2322") && text(first).includes("repair round 1"));
  // prompt 2: the identical diagnostic was recorded before it → pre-existing, no repair round
  await x.emit("before_agent_start", prompt(), ctx);
  await edit("export const a = 2;\n");
  const second = await x.emit("agent_before_settle", settle(), ctx);
  assert.notEqual(second?.continue, true);
  assert.ok(text(second).includes("no new failures") && text(second).includes("typecheck (1 known)"));
  assert.ok(x.notes.some(([, m]) => m.includes("existed before this task")));
  // both verdicts are in the repository's gate history: labels, rounds and counts, never output
  const history = readFileSync(historyPath(x.agent, realpathSync(root)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const verdicts = history.filter((e) => e.kind === "verdict");
  assert.deepEqual(verdicts.map((e) => [e.seq, e.status, e.round, e.failed, e.known]), [[1, "red", 0, ["typecheck"], 0], [2, "green", 0, [], 1]]);
  assert.ok(history.every((e) => !JSON.stringify(e).includes("TS2322")), "history holds no diagnostics");
  assert.ok(history.every((e) => e.s === history[0].s && /^\d{4}-\d{2}-\d{2}T/.test(e.t)), "one session id, ISO timestamps");
  await x.command("/profile history", ctx);
  const report = x.reports.at(-1)!;
  assert.ok(report.startsWith("# Verification history: ") && report.includes("- 2 tasks verified · 1 green on the first attempt") && report.includes("First-attempt failures by check: typecheck 1") && report.includes("✗ typecheck → still red"), report);
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("a check that cannot run is reported to the model once, not only as a UI toast", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo", devDependencies: { typescript: "5" } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  mkdirSync(join(root, "node_modules"), { recursive: true }); // installed, but no tsc binary
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  const edit = async (content: string) => {
    const event = { toolName: "write", input: { path: "src/a.ts", content }, content: [{ type: "text", text: "ok" }], isError: false };
    await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
    write(root, "src/a.ts", content);
    await x.emit("tool_result", event, ctx);
  };
  await x.emit("before_agent_start", prompt(), ctx);
  await edit("export const a = 1;\n");
  const first = await x.emit("agent_before_settle", settle(), ctx);
  assert.notEqual(first?.continue, true, "nothing to repair: the check did not run");
  await until(() => x.sent.length > 0);
  assert.equal(x.sent.length, 1);
  assert.ok(x.sent[0]!.content.startsWith("[verification] typecheck (`npx tsc --noEmit -p tsconfig.json`) could not run and is disabled for this session"), x.sent[0]!.content);
  assert.equal(x.sent[0]!.details?.kind, "env");
  await x.emit("before_agent_start", prompt(), ctx);
  await edit("export const a = 2;\n");
  await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(x.sent.length, 1, "the same broken check is reported once per session");
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("baseline: a check that already fails when the agent starts reading is pre-existing in the first prompt", async () => {
  const x = await load();
  const root = tmp();
  const failing = `node -e "console.error('src/old.ts(1,14): error TS2322: Type string is not assignable to type number.'); process.exit(2)"`;
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck: failing } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  write(root, "src/old.ts", "export const old: number = 'x';\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  // the agent reads before it writes: the read triggers nothing new here (the root baseline already runs) and the tree is untouched
  await x.emit("tool_result", { toolName: "read", input: { path: "src/old.ts" }, content: [{ type: "text", text: "" }], isError: false }, ctx);
  await until(() => x.notes.some(([, m]) => m.includes("already fails on the untouched tree")));
  assert.ok(x.statuses.some((t) => t.startsWith("\u23f3 baseline typecheck")), x.statuses.join("|"));
  assert.ok(x.statuses.at(-1)!.includes("auto-check"), "status line restored after the baseline: " + x.statuses.at(-1));
  const event = { toolName: "write", input: { path: "src/a.ts", content: "export const a = 1;\n" }, content: [{ type: "text", text: "ok" }], isError: false };
  await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
  write(root, "src/a.ts", "export const a = 1;\n");
  await x.emit("tool_result", event, ctx);
  const r = await x.emit("agent_before_settle", settle(), ctx);
  assert.notEqual(r?.continue, true, "no repair round for a failure the agent did not cause");
  assert.ok(text(r).includes("no new failures") && text(r).includes("typecheck (1 known)"), text(r));
  assert.equal(x.notes.filter(([, m]) => m.includes("untouched tree") || m.includes("existed before this task")).length, 1, "the user hears about it once");
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("baseline cache: the next session on the same tree starts with the last baseline, no background run; a new commit invalidates it", async () => {
  const root = tmp();
  const failing = `node -e "console.error('src/old.ts(1,14): error TS2322: Type string is not assignable to type number.'); process.exit(2)"`;
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck: failing } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  write(root, ".gitignore", "node_modules\n");
  write(root, "src/old.ts", "export const old: number = 'x';\n");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const { execSync } = process.getBuiltinModule("node:child_process") as typeof import("node:child_process");
  const git = (cmd: string) => execSync(`git -c user.name=t -c user.email=t@t ${cmd}`, { cwd: root, stdio: "ignore" });
  git("init -q");
  git("add -A");
  git("commit -q -m init");
  const edit = async (x: Awaited<ReturnType<typeof load>>, ctx: any, content: string) => {
    const event = { toolName: "write", input: { path: "src/a.ts", content }, content: [{ type: "text", text: "ok" }], isError: false };
    await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
    write(root, "src/a.ts", content);
    await x.emit("tool_result", event, ctx);
  };
  // session 1: the background baseline runs and is persisted
  const one = await load();
  const ctx1 = one.ctxFor(root);
  await one.emit("session_start", {}, ctx1);
  await one.emit("before_agent_start", prompt(), ctx1);
  await until(() => one.notes.some(([, m]) => m.includes("already fails on the untouched tree")));
  assert.ok(existsSync(join(one.agent, "project-profile", "baselines")), "baseline persisted");
  const cached = JSON.parse(readFileSync(readdirSync(join(one.agent, "project-profile", "baselines")).map((f) => join(one.agent, "project-profile", "baselines", f))[0]!, "utf8"));
  assert.ok(/^[0-9a-f]{40}$/.test(cached.fingerprint) && Object.values(cached.checks).some((c: any) => c.label === "typecheck" && c.diag.length === 1), JSON.stringify(cached).slice(0, 200));
  delete process.env.PI_CODING_AGENT_DIR;
  // session 2, same tree: restored at the first prompt, no "⏳ baseline" run, the failure is known before the first write
  const two = await load(one.agent);
  const ctx2 = two.ctxFor(root);
  await two.emit("session_start", {}, ctx2);
  await two.emit("before_agent_start", prompt(), ctx2);
  assert.ok(two.notes.some(([, m]) => m.includes("already fails on the untouched tree (1 diagnostic, baseline from earlier today, tree unchanged)")), two.notes.map(([, m]) => m).join("|"));
  await edit(two, ctx2, "export const a = 1;\n");
  const r = await two.emit("agent_before_settle", settle(), ctx2);
  assert.notEqual(r?.continue, true, "no repair round: the failure was known from the cache");
  assert.ok(text(r).includes("no new failures") && text(r).includes("typecheck (1 known)"), text(r));
  assert.ok(!two.statuses.some((t) => t.startsWith("\u23f3 baseline")), "no background baseline run: " + two.statuses.join("|"));
  delete process.env.PI_CODING_AGENT_DIR;
  // session 3 after a commit: another tree state, so the cache is ignored and the baseline runs again
  rmSync(join(root, "src/a.ts"));
  write(root, "src/b.ts", "export const b = 1;\n");
  git("add -A");
  git("commit -q -m more");
  const three = await load(one.agent);
  const ctx3 = three.ctxFor(root);
  await three.emit("session_start", {}, ctx3);
  await three.emit("before_agent_start", prompt(), ctx3);
  assert.ok(!three.notes.some(([, m]) => m.includes("tree unchanged")), "not restored after a commit");
  await until(() => three.statuses.some((t) => t.startsWith("\u23f3 baseline")) || three.notes.some(([, m]) => m.includes("untouched tree")));
  // config switch: verify.baselineCache=false restores nothing even on the same tree
  delete process.env.PI_CODING_AGENT_DIR;
  await until(() => three.notes.some(([, m]) => m.includes("untouched tree")));
  mkdirSync(join(one.agent, "project-profile"), { recursive: true });
  writeFileSync(join(one.agent, "project-profile", "config.json"), JSON.stringify({ verify: { baselineCache: false } }));
  const four = await load(one.agent);
  const ctx4 = four.ctxFor(root);
  await four.emit("session_start", {}, ctx4);
  await four.emit("before_agent_start", prompt(), ctx4);
  assert.ok(!four.notes.some(([, m]) => m.includes("tree unchanged")));
  four.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("baseline: a write before the baseline finished discards it; the aborted run does not disable the check", async () => {
  const x = await load();
  const root = tmp();
  const slow = `node -e "setTimeout(() => { console.error('src/old.ts(1,14): error TS2322: Type string is not assignable to type number.'); process.exit(2); }, 1500)"`;
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck: slow } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  const event = { toolName: "write", input: { path: "src/a.ts", content: "export const a = 1;\n" }, content: [{ type: "text", text: "ok" }], isError: false };
  await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
  write(root, "src/a.ts", "export const a = 1;\n");
  await x.emit("tool_result", event, ctx);
  const t0 = Date.now();
  const r = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(r?.continue, true, "without a baseline the failure is sent back");
  assert.ok(text(r).includes("TS2322") && text(r).includes("repair round 1"), text(r));
  assert.ok(!x.notes.some(([, m]) => m.includes("disabled this session") || m.includes("untouched tree")), x.notes.map(([, m]) => m).join("|"));
  assert.ok(Date.now() - t0 < 4000, "the pending baseline was aborted, not awaited on top of the gate");
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("diff guard reports even when no check applies (Markdown-only change with a secret)", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo" }));
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  const key = "AKIA" + "Q3EGUNSAFEKEY2P7";
  const event = { toolName: "write", input: { path: "NOTES.md", content: `key ${key}\n` }, content: [{ type: "text", text: "ok" }], isError: false };
  await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
  write(root, "NOTES.md", `key ${key}\n`);
  await x.emit("tool_result", event, ctx);
  const r = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(r?.continue, true, "secrets get one follow-up turn");
  assert.ok(text(r).includes("possible AWS access key ID in NOTES.md:1"));
  assert.ok(!text(r).includes(key), "the secret value is never repeated");
  assert.ok(x.notes.some(([t, m]) => t === "warning" && m.includes("NOTES.md")));
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("run_checks at an umbrella root: one nested project runs; several are named instead of 'no applicable checks'", async () => {
  const x = await load();
  const root = tmp();
  const ok = `node -e "process.exit(0)"`;
  write(root, "Documentation/notes.md", "# notes\n");
  write(root, "site/package.json", JSON.stringify({ name: "site", scripts: { typecheck: ok } }));
  write(root, "site/package-lock.json", "{}");
  write(root, "site/tsconfig.json", "{}");
  mkdirSync(join(root, "site/node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  const one = await x.runChecks(ctx);
  assert.ok(one.startsWith("verification: green") && one.includes("typecheck") && one.includes("site"), one);
  // a second nested project makes the choice ambiguous: say what exists instead of running everything
  write(root, "api/package.json", JSON.stringify({ name: "api", scripts: { typecheck: ok } }));
  const y = await load();
  const ctx2 = y.ctxFor(root);
  await y.emit("session_start", {}, ctx2);
  const two = await y.runChecks(ctx2);
  assert.ok(two.includes("nested projects: api, site") && two.includes("pass files"), two);
  x.cleanup();
  y.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("run_checks declares annotations and returns structured content for programmatic callers", async () => {
  const x = await load();
  const tool = x.impl["run_checks"]!;
  assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.ok(tool.outputSchema, "outputSchema is declared so codemode scripts receive data, not text");
  const root = tmp();
  const failing = `node -e "console.error('src/a.ts(1,1): error TS2322: Type string is not assignable to type number.'); process.exit(2)"`;
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck: failing } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  const r = await x.runChecksResult(ctx);
  assert.equal(r.isError, undefined);
  const data = r.structuredContent as { status: string; runs: Array<{ id: string; label: string; status: string; exitCode: number | null; summary: string[] }> };
  assert.equal(data.status, "red");
  const run = data.runs.find((q) => q.id === "node:typecheck")!;
  assert.equal(run.label, "typecheck");
  assert.equal(run.status, "fail");
  assert.equal(run.exitCode, 2);
  assert.deepEqual(run.summary, ["src/a.ts(1,1): error TS2322: Type string is not assignable to type number."]);
  assert.ok(r.content[0]!.text.startsWith("verification: red"), r.content[0]!.text);
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

/** A project whose typecheck script prints one tsc-style diagnostic and fails. */
function failingProject(root: string, opts: { scripts?: Record<string, string>; message?: string; onlyWhenEdited?: boolean } = {}) {
  const guard = opts.onlyWhenEdited ? "if (!require('fs').existsSync('src/a.ts')) process.exit(0); " : "";
  const typecheck = `node -e "${guard}console.error('src/a.ts(1,1): error TS2322: ${opts.message ?? "Type string is not assignable to type number"}.'); process.exit(2)"`;
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck, ...opts.scripts } }));
  write(root, "package-lock.json", "{}");
  write(root, "tsconfig.json", "{}");
  mkdirSync(join(root, "node_modules"), { recursive: true });
}

/** One write-tool round trip as π reports it. */
async function editFile(x: Awaited<ReturnType<typeof load>>, ctx: any, root: string, rel: string, content: string) {
  const event = { toolName: "write", input: { path: rel, content }, content: [{ type: "text", text: "ok" }], isError: false };
  await x.emit("tool_call", { toolName: "write", input: event.input }, ctx);
  write(root, rel, content);
  await x.emit("tool_result", event, ctx);
}

const kinds = (r: any) => (r?.entries ?? []).map((e: any) => e.details?.kind ?? e.type);

/** The background baseline of the untouched tree has reported through the status line and finished. */
const baselineSettled = (x: Awaited<ReturnType<typeof load>>) => until(() => x.statuses.some((t) => t.startsWith("\u23f3 baseline")) && !x.statuses.at(-1)!.startsWith("\u23f3"));

test("/profile subcommands persist user data the next prompt and report reflect", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, devDependencies: { vitest: "2" } }));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  const user = () => JSON.parse(readFileSync(profilePath(x.agent, realpathSync(root)), "utf8")).user;
  const lastNote = () => x.notes.at(-1)![1];

  await x.command("/profile set lint make lint", ctx);
  assert.equal(user().overrides.lint, "make lint");
  assert.ok(lastNote().startsWith("project-profile: lint = `make lint`"), lastNote());
  await x.command("/profile set lint -", ctx);
  assert.equal(user().overrides.lint, null);
  await x.command("/profile set lint default", ctx);
  assert.ok(!("lint" in user().overrides), "default removes the override");
  assert.ok(lastNote().includes("follows detection again"), lastNote());
  await x.command("/profile set", ctx);
  assert.ok(lastNote().startsWith("usage: /profile set"), lastNote());

  await x.command("/profile tests allow", ctx);
  assert.equal(user().permissions.tests, "allow");
  await x.command("/profile tests ask", ctx);
  assert.equal(user().permissions.tests, undefined);

  await x.command("/profile verify off", ctx);
  assert.equal(user().verify, false);
  const p = prompt();
  await x.emit("before_agent_start", p, ctx);
  assert.ok(!p.systemPromptOptions.sections["project_profile"]!.includes("- Verification:"), "verify off: the prompt promises no checks");
  await x.command("/profile verify default", ctx);
  assert.equal(user().verify, undefined);

  await x.command("/profile notes", ctx);
  assert.ok(lastNote().startsWith("no notes"), lastNote());
  await x.command("/profile note Use tabs", ctx);
  assert.deepEqual(user().notes.map((n: any) => [n.text, n.by, typeof n.id, typeof n.at]), [["Use tabs", "user", "string", "string"]]);
  await x.command("/profile note See `src/gone.ts`", ctx);
  const ids = user().notes.map((n: any) => n.id);
  await x.command("/profile notes", ctx);
  assert.ok(x.reports.at(-1)!.startsWith("# Notes for ") && x.reports.at(-1)!.includes(`1. [${ids[0]}] (user, `) && x.reports.at(-1)!.includes("Use tabs"), x.reports.at(-1));
  const p2 = prompt();
  await x.emit("before_agent_start", p2, ctx);
  assert.ok(p2.systemPromptOptions.sections["project_profile"]!.includes(`(user ${ids[0]}) Use tabs · (user ${ids[1]}) See \`src/gone.ts\``), "notes are in the prompt with their author and id");
  await x.command("/profile show", ctx);
  assert.ok(x.reports.at(-1)!.startsWith("# Project profile: ") && x.reports.at(-1)!.includes("- notes: 2 (") && x.reports.at(-1)!.includes("Use tabs"), x.reports.at(-1));
  await x.command("/profile notes rm nope", ctx);
  assert.ok(lastNote().startsWith("project-profile: no note nope"), lastNote());
  await x.command(`/profile notes rm ${ids[1]}`, ctx);
  assert.deepEqual(user().notes.map((n: any) => n.text), ["Use tabs"]);
  await x.command("/profile notes rm 1", ctx);
  assert.deepEqual(user().notes, []);
  await x.command("/profile note Again", ctx);
  await x.command("/profile notes clear", ctx);
  assert.deepEqual(user().notes, []);
  // the sleep pass at session start flags a note whose path no longer exists, in the prompt and to the user
  await x.command("/profile note Config lives in `src/gone.ts`", ctx);
  await x.emit("session_start", {}, ctx);
  assert.ok(x.notes.some(([, m]) => m.includes("1 note may be stale")), x.notes.map(([, m]) => m).join("|"));
  const p3 = prompt();
  await x.emit("before_agent_start", p3, ctx);
  assert.ok(p3.systemPromptOptions.sections["project_profile"]!.includes("`src/gone.ts` [may be stale: `src/gone.ts` does not exist]"), p3.systemPromptOptions.sections["project_profile"]);
  await x.command("/profile notes clear", ctx);

  await x.command("/profile set test make test", ctx);
  await x.command("/profile storage", ctx);
  assert.ok(x.reports.at(-1)!.startsWith("# project-profile storage") && x.reports.at(-1)!.includes("- profiles: 1 file") && x.reports.at(-1)!.includes("- history: 1 file") && x.reports.at(-1)!.includes("## This repository"), x.reports.at(-1));
  await x.command("/profile storage prune", ctx);
  assert.ok(lastNote().includes("nothing to prune"), lastNote());
  assert.ok(existsSync(historyPath(x.agent, realpathSync(root))), "the live repository's history survives a prune");
  await x.command("/profile forget", ctx);
  assert.deepEqual(user().overrides, {}, "forget drops user data and re-detects");
  assert.ok(!existsSync(historyPath(x.agent, realpathSync(root))), "forget drops the history too");
  await x.command("/profile bogus", ctx);
  assert.ok(lastNote().startsWith("usage: /profile [show|"), lastNote());
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("memory tools: remember saves an agent note with evidence, forget_note protects user notes except in a dream, /profile dream sends the consolidation message", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { test: "vitest run" }, devDependencies: { vitest: "2" } }));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  const user = () => JSON.parse(readFileSync(profilePath(x.agent, realpathSync(root)), "utf8")).user;
  const call = async (tool: string, params: Record<string, unknown>) => {
    const r = await x.impl[tool]!.execute("id", params, undefined, undefined, ctx);
    return { text: r.content.map((c) => c.text).join("\n"), error: !!r.isError };
  };
  await x.emit("before_agent_start", prompt(), ctx);
  // nothing to consolidate yet
  await x.command("/profile dream", ctx);
  assert.ok(x.notes.at(-1)![1].includes("nothing to dream about"), x.notes.at(-1)![1]);
  assert.equal(x.sent.length, 0);

  const saved = await call("remember", { text: "  Tests need `DATABASE_URL`   set to a local Postgres ", evidence: "npm test failed with ECONNREFUSED without it" });
  assert.ok(!saved.error && /^saved note \[[0-9a-f]{6}\]/.test(saved.text), saved.text);
  const id = saved.text.match(/\[([0-9a-f]{6})\]/)![1]!;
  assert.deepEqual(user().notes.map((n: any) => [n.id, n.by, n.text, n.evidence]), [[id, "agent", "Tests need `DATABASE_URL` set to a local Postgres", "npm test failed with ECONNREFUSED without it"]]);
  assert.ok(x.notes.at(-1)![1].startsWith(`project-profile: the agent noted [${id}]`), "the user is told");
  const dup = await call("remember", { text: "tests need `DATABASE_URL` set to a local postgres" });
  assert.ok(!dup.error && dup.text.startsWith(`already noted as [${id}]`), dup.text);
  assert.equal(user().notes.length, 1);
  assert.ok((await call("remember", { text: "   " })).error);
  const p = prompt();
  await x.emit("before_agent_start", p, ctx);
  const section = p.systemPromptOptions.sections["project_profile"]!;
  assert.ok(section.includes(`(agent ${id}) Tests need \`DATABASE_URL\` set to a local Postgres — evidence: npm test failed with ECONNREFUSED without it`), section);
  assert.ok(section.includes("The `remember` tool saves a note for future sessions"), "the preamble says what memory is for");

  // a user note: the agent may not remove it outside a dream
  await x.command("/profile note Keep the Makefile; `make check` is what CI runs", ctx);
  const userId = user().notes[1].id;
  const refused = await call("forget_note", { id: userId });
  assert.ok(refused.error && refused.text.includes("written by the user") && refused.text.includes(`/profile notes rm ${userId}`), refused.text);
  assert.equal(user().notes.length, 2);
  assert.ok((await call("forget_note", { id: "ffffff" })).error);
  // its own note it may remove
  const gone = await call("forget_note", { id, reason: "the README now documents it" });
  assert.ok(!gone.error && gone.text.startsWith(`removed note [${id}] (agent). 1 note left.`), gone.text);
  assert.ok(x.notes.at(-1)![1].includes("the agent removed note") && x.notes.at(-1)![1].includes("the README now documents it"));

  // the agent-note limit
  for (let i = 0; i < 25; i++) assert.ok(!(await call("remember", { text: `fact number ${i} about this project` })).error);
  const full = await call("remember", { text: "one too many" });
  assert.ok(full.error && full.text.includes("limit reached: 25 agent notes"), full.text);
  assert.equal(user().notes.length, 26);

  // /profile dream: the message lists the notes with ids and the history, asks for consolidation, and lets the run remove user notes
  await x.command("/profile dream", ctx);
  const dream = x.sent.at(-1)!;
  assert.ok(dream.content.startsWith("[project-profile] Dream: consolidate this project's memory"), dream.content);
  assert.ok(dream.content.includes(`[${userId}] (user, `) && dream.content.includes("`make check`") && dream.content.includes("Verification history") && dream.content.includes("Do not change any file in the repository"), dream.content);
  assert.ok(!dream.content.includes("[verification]"));
  const inDream = await call("forget_note", { id: userId, reason: "CI now runs npm test" });
  assert.ok(!inDream.error, inDream.text);
  assert.equal(user().notes.length, 25);
  // the dream ends at the run's settle boundary: user notes are protected again
  await x.command("/profile note Another user note", ctx);
  const userId2 = user().notes.at(-1).id;
  await x.emit("agent_before_settle", settle(), ctx);
  assert.ok((await call("forget_note", { id: userId2 })).error, "protected after the dream run settled");
  // a user prompt also ends a dream
  await x.command("/profile dream", ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  assert.ok((await call("forget_note", { id: userId2 })).error, "protected once the user prompts");
  // ... but a run that before_agent_start reports as custom-started (π ≥ 1.5) keeps dreaming
  await x.command("/profile dream", ctx);
  await x.emit("before_agent_start", { ...prompt(), messageType: "custom" }, ctx);
  assert.ok(!(await call("forget_note", { id: userId2 })).error, "still dreaming in the custom-started run");
  // history recorded the note events and the dreams
  const history = readFileSync(historyPath(x.agent, realpathSync(root)), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(history.filter((e) => e.kind === "dream").length, 3);
  assert.ok(history.some((e) => e.kind === "note" && e.action === "add" && e.by === "agent" && e.id === id));
  assert.ok(history.some((e) => e.kind === "note" && e.action === "remove" && e.by === "agent" && e.id === userId));
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("memory tools are not registered when profile.agentNotes is off, and the prompt does not mention them", async () => {
  const agent = tmp();
  mkdirSync(join(agent, "project-profile"), { recursive: true });
  writeFileSync(join(agent, "project-profile", "config.json"), JSON.stringify({ profile: { agentNotes: false } }));
  process.env.PI_CODING_AGENT_DIR = agent;
  const mod = await import("../index.ts");
  const tools: string[] = [];
  const commandImpl: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
  const handlers: Record<string, Handler[]> = {};
  mod.default({
    on: (e: string, h: Handler) => {
      (handlers[e] ??= []).push(h);
      return () => {};
    },
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (n: string, o: any) => {
      commandImpl[n] = o;
    },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    sendMessage: () => {},
  } as any);
  assert.deepEqual(tools, ["run_checks"]);
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo" }));
  const notes: string[] = [];
  const ctx = { cwd: root, mode: "print", hasUI: false, isProjectTrusted: () => true, ui: { notify: (m: string) => notes.push(m), setStatus: () => {}, select: async () => undefined }, sessionManager: { getBranch: () => [] } };
  for (const h of handlers["session_start"]!) await h({}, ctx);
  const p = prompt();
  for (const h of handlers["before_agent_start"]!) await h(p, ctx);
  assert.ok(!p.systemPromptOptions.sections["project_profile"]!.includes("`remember`"));
  await commandImpl["profile"]!.handler("dream", ctx);
  assert.ok(notes.at(-1)!.includes("profile.agentNotes"), notes.at(-1));
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agent, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

test("/verify runs one tier on demand, hands a red result to the model without a turn, and can be cancelled", async () => {
  const x = await load();
  const root = tmp();
  failingProject(root, { scripts: { lint: `node -e "console.error('src/a.ts:1:1: error no-unused-vars x is defined but never used'); process.exit(1)"` } });
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.command("/verify lint", ctx);
  const report = x.reports.at(-1)!;
  assert.ok(report.startsWith("## /verify \u2014 red"), report);
  assert.ok(report.includes("\u2717 **lint**") && !report.includes("typecheck"), report);
  const msg = x.sent.at(-1)!;
  assert.ok(msg.content.startsWith("[verification] manual /verify found failures:"), msg.content);
  assert.deepEqual({ seq: msg.details.seq, kind: msg.details.kind }, { seq: -1, kind: "failure" });
  await x.command("/verify cancel", ctx);
  assert.equal(x.notes.at(-1)![1], "verify: cancelled");
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("per-turn checks: fast tiers only, a note without `continue`, and the earlier note is superseded", async () => {
  const x = await load();
  write(x.agent, "project-profile/config.json", JSON.stringify({ verify: { perTurn: true } }));
  const root = tmp();
  failingProject(root, { scripts: { test: `node -e "require('fs').writeFileSync('TESTS_RAN', '')"` }, onlyWhenEdited: true });
  const branch: any[] = [];
  const ctx = { ...x.ctxFor(root), sessionManager: { getBranch: () => branch } };
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  await baselineSettled(x);
  await editFile(x, ctx, root, "src/a.ts", "export const a = 1;\n");
  const first = await x.emit("turn_end", { outcome: "completed", entries: [], turnIndex: 0 }, ctx);
  assert.equal(first?.continue, undefined, "the agent is still working: never asked to continue");
  assert.deepEqual(kinds(first), ["perturn"]);
  assert.ok(text(first).includes("TS2322"), text(first));
  assert.ok(!existsSync(join(root, "TESTS_RAN")), "the test tier never runs mid-task");
  branch.push({ type: "custom_message", customType: "project-profile/verify", id: "note-1", details: first.entries[0].details });
  await editFile(x, ctx, root, "src/a.ts", "export const a = 2;\n");
  const second = await x.emit("turn_end", { outcome: "completed", entries: [], turnIndex: 1 }, ctx);
  assert.deepEqual(kinds(second), ["context_edit", "perturn"]);
  assert.equal(second.entries[0].targetId, "note-1");
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("repair loop stops when the same failure repeats, and when the rounds are exhausted", async () => {
  const x = await load();
  const root = tmp();
  failingProject(root);
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  await editFile(x, ctx, root, "src/a.ts", "export const a = 1;\n");
  const first = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(first?.continue, true);
  assert.deepEqual(kinds(first), ["failure"]);
  await editFile(x, ctx, root, "src/a.ts", "export const a = 2;\n");
  const second = await x.emit("agent_before_settle", settle(), ctx);
  assert.deepEqual(kinds(second), ["giveup"]);
  assert.ok(text(second).includes("automatic repair stopped: the same failure repeated with no progress"), text(second));
  x.cleanup();

  const y = await load();
  write(y.agent, "project-profile/config.json", JSON.stringify({ verify: { maxRepairRounds: 1 } }));
  const ctx2 = y.ctxFor(root);
  await y.emit("session_start", {}, ctx2);
  await y.emit("before_agent_start", prompt(), ctx2);
  await editFile(y, ctx2, root, "src/a.ts", "export const a = 3;\n");
  assert.equal((await y.emit("agent_before_settle", settle(), ctx2))?.continue, true);
  failingProject(root, { message: "Property x does not exist" });
  await editFile(y, ctx2, root, "src/a.ts", "export const a = 4;\n");
  const last = await y.emit("agent_before_settle", settle(), ctx2);
  assert.deepEqual(kinds(last), ["giveup"]);
  assert.ok(text(last).includes("automatic repair stopped: 1 repair rounds exhausted"), text(last));
  y.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("a follow-up that continues the agent asks once, at its end, for the complete task summary; one that does not continue never asks", async () => {
  const x = await load();
  const root = tmp();
  failingProject(root);
  const ctx = x.ctxFor(root);
  const asks = (r: any) => text(r).split("complete summary of the whole task").length - 1;
  const endsWithAsk = (r: any) => /complete summary of the whole task[^\n]*$/.test(r.entries.at(-1).content);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  await editFile(x, ctx, root, "src/a.ts", "export const a = 1;\n");
  const repair = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(repair?.continue, true);
  assert.equal(asks(repair), 1, text(repair));
  assert.ok(endsWithAsk(repair), text(repair));
  // the same failure again, with a suppression added while it fails: the give-up and the review finding both continue, one request at the very end
  await editFile(x, ctx, root, "src/a.ts", "// @ts-ignore\nexport const a = 2;\n");
  const giveUp = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(giveUp?.continue, true);
  assert.deepEqual(kinds(giveUp), ["giveup", "finding"]);
  assert.equal(asks(giveUp), 1, text(giveUp));
  assert.ok(endsWithAsk(giveUp), text(giveUp));
  // next prompt: the failure is known, nothing continues
  await x.emit("before_agent_start", prompt(), ctx);
  await editFile(x, ctx, root, "src/a.ts", "export const a = 3;\n");
  const known = await x.emit("agent_before_settle", settle(), ctx);
  assert.notEqual(known?.continue, true);
  assert.ok(text(known).includes("no new failures"), text(known));
  assert.equal(asks(known), 0, text(known));
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("weakening counts as gaming only when it can hide the check that failed: a lint suppression next to a typecheck fix is shown, a @ts-ignore gets a follow-up", async () => {
  for (const [added, gamed] of [["// eslint-disable-next-line no-console", false], ["// @ts-ignore", true]] as const) {
    const x = await load();
    const root = tmp();
    const typecheck = `node -e "if (require('fs').readFileSync('src/a.ts', 'utf8').includes('BAD')) { console.error('src/a.ts(1,1): error TS2322: Type string is not assignable to type number.'); process.exit(2) }"`;
    write(root, "package.json", JSON.stringify({ name: "demo", scripts: { typecheck } }));
    write(root, "package-lock.json", "{}");
    write(root, "tsconfig.json", "{}");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const ctx = x.ctxFor(root);
    await x.emit("session_start", {}, ctx);
    await x.emit("before_agent_start", prompt(), ctx);
    await editFile(x, ctx, root, "src/a.ts", "export const a: number = 'BAD';\n");
    assert.deepEqual(kinds(await x.emit("agent_before_settle", settle(), ctx)), ["failure"]);
    // care-prints: eslint-disables added while the tests failed got "remove them and fix the underlying problem"
    await editFile(x, ctx, root, "src/a.ts", `${added}\nexport const a: number = 1;\n`);
    const r = await x.emit("agent_before_settle", settle(), ctx);
    assert.equal(r?.continue === true, gamed, text(r));
    assert.equal(text(r).includes("while verification was failing"), gamed, text(r));
    x.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the review skips ignored directories: an edit inside node_modules is no stale lockfile", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo" }));
  write(root, "package-lock.json", "{}");
  write(root, "node_modules/dep/package.json", JSON.stringify({ name: "dep", dependencies: {} }));
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  // ~/projects: patching an installed package got a follow-up turn to run `npm install` at the project root
  await editFile(x, ctx, root, "node_modules/dep/package.json", JSON.stringify({ name: "dep", dependencies: { extra: "1" } }));
  const r = await x.emit("agent_before_settle", settle(), ctx);
  assert.equal(r, undefined, text(r));
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});

test("checks that cannot run for one reason are reported once, with the cause and the directory", async () => {
  const x = await load();
  const root = tmp();
  const emptyBin = tmp();
  write(root, "package.json", JSON.stringify({ name: "mono", private: true }));
  write(root, "pnpm-lock.yaml", "");
  write(root, "apps/web/package.json", JSON.stringify({ name: "web", scripts: { typecheck: "tsc --noEmit", lint: "next lint", "format:check": "prettier --check ." } }));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  const prev = process.env.PATH;
  // live-and-stay: π ran on a Node without pnpm; three messages each said "dependencies not installed — run `pnpm install`"
  process.env.PATH = emptyBin;
  try {
    const ctx = x.ctxFor(root);
    await x.emit("session_start", {}, ctx);
    await x.emit("before_agent_start", prompt(), ctx);
    await editFile(x, ctx, root, "apps/web/src/a.ts", "export const a = 1;\n");
    await x.emit("agent_before_settle", settle(), ctx);
    const env = x.sent.filter((m) => m.details?.kind === "env").map((m) => m.content);
    assert.equal(env.length, 1, env.join("\n---\n"));
    assert.match(env[0]!, /typecheck .*lint .*format .*in apps\/web could not run/);
    assert.ok(env[0]!.includes("`pnpm` not found on PATH") && !env[0]!.includes("dependencies not installed"), env[0]);
    assert.equal(x.notes.filter(([, m]) => m.includes("disabled this session")).length, 1, x.notes.map(([, m]) => m).join("\n"));
  } finally {
    process.env.PATH = prev;
    x.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(emptyBin, { recursive: true, force: true });
  }
});

test("per-turn checks are off by default", async () => {
  const x = await load();
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "demo" }));
  const ctx = x.ctxFor(root);
  await x.emit("session_start", {}, ctx);
  await x.emit("before_agent_start", prompt(), ctx);
  assert.equal(await x.emit("turn_end", { outcome: "completed", entries: [], turnIndex: 0 }, ctx), undefined);
  x.cleanup();
  rmSync(root, { recursive: true, force: true });
});
