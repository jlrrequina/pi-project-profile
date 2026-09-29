/**
 * Package smoke test: run against the *extracted tarball*, not the repo.
 * Proves the published file list is self-contained: every module index.ts
 * needs is packed, the extension registers against a π-shaped API, and the
 * shipped dev CLI works.
 *
 *   node test/smoke.ts <extracted-package-dir> [<repo-to-scan>]
 *
 * π's own packages (@earendil-works/*) must be resolvable from the extracted
 * directory, as π provides them at runtime: link a node_modules next to it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dir = resolve(process.argv[2] ?? "");
const target = resolve(process.argv[3] ?? ".");
const fail = (msg: string): never => {
  console.error(`smoke: ${msg}`);
  process.exit(1);
};
if (!existsSync(join(dir, "package.json"))) fail(`no package.json in ${dir}`);

// The published file list: nothing from the repo's development side, everything the package needs.
const packed: string[] = [];
const walk = (d: string, rel = "") => {
  for (const e of readdirSync(join(d, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(d, r);
    else packed.push(r);
  }
};
walk(dir);
const banned = packed.filter((f) => /^(test|docs|\.github|node_modules)\/|^scripts\/(?!scan\.ts$)|^(tsconfig\.json|AGENTS\.md|CONTRIBUTING\.md|SECURITY\.md)$/.test(f));
const missing = ["index.ts", "package.json", "README.md", "LICENSE", "CHANGELOG.md", "scripts/scan.ts", "skills/project-profile/SKILL.md", "llms.txt"].filter((f) => !packed.includes(f));
if (banned.length || missing.length) fail(`packed files — unexpected: ${JSON.stringify(banned)}, missing: ${JSON.stringify(missing)}`);

const mod = await import(pathToFileURL(join(dir, "index.ts")).href);
if (typeof mod.default !== "function") fail("index.ts has no default export function");
const events = new Set<string>();
const tools: string[] = [];
const commands: string[] = [];
mod.default({
  on: (e: string) => {
    events.add(e);
    return () => {};
  },
  registerTool: (t: { name: string }) => tools.push(t.name),
  registerCommand: (n: string) => commands.push(n),
  registerMessageRenderer: () => {},
  registerEntryRenderer: () => {},
  appendEntry: () => {},
  sendMessage: () => {},
});
if (tools.join() !== "run_checks") fail(`expected exactly one tool run_checks, got ${JSON.stringify(tools)}`);
for (const c of ["profile", "verify"]) if (!commands.includes(c)) fail(`command /${c} not registered`);
for (const e of ["session_start", "before_agent_start", "tool_call", "tool_result", "agent_before_settle", "turn_end"]) if (!events.has(e)) fail(`no ${e} handler`);

const scan = spawnSync(process.execPath, [join(dir, "scripts", "scan.ts"), target, "--checks"], { encoding: "utf8", timeout: 60_000 });
if (scan.status !== 0) fail(`scripts/scan.ts exited ${scan.status}: ${scan.stderr.slice(0, 500)}`);
if (!scan.stdout.includes("- Commands:") || !scan.stdout.includes("Checks:")) fail("scan output is missing the profile or the checks");

console.log(`smoke: ok — ${packed.length} packed files, ${tools.length} tool, ${commands.length} commands, ${events.size} events; scan of ${target} rendered ${scan.stdout.split("\n").length} lines`);
