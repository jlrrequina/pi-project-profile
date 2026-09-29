/**
 * CHANGELOG.md helpers for the release workflow.
 *
 *   node scripts/changelog.ts release <X.Y.Z> [YYYY-MM-DD]   move "## Unreleased" to "## X.Y.Z — date"
 *   node scripts/changelog.ts notes <X.Y.Z>                  print that version's section
 *
 * Entries accumulate under "## Unreleased"; a release turns that heading into
 * the version and leaves a fresh, empty "## Unreleased" above it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const UNRELEASED = "## Unreleased";

/** Body of a "## <title…>" section (without its heading), or undefined when absent. */
export function sectionBody(text: string, title: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `## ${title}` || l.startsWith(`## ${title} `));
  if (start === -1) return undefined;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Turn "## Unreleased" into "## <version> — <date>" and add a new empty "## Unreleased" above it. */
export function releaseChangelog(text: string, version: string, date: string): string {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  if (sectionBody(text, version) !== undefined) throw new Error(`CHANGELOG.md already has a "## ${version}" section`);
  const body = sectionBody(text, "Unreleased");
  if (body === undefined) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`);
  if (!body) throw new Error(`nothing to release: "${UNRELEASED}" in CHANGELOG.md is empty`);
  return text.replace(/^## Unreleased[^\n]*$/m, `${UNRELEASED}\n\n## ${version} — ${date}`);
}

const [, , cmd, version, date] = process.argv;
if (cmd && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const text = readFileSync("CHANGELOG.md", "utf8");
    if (cmd === "release" && version) {
      writeFileSync("CHANGELOG.md", releaseChangelog(text, version, date ?? new Date().toISOString().slice(0, 10)));
    } else if (cmd === "notes" && version) {
      const body = sectionBody(text, version);
      if (!body) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
      process.stdout.write(body + "\n");
    } else {
      console.error("usage: changelog.ts release <X.Y.Z> [YYYY-MM-DD] | notes <X.Y.Z>");
      process.exit(2);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
