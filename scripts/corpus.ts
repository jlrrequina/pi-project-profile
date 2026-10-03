/**
 * Detector regression on real repositories.
 *
 *   node scripts/corpus.ts [--only zod,ripgrep] [--dir <cache dir>]
 *
 * Shallow-clones each repository, runs detection and checks invariants that
 * must hold for any repository (determinism, bounded prompt section, sane
 * checks, automatic checks are read-only) plus coarse expectations per
 * repository (language, core checks). Writes a Markdown table to stdout and
 * to $GITHUB_STEP_SUMMARY. Exit code 1 when an invariant or expectation
 * fails; a repository that cannot be cloned is reported, not failed.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { loadConfig } from "../config.ts";
import { detectProject, findProjectRoot } from "../detect/index.ts";
import { renderPromptSection } from "../profile/render.ts";
import { emptyUserData } from "../profile/store.ts";
import type { DetectedProfile, StoredProfile } from "../types.ts";
import { checkKey, TIER_POLICY } from "../types.ts";

interface Entry {
  repo: string;
  languages: string[];
  checks?: string[];
  commands?: string[];
}

export const CORPUS: Entry[] = [
  { repo: "colinhacks/zod", languages: ["TypeScript"], checks: ["node:typecheck"], commands: ["test", "test:one"] },
  { repo: "honojs/hono", languages: ["TypeScript"], commands: ["test"] },
  { repo: "t3-oss/create-t3-turbo", languages: ["TypeScript"], checks: ["node:typecheck"] },
  { repo: "vitejs/vite", languages: ["TypeScript"], commands: ["test"] },
  { repo: "BurntSushi/ripgrep", languages: ["Rust"], checks: ["cargo:check", "cargo:fmt", "cargo:test"], commands: ["test:one"] },
  { repo: "tokio-rs/axum", languages: ["Rust"], checks: ["cargo:check"] },
  { repo: "spf13/cobra", languages: ["Go"], checks: ["go:build", "go:vet", "go:test"], commands: ["test:one"] },
  { repo: "gin-gonic/gin", languages: ["Go"], checks: ["go:build"] },
  { repo: "pallets/flask", languages: ["Python"], checks: ["py:pytest"], commands: ["test:one"] },
  { repo: "psf/requests", languages: ["Python"] },
  { repo: "fastapi/fastapi", languages: ["Python"] },
  { repo: "sinatra/sinatra", languages: ["Ruby"] },
  { repo: "rubocop/rubocop", languages: ["Ruby"] },
  { repo: "spring-projects/spring-petclinic", languages: ["Java"] },
  { repo: "apple/swift-argument-parser", languages: ["Swift"] },
  { repo: "slimphp/Slim", languages: ["PHP"] },
  { repo: "phoenixframework/phoenix", languages: ["Elixir"] },
  { repo: "dart-lang/http", languages: ["Dart"] },
  { repo: "nlohmann/json", languages: ["C++"] },
  { repo: "ohmyzsh/ohmyzsh", languages: ["Shell"] },
];

/** Commands that write files: never allowed in tiers that run without asking. */
const MUTATING = /(^|\s)(--fix|--write|--apply|--apply-unsafe|--in-place|-w|-i)(\s|$)|\bgofmt -w\b|\b(ruff|black|isort|dotnet|mix|zig|deno|dart|swift-format|clang-format|terraform|tofu|prettier) (format|fmt)?\s*\.?\s*$/;

export function invariants(p: DetectedProfile, section: string, again: DetectedProfile, section2: string): string[] {
  const errors: string[] = [];
  if (JSON.stringify(p) !== JSON.stringify(again)) errors.push("detection is not deterministic");
  if (section !== section2) errors.push("prompt section differs between renders");
  if (section.length > 12000) errors.push(`prompt section too long (${section.length} chars)`);
  if (p.languages.length === 0) errors.push("no language detected");
  const seen = new Set<string>();
  for (const c of p.checks) {
    const key = checkKey(c);
    if (seen.has(key)) errors.push(`duplicate check ${key}`);
    seen.add(key);
    if (!c.cmd || c.argv.length === 0) errors.push(`check ${c.id} has no command`);
    const rel = relative(p.root, c.cwd);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) errors.push(`check ${c.id} runs outside the project (${c.cwd})`);
    if (TIER_POLICY[c.tier] === "auto" && c.id !== "json:syntax" && MUTATING.test(c.cmd)) errors.push(`automatic check writes files: ${c.id} \`${c.cmd}\``);
  }
  return errors;
}

export function expectations(p: DetectedProfile, e: Entry): string[] {
  const errors: string[] = [];
  for (const l of e.languages) if (!p.languages.includes(l)) errors.push(`expected language ${l}, got ${p.languages.join("/") || "none"}`);
  for (const id of e.checks ?? []) if (!p.checks.some((c) => c.id === id)) errors.push(`expected check ${id}`);
  for (const k of e.commands ?? []) if (!p.commands[k]) errors.push(`expected command ${k}`);
  return errors;
}

function clone(repo: string, dest: string): boolean {
  if (existsSync(join(dest, ".git"))) return true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = spawnSync("git", ["clone", "--quiet", "--depth", "1", "--single-branch", "--no-tags", `https://github.com/${repo}.git`, dest], { encoding: "utf8", timeout: 180_000 });
    if (r.status === 0) return true;
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : undefined;
  const base = args.includes("--dir") ? args[args.indexOf("--dir") + 1]! : join(tmpdir(), "pp-corpus");
  mkdirSync(base, { recursive: true });
  const { config } = loadConfig("/nonexistent-for-defaults");
  const rows: string[] = ["| repository | ms | languages | checks (auto / confirm) | result |", "|---|---:|---|---|---|"];
  let failed = 0;
  let skipped = 0;
  for (const e of CORPUS.filter((x) => !only || only.some((o) => x.repo.toLowerCase().includes(o.toLowerCase())))) {
    const dest = join(base, e.repo.replace("/", "__"));
    if (!clone(e.repo, dest)) {
      skipped++;
      rows.push(`| ${e.repo} | – | – | – | ⚠ clone failed |`);
      continue;
    }
    const started = Date.now();
    let errors: string[];
    let p: DetectedProfile | undefined;
    try {
      const { root, gitRoot } = findProjectRoot(dest);
      p = detectProject(root, config, gitRoot);
      const ms = Date.now() - started;
      const again = detectProject(root, config, gitRoot);
      const stored: StoredProfile = { detected: p, user: emptyUserData(), updatedAt: "" };
      const opts = { verifyEnabled: true, piLoadedContextFiles: [] };
      errors = [...invariants(p, renderPromptSection(stored, config, opts), again, renderPromptSection(stored, config, opts)), ...expectations(p, e)];
      if (ms > 15_000) errors.push(`detection took ${ms} ms`);
      const auto = p.checks.filter((c) => TIER_POLICY[c.tier] === "auto" && c.tier !== "syntax").length;
      const confirm = p.checks.filter((c) => TIER_POLICY[c.tier] === "confirm").length;
      rows.push(`| ${e.repo} | ${ms} | ${p.languages.slice(0, 3).join(", ")} | ${auto} / ${confirm} | ${errors.length ? `✗ ${errors.join("; ")}` : "✓"} |`);
    } catch (err) {
      errors = [`detection threw: ${(err as Error).message}`];
      rows.push(`| ${e.repo} | – | – | – | ✗ ${errors[0]} |`);
    }
    if (errors.length) failed++;
  }
  const summary = `## Detector corpus\n\n${rows.join("\n")}\n\n${failed ? `**${failed} failed**` : "All passed"}${skipped ? ` · ${skipped} could not be cloned` : ""}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === (await import("node:url")).pathToFileURL(process.argv[1]).href) await main();
