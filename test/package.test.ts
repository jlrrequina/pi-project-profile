/**
 * Discoverability metadata: the parts of the package that registries, the π
 * package catalog, search engines and other agents read. They regress silently
 * (npm truncates descriptions, a skill with a bad name is dropped with a
 * warning at startup), so they are checked here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));

test("package.json: description survives npm's 255-character limit and the catalog card", () => {
  // The npm registry stores at most 255 characters; the π package catalog shows ~250.
  assert.ok(pkg.description.length <= 250, `description is ${pkg.description.length} chars`);
  assert.match(pkg.description, /[.!]$/, "description should end as a complete sentence");
  assert.match(pkg.description, /^Pi \(\u03c0\)/, "leads with the product name, both spellings");
  for (const term of ["coding-agent", "AGENTS.md", "CLAUDE.md", "typecheck", "lint", "test"]) assert.ok(pkg.description.includes(term), `description mentions ${term}`);
});

test("package.json: catalog keyword, manifest resources and published files exist", () => {
  assert.ok(pkg.keywords.includes("pi-package"), "pi-package keyword makes the package eligible for the π catalog");
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length, "no duplicate keywords");
  for (const k of pkg.keywords) assert.match(k, /^[a-z0-9.-]+$/, `keyword ${k} should be lowercase`);
  for (const type of ["extensions", "skills"]) {
    for (const p of pkg.pi[type]) assert.ok(existsSync(join(root, p)), `pi.${type} entry ${p} exists`);
  }
  assert.match(pkg.pi.image, /^https:\/\/.*\.png$/);
  for (const f of ["skills/", "llms.txt", "README.md", "CHANGELOG.md", "LICENSE"]) assert.ok(pkg.files.includes(f), `${f} is published`);
  assert.ok(existsSync(join(root, "docs", "cover.png")), "the catalog image exists in the repository");
});

test("skill: Agent Skills frontmatter is valid and the name matches its directory", () => {
  const dir = "skills/project-profile";
  const src = read(`${dir}/SKILL.md`);
  const fm = src.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, "SKILL.md starts with YAML frontmatter");
  const field = (k: string) => fm![1].match(new RegExp(`^${k}: (.*)$`, "m"))?.[1];
  const name = field("name");
  const description = field("description");
  assert.equal(name, "project-profile", "name equals the parent directory (portable across Agent Skills implementations)");
  assert.match(name!, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(name!.length <= 64);
  assert.ok(description && description.length > 0 && description.length <= 1024, `description is ${description?.length} chars (max 1024)`);
  assert.ok(/\bUse when\b/.test(description!), "description states when to use the skill (routing)");
  assert.ok(field("compatibility")!.length <= 500);
  // Progressive disclosure: the full body loads on activation, so keep it small.
  assert.ok(src.split("\n").length <= 500, "SKILL.md under 500 lines");
  // Everything the skill teaches must exist in the extension.
  const index = read("index.ts");
  for (const cmd of ["show", "refresh", "doctor", "set", "note", "notes", "tests", "build", "verify", "forget", "config", "path"]) assert.ok(src.includes(`/profile ${cmd}`) || cmd === "show", `skill documents /profile ${cmd}`);
  assert.ok(index.includes('name: "run_checks"') && src.includes("run_checks"));
  for (const key of ["maxRepairRounds", "runTests", "runBuild", "guard", "perTurn", "headless", "concurrency", "scopedInstructions", "maxInstructionFileChars"]) {
    assert.ok(src.includes(key), `skill documents config key ${key}`);
    assert.ok(read("types.ts").includes(key), `config key ${key} exists`);
  }
});

test("llms.txt: follows the llmstxt.org structure and links only to files that exist", () => {
  const txt = read("llms.txt");
  const lines = txt.split("\n");
  assert.equal(lines[0], "# pi-project-profile", "H1 with the project name");
  assert.ok(lines[2].startsWith("> "), "blockquote summary follows the H1");
  assert.ok(txt.includes("## Optional"), "an Optional section for secondary links");
  assert.ok(txt.includes("pi install npm:@lenard9191/pi-project-profile"));
  const raw = "https://raw.githubusercontent.com/jlrrequina/pi-project-profile/main/";
  const links = [...txt.matchAll(/\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 6);
  for (const url of links.filter((u) => u.startsWith(raw))) assert.ok(existsSync(join(root, url.slice(raw.length))), `${url} points at a file in the repository`);
  assert.ok(links.some((u) => u.endsWith("README.md")) && links.some((u) => u.endsWith("SKILL.md")) && links.some((u) => u.endsWith("CHANGELOG.md")));
});

test("site: landing page, sitemap and Pages workflow agree with each other", () => {
  const html = read("docs/site/index.html");
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ld, "JSON-LD present");
  const graph = JSON.parse(ld![1])["@graph"];
  assert.deepEqual(
    graph.map((n: any) => n["@type"]),
    ["SoftwareApplication", "SoftwareSourceCode", "FAQPage"],
  );
  const visibleFaq = [...html.matchAll(/<h3>(.*?)<\/h3>/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  assert.deepEqual(
    graph[2].mainEntity.map((q: any) => q.name),
    visibleFaq,
    "FAQ structured data must mirror the visible questions",
  );
  const title = html.match(/<title>(.*?)<\/title>/)![1];
  const desc = html.match(/name="description" content="(.*?)"/)![1];
  assert.ok(title.length <= 70, `title is ${title.length} chars`);
  assert.ok(desc.length <= 170, `meta description is ${desc.length} chars`);
  const canonical = html.match(/rel="canonical" href="(.*?)"/)![1];
  assert.equal(canonical, "https://jlrrequina.github.io/pi-project-profile/");
  assert.ok(read("docs/site/sitemap.xml").includes(canonical));
  assert.ok(html.includes(`rel="sitemap" type="application/xml" href="${canonical}sitemap.xml"`), "page links its sitemap (a project Pages site cannot serve a host-root robots.txt)");
  assert.ok(read("README.md").includes(canonical), "README links to the site");
  // Every relative reference on the page is a file the Pages workflow copies into the artifact.
  const workflow = read(".github/workflows/pages.yml");
  const rel = [...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]);
  for (const r of new Set(rel)) assert.ok(workflow.includes(r), `${r} is copied by the Pages workflow`);
  for (const f of ["docs/site/index.html", "docs/site/sitemap.xml", "docs/cover.png", "llms.txt"]) assert.ok(workflow.includes(f) && existsSync(join(root, f)), `${f} exists and is published`);
});

test("README: leads with the description, install command, and the FAQ questions search for", () => {
  const md = read("README.md");
  assert.ok(md.startsWith("# pi-project-profile\n"));
  assert.ok(md.indexOf("pi install npm:@lenard9191/pi-project-profile") < 1500, "install command is above the fold");
  assert.ok(md.includes("## FAQ"));
  for (const q of ["### Does it work with Claude Code, Cursor, Codex or GitHub Copilot?", "### Does it change anything in my repository?", "### Does it break prompt caching?"]) assert.ok(md.includes(q), `README answers: ${q}`);
  assert.ok(md.includes("(llms.txt)"), "README links llms.txt");
  assert.ok(md.includes("/skill:project-profile"), "README mentions the bundled skill");
});
