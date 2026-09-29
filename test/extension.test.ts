/**
 * Integration tests of the π wiring (index.ts): the real extension driven
 * through π's event sequence with a mock ExtensionAPI and context.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

type Handler = (event: any, ctx: any) => any;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "pp-ext-"));
}
function write(root: string, rel: string, content: string) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
}

/** Load the extension against a mock π API with its own agent dir (no ~/.pi pollution). */
async function load() {
  const agent = tmp();
  process.env.PI_CODING_AGENT_DIR = agent;
  const mod = await import("../index.ts");
  const handlers: Record<string, Handler[]> = {};
  const tools: string[] = [];
  const commands: string[] = [];
  mod.default({
    on: (event: string, h: Handler) => {
      (handlers[event] ??= []).push(h);
      return () => {};
    },
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (name: string) => commands.push(name),
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    appendEntry: () => {},
    sendMessage: () => {},
  } as any);
  const notes: Array<[string, string]> = [];
  const ctxFor = (cwd: string) => ({
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: () => true,
    ui: { notify: (m: string, t: string) => notes.push([t, m]), setStatus: () => {}, select: async () => undefined },
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
  return { handlers, tools, commands, notes, ctxFor, emit, cleanup };
}

const prompt = () => ({ systemPromptOptions: { sections: {} as Record<string, string>, contextFiles: [] } });
const settle = () => ({ outcome: "completed", entries: [] as unknown[], continue: false });
const text = (r: any) => (r?.entries ?? []).map((e: any) => (typeof e.content === "string" ? e.content : "")).join("\n");

test("registration: one run_checks tool, /profile and /verify, every lifecycle hook", async () => {
  const x = await load();
  assert.deepEqual(x.tools, ["run_checks"]);
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
