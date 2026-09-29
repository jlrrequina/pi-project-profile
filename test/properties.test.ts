/**
 * Property-based tests (fast-check). units.test.ts checks examples; each
 * property here states a contract that must hold for every input, and
 * fast-check searches for a counterexample and shrinks it:
 *
 *   - versions/changelog: the release workflow can never plan a release that is
 *     not newer, and releasing moves exactly the Unreleased notes.
 *   - baseline: a failure that existed before the task is never charged to the
 *     agent — whatever line numbers, timings, line endings or output order do.
 *   - findings: a detected secret is reported without echoing its value.
 *   - render: the prompt section depends only on what the model should see,
 *     never on volatile fields or on the order/format of π's loaded-file list.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import fc from "fast-check";
import { effectiveCommands, renderPromptSection } from "../profile/render.ts";
import { emptyUserData } from "../profile/store.ts";
import { releaseChangelog, sectionBody } from "../scripts/changelog.ts";
import { compareVersions, nextVersion, parseVersion, planRelease } from "../scripts/release.ts";
import { DEFAULT_CONFIG, type Check, type DetectedProfile, type StoredProfile, type Tier } from "../types.ts";
import { analyzeDiagnostics, diagCount, normalizeDiag, splitByBaseline, type DiagSet } from "../verify/baseline.ts";
import { collectFindings, formatFinding, mustFix } from "../verify/findings.ts";

// ---------------------------------------------------------------- versions (scripts/release.ts)
const version = fc.tuple(fc.nat({ max: 999 }), fc.nat({ max: 999 }), fc.nat({ max: 999 })).map(([a, b, c]) => `${a}.${b}.${c}`);
const bump = fc.constantFrom("patch", "minor", "major");

test("versions: compareVersions is a total order on X.Y.Z, numeric per component", () => {
  fc.assert(
    fc.property(version, version, version, (a, b, c) => {
      assert.equal(compareVersions(a, a), 0);
      assert.equal(Math.sign(compareVersions(a, b)), -Math.sign(compareVersions(b, a)));
      if (compareVersions(a, b) <= 0 && compareVersions(b, c) <= 0) assert.ok(compareVersions(a, c) <= 0);
      // canonical strings: equal iff identical (so "1.10.0" > "1.9.0", not string order)
      assert.equal(compareVersions(a, b) === 0, a === b);
      assert.deepEqual(parseVersion(a).join("."), a);
    }),
  );
  fc.assert(
    fc.property(version, (v) => {
      assert.throws(() => parseVersion(`v${v}`));
      assert.throws(() => parseVersion(v.slice(0, v.lastIndexOf("."))));
    }),
  );
});

test("versions: every bump is strictly newer, and major > minor > patch", () => {
  fc.assert(
    fc.property(version, bump, (current, spec) => {
      const next = nextVersion(current, spec);
      assert.ok(compareVersions(next, current) > 0, `${spec} of ${current} gave ${next}`);
      assert.equal(parseVersion(next).join("."), next);
    }),
  );
  fc.assert(
    fc.property(version, (current) => {
      const [patch, minor, major] = [nextVersion(current, "patch"), nextVersion(current, "minor"), nextVersion(current, "major")];
      assert.ok(compareVersions(major, minor) > 0 && compareVersions(minor, patch) > 0);
    }),
  );
});

test("versions: planRelease never plans a \"new\" release at or below the current version", () => {
  fc.assert(
    fc.property(version, fc.oneof(bump, version), fc.func(fc.boolean()), (current, spec, tagged) => {
      let plan: ReturnType<typeof planRelease>;
      try {
        plan = planRelease(current, spec, tagged);
      } catch (err) {
        // The only refusal: an explicit version that is not newer and has not been tagged yet.
        assert.match((err as Error).message, /not newer/);
        assert.ok(compareVersions(spec, current) <= 0);
        assert.equal(tagged(spec), false);
        return;
      }
      assert.equal(plan.version, nextVersion(current, spec));
      if (plan.mode === "new") assert.ok(compareVersions(plan.version, current) > 0);
      else assert.ok(plan.mode === "resume" && tagged(plan.version));
    }),
  );
});

// ---------------------------------------------------------------- changelog (scripts/changelog.ts)
const noteLine = fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz 0123456789.,:`()'-".split("")), minLength: 1, maxLength: 60 }).map((s) => `- ${s}`);
const notes = fc.array(noteLine, { minLength: 1, maxLength: 5 }).map((ls) => ls.join("\n"));
const date = fc.tuple(fc.integer({ min: 2020, max: 2035 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 })).map(([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
const changelog = fc
  .record({
    unreleased: notes,
    prior: fc.uniqueArray(fc.tuple(version, date, notes), { maxLength: 4, selector: (t) => t[0] }),
  })
  .map(({ unreleased, prior }) => ({
    unreleased,
    prior,
    text: `# Changelog\n\n## Unreleased\n\n${unreleased}\n${prior.map(([v, d, b]) => `\n## ${v} — ${d}\n\n${b}\n`).join("")}`,
  }));

test("changelog: a release moves exactly the Unreleased notes under the version, touches nothing else, and cannot be repeated", () => {
  fc.assert(
    fc.property(changelog, version, date, (doc, v, d) => {
      fc.pre(!doc.prior.some(([pv]) => pv === v));
      const unreleased = sectionBody(doc.text, "Unreleased");
      const out = releaseChangelog(doc.text, v, d);
      assert.equal(sectionBody(out, v), unreleased);
      assert.equal(sectionBody(out, "Unreleased"), "");
      for (const [pv] of doc.prior) assert.equal(sectionBody(out, pv), sectionBody(doc.text, pv));
      assert.equal(out.split("\n").filter((l) => l.startsWith("## ")).length, doc.prior.length + 2);
      assert.ok(out.includes(`## ${v} — ${d}`));
      assert.throws(() => releaseChangelog(out, v, d), /already has/);
      assert.throws(() => releaseChangelog(out, nextVersion(v, "patch"), d), /nothing to release/);
    }),
  );
});

// ---------------------------------------------------------------- baseline (verify/baseline.ts)
const word = fc.constantFrom("type", "string", "is", "not", "assignable", "to", "number", "missing", "property", "cannot", "find", "name", "unused", "variable");
const message = fc.array(word, { minLength: 1, maxLength: 6 }).map((ws) => ws.join(" "));
const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
interface Diag {
  file: string;
  line: number;
  col: number;
  code: number;
  msg: string;
  style: "tsc" | "gcc";
}
const diag: fc.Arbitrary<Diag> = fc.record({
  file: ident.map((n) => `src/${n}.ts`),
  line: fc.nat({ max: 9999 }),
  col: fc.nat({ max: 200 }),
  code: fc.integer({ min: 1000, max: 9999 }),
  msg: message,
  style: fc.constantFrom("tsc", "gcc"),
});
const render = (d: Diag, line = d.line, col = d.col) => (d.style === "tsc" ? `${d.file}(${line},${col}): error TS${d.code}: ${d.msg}` : `${d.file}:${line}:${col}: error: ${d.msg} [E${d.code}]`);
const code = (d: Diag) => (d.style === "tsc" ? `TS${d.code}` : `E${d.code}`);
const noise = fc.constantFrom("Compiling project", "> tsc --noEmit", "Duration 1.2s", "", "ok 1 - passes", "PASS src/a.test.ts", "npm notice", "Done in 3s.", "Found 0 issues.");
const sorted = (set: DiagSet) => [...set.entries()].sort((a, b) => a[0].localeCompare(b[0]));

test("baseline: a diagnostic key ignores where and how long, but keeps the error code", () => {
  fc.assert(
    fc.property(diag, fc.nat({ max: 9999 }), fc.nat({ max: 200 }), fc.nat({ max: 99999 }), fc.nat({ max: 99999 }), (d, line2, col2, ms1, ms2) => {
      const key = normalizeDiag(render(d));
      assert.equal(normalizeDiag(render(d, line2, col2)), key);
      assert.equal(normalizeDiag(`${render(d)}   (${ms1}ms)`), normalizeDiag(`${render(d)} (${ms2}ms)`));
      assert.ok(key.includes(code(d)));
    }),
  );
  fc.assert(
    fc.property(diag, fc.integer({ min: 1000, max: 9999 }), (d, other) => {
      fc.pre(other !== d.code);
      assert.notEqual(normalizeDiag(render(d)), normalizeDiag(render({ ...d, code: other })));
    }),
  );
});

test("baseline: the project directory is stripped, so absolute and relative paths give the same key on every OS", () => {
  fc.assert(
    fc.property(ident, diag, (dir, d) => {
      const cwd = join(tmpdir(), `pp-${dir}`);
      const rel = join("src", `${dir}.ts`);
      assert.equal(normalizeDiag(render({ ...d, file: join(cwd, rel) }), cwd), normalizeDiag(render({ ...d, file: rel }), cwd));
    }),
  );
});

test("baseline: splitByBaseline is the multiset difference — every diagnostic line is either pre-existing or new, never both or neither", () => {
  // Both runs draw (with repeats) from one small pool of diagnostics, so a message can appear
  // more often, less often or equally often after the task; the later run has moved line numbers.
  const runs = fc.array(diag, { minLength: 1, maxLength: 6 }).chain((pool) => {
    const picks = fc.array(fc.nat({ max: pool.length - 1 }), { maxLength: 12 });
    return fc.tuple(fc.constant(pool), picks, picks);
  });
  fc.assert(
    fc.property(runs, fc.array(noise, { maxLength: 5 }), ([pool, first, second], extra) => {
      const a = analyzeDiagnostics([...first.map((i) => render(pool[i]!)), ...extra].join("\n"));
      const b = analyzeDiagnostics([...extra, ...second.map((i, n) => render(pool[i]!, pool[i]!.line + n + 1, pool[i]!.col))].join("\n"));
      const { preexisting, newKeys } = splitByBaseline(b, a.keys);
      // every rendered diagnostic is recognised exactly once, no noise line is
      assert.equal(a.lines.length, first.length);
      assert.equal(b.lines.length, second.length);
      for (const k of newKeys.keys()) assert.ok(b.keys.has(k), "new keys come from the later run");
      if (b.lines.length === 0) {
        // unrecognised output: new unless the fingerprint was already known
        assert.equal(preexisting.size, 0);
        for (const [k, n] of b.keys) assert.equal(newKeys.get(k) ?? 0, a.keys.has(k) ? 0 : n);
        return;
      }
      let known = 0;
      for (const [k, n] of b.keys) {
        const was = a.keys.get(k) ?? 0;
        assert.equal(newKeys.get(k) ?? 0, Math.max(0, n - was), `new count for ${k}`);
        known += Math.min(was, n);
      }
      assert.equal(preexisting.size, known);
      assert.equal(preexisting.size + diagCount(newKeys), b.lines.length);
      for (const i of preexisting) assert.ok(b.lines.some((l) => l.index === i));
      // counted independently of analyzeDiagnostics: a message that occurs more often than
      // before is new exactly that many times, wherever it moved to
      const key = (i: number) => normalizeDiag(render(pool[i]!));
      const occurrences = (picks: number[], k: string) => picks.filter((p) => key(p) === k).length;
      for (const k of new Set(pool.map((_, i) => key(i)))) assert.equal(newKeys.get(k) ?? 0, Math.max(0, occurrences(second, k) - occurrences(first, k)));
    }),
  );
});

test("baseline: output order, CRLF line endings and trailing whitespace never create a new failure", () => {
  fc.assert(
    fc.property(
      fc.array(fc.oneof(diag.map((d) => render(d)), noise), { minLength: 1, maxLength: 20 }).chain((ls) => fc.tuple(fc.constant(ls), fc.shuffledSubarray(ls, { minLength: ls.length }))),
      ([lines, shuffled]) => {
        const a = analyzeDiagnostics(lines.join("\n"));
        fc.pre(a.lines.length > 0);
        const variants = [shuffled.join("\n"), lines.join("\r\n"), lines.map((l) => `${l}  `).join("\n"), `${lines.join("\n")}\n\n`];
        for (const v of variants) {
          const b = analyzeDiagnostics(v);
          assert.deepEqual(sorted(b.keys), sorted(a.keys));
          assert.equal(diagCount(splitByBaseline(b, a.keys).newKeys), 0);
        }
      },
    ),
  );
});

test("baseline: output without recognisable diagnostics is one fingerprint — the same output again is never new", () => {
  fc.assert(
    fc.property(fc.array(noise, { minLength: 1, maxLength: 15 }), (lines) => {
      const text = lines.join("\n");
      const a = analyzeDiagnostics(text);
      fc.pre(a.lines.length === 0);
      if (text.trim() === "") {
        assert.equal(a.keys.size, 0);
        return;
      }
      assert.equal(a.keys.size, 1);
      assert.ok([...a.keys.keys()][0]!.startsWith("tail:"));
      assert.equal(diagCount(splitByBaseline(analyzeDiagnostics(text), a.keys).newKeys), 0);
    }),
  );
});

// ---------------------------------------------------------------- findings (verify/findings.ts)
// Alphabets without vowels, x or 0: the token can never spell a placeholder (EXAMPLE, xxxxxx, 00000000, dummy, fake, …).
const UP = "BCDFGHJKLMNPQRSTVWZ123456789";
const MIX = `${UP}${"bcdfghjklmnpqrstvwz"}`;
const chars = (alphabet: string, min: number, max = min + 8) => fc.string({ unit: fc.constantFrom(...alphabet.split("")), minLength: min, maxLength: max });
const secret = fc.oneof(
  chars(`${MIX}_-`, 32).map((b) => `sk-ant-${b}`),
  chars(UP, 16, 16).map((b) => `AKIA${b}`),
  chars(MIX, 36).map((b) => `ghp_${b}`),
  chars(`${MIX}_`, 50).map((b) => `github_pat_${b}`),
  chars(`${MIX}_-`, 40).map((b) => `sk-proj-${b}`),
  chars(`${MIX}-`, 12).map((b) => `xoxb-${b}`),
  chars(MIX, 24).map((b) => `sk_live_${b}`),
  chars(`${MIX}_`, 35, 35).map((b) => `AIza${b}`),
  chars(MIX, 36, 36).map((b) => `npm_${b}`),
  chars(MIX, 34).map((b) => `hf_${b}`),
);

test("findings: a secret written by the agent is always reported, must be fixed, and its value is never echoed", () => {
  const root = mkdtempSync(join(tmpdir(), "pp-prop-"));
  mkdirSync(join(root, "src"));
  const file = join(root, "src", "config.ts");
  try {
    fc.assert(
      fc.property(secret, fc.constantFrom("const key = ", "export const TOKEN=", "  apiKey: ", "process.env.KEY ??= "), (token, prefix) => {
        writeFileSync(file, `${prefix}"${token}";\n`);
        const findings = collectFindings({ root, files: [file], before: () => null });
        const secrets = findings.filter((f) => f.kind === "secret");
        assert.ok(secrets.length >= 1, `no secret finding for ${token.slice(0, 6)}…`);
        for (const f of findings) {
          assert.ok(mustFix(f));
          const text = `${formatFinding(f)} ${f.sample ?? ""} ${f.what} ${f.file}`;
          assert.ok(!text.includes(token));
          // only the first 4 characters may be shown
          for (let i = 1; i + 8 <= token.length; i++) assert.ok(!text.includes(token.slice(i, i + 8)), `leaked ${token.slice(i, i + 8)} in: ${text}`);
          assert.equal(f.file, "src/config.ts");
        }
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- render (profile/render.ts)
const token = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
const root = join(tmpdir(), "pp-prop-repo");
const check: fc.Arbitrary<Check> = fc.record({
  id: token,
  tier: fc.constantFrom<Tier>("syntax", "fast", "lint", "test", "build"),
  label: token,
  cmd: token,
  argv: fc.constant([]),
  cwd: fc.constant(root),
  source: token,
  scope: fc.option(fc.constant({ kind: "vitest" as const }), { nil: undefined }),
});
const instructionFile = fc.record({
  path: fc.constantFrom(".cursorrules", "CLAUDE.md", "docs/AGENTS.md", ".github/copilot-instructions.md", "GEMINI.md"),
  bytes: fc.nat({ max: 50_000 }),
  loadedByPi: fc.boolean(),
  content: fc.option(fc.string({ maxLength: 80 }), { nil: undefined }),
});
const commandKey = fc.constantFrom("install", "typecheck", "lint", "test", "test:one", "build", "format", "dev", "generate");
const commands = fc.dictionary(commandKey, fc.record({ cmd: token, source: token }), { maxKeys: 6 });
const detected: fc.Arbitrary<DetectedProfile> = fc.record({
  version: fc.nat({ max: 99 }),
  root: fc.constant(root),
  name: fc.option(token, { nil: undefined }),
  remote: fc.option(token.map((t) => `github.com/${t}/${t}`), { nil: undefined }),
  trackedFiles: fc.option(fc.nat({ max: 100_000 }), { nil: undefined }),
  languages: fc.array(token, { maxLength: 4 }),
  stack: fc.array(token, { maxLength: 25 }),
  runtimes: fc.dictionary(token, token, { maxKeys: 3 }),
  commands,
  checks: fc.array(check, { maxLength: 6 }),
  instructionFiles: fc.uniqueArray(instructionFile, { maxLength: 5, selector: (f) => f.path }),
  ci: fc.option(fc.record({ provider: token, files: fc.array(token, { maxLength: 7 }), runs: fc.array(token, { maxLength: 8 }) }), { nil: undefined }),
  conventions: fc.array(token, { maxLength: 15 }),
  layout: fc.array(token, { maxLength: 4 }),
  services: fc.array(token, { maxLength: 4 }),
  notes: fc.array(token, { maxLength: 14 }),
  tests: fc.option(token, { nil: undefined }),
  generated: fc.option(fc.array(token, { maxLength: 8 }), { nil: undefined }),
  fingerprint: fc.dictionary(token, fc.stringMatching(/^[0-9a-f]{8}$/), { maxKeys: 4 }),
});
const stored = (d: DetectedProfile, updatedAt = ""): StoredProfile => ({ detected: d, user: emptyUserData(), updatedAt });
const section = (s: StoredProfile, loaded: string[] = []) => renderPromptSection(s, DEFAULT_CONFIG, { verifyEnabled: true, piLoadedContextFiles: loaded });

test("render: the prompt section does not depend on volatile fields (timestamps, fingerprints, detector version)", () => {
  fc.assert(
    fc.property(detected, fc.string({ maxLength: 30 }), fc.string({ maxLength: 30 }), fc.dictionary(token, token, { maxKeys: 4 }), fc.nat({ max: 99 }), (d, t1, t2, fp, ver) => {
      const a = section(stored(d, t1));
      const b = section(stored({ ...d, fingerprint: fp, version: ver }, t2));
      assert.equal(a, b);
      assert.equal(a, section(stored(structuredClone(d), t1)));
    }),
  );
});

test("render: π's loaded-file list marks files as (loaded) the same way whatever its order or path separators, and never inlines them", () => {
  fc.assert(
    fc.property(detected, fc.constantFrom("/home/u/work/repo", "C:\\work\\repo", "/tmp/x"), fc.nat({ max: 1000 }), (d, prefix, seed) => {
      const paths = d.instructionFiles.map((f) => f.path);
      const posix = paths.map((p) => `${prefix.replace(/\\/g, "/")}/${p}`);
      const windows = posix.map((p) => p.replace(/\//g, "\\"));
      const shuffled = [...posix].sort((x, y) => ((seed * 31 + x.length) % 7) - ((seed * 31 + y.length) % 7));
      const s = stored(d);
      const out = section(s, posix);
      assert.equal(section(s, windows), out);
      assert.equal(section(s, shuffled), out);
      for (const f of d.instructionFiles) {
        assert.ok(out.includes(`${f.path} (loaded)`), `${f.path} marked loaded`);
        if (f.content !== undefined) assert.ok(!out.includes(`### ${f.path}`), "a file π already loaded is not inlined again");
      }
    }),
  );
});

test("render: user overrides replace or remove detected commands, and the section shows the override", () => {
  fc.assert(
    fc.property(detected, fc.dictionary(commandKey, fc.option(token, { nil: null }), { maxKeys: 5 }), (d, overrides) => {
      const s: StoredProfile = { detected: d, user: { ...emptyUserData(), overrides }, updatedAt: "" };
      const eff = effectiveCommands(s);
      const out = section(s);
      for (const k of new Set([...Object.keys(d.commands), ...Object.keys(overrides)])) {
        if (!(k in overrides)) assert.deepEqual(eff[k], d.commands[k]);
        else if (overrides[k] === null) assert.ok(!(k in eff), `${k} disabled`);
        else {
          assert.deepEqual(eff[k], { cmd: overrides[k], source: "user override" });
          assert.ok(out.includes(`${k.replace(":", " ")} \`${overrides[k]}\``));
        }
      }
    }),
  );
});
