/**
 * Notes are the extension's memory: what the user or the agent worked out about a project and
 * that its files do not show. The detected profile is re-read from the repository every session,
 * so it needs no memory; a note persists until someone removes it, so it carries who wrote it,
 * when, and how they knew (`Note` in types.ts).
 *
 * Memory is a prediction that a future session will rely on the note without checking it. Two
 * things keep that prediction honest without a model call:
 *  - the prompt shows notes within a character budget and points at the rest instead of dropping it;
 *  - the sleep pass at session start validates each note against the repository (paths it names
 *    that no longer exist) and each override against fresh detection (an override that detection
 *    now reproduces). Findings are flagged, never deleted: the user or a `/profile dream` decides.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { clampText, sha1 } from "../fs-utils.ts";
import type { Note, StoredProfile } from "../types.ts";

export const MAX_NOTE_CHARS = 300;
export const MAX_EVIDENCE_CHARS = 200;
/** Agent-written notes per repository. Beyond it the agent must merge or remove before it adds. */
export const MAX_AGENT_NOTES = 25;

function noteId(seed: string): string {
  return sha1(seed).slice(0, 6);
}

/** Notes stored before 1.5 were plain strings: read them as user notes with a deterministic id (the file is rewritten on the next save). */
export function migrateNotes(raw: unknown): Note[] {
  if (!Array.isArray(raw)) return [];
  const out: Note[] = [];
  raw.forEach((n: unknown, i: number) => {
    if (typeof n === "string") {
      if (n.trim()) out.push({ id: noteId(`legacy|${i}|${n}`), text: n, by: "user" });
      return;
    }
    if (!n || typeof n !== "object") return;
    const o = n as Record<string, unknown>;
    if (typeof o.text !== "string" || !o.text.trim()) return;
    const note: Note = { id: typeof o.id === "string" && o.id ? o.id : noteId(`legacy|${i}|${o.text}`), text: o.text, by: o.by === "agent" ? "agent" : "user" };
    if (typeof o.at === "string" && o.at) note.at = o.at;
    if (typeof o.evidence === "string" && o.evidence) note.evidence = o.evidence;
    out.push(note);
  });
  return out;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A new note with an id that no existing note has. Text and evidence are trimmed and clamped. */
export function makeNote(existing: Note[], by: Note["by"], text: string, evidence?: string, at = today()): Note {
  const t = clampText(text.trim().replace(/\s+/g, " "), MAX_NOTE_CHARS);
  const ids = new Set(existing.map((n) => n.id));
  let id = noteId(`${at}|${t}`);
  for (let i = 0; ids.has(id); i++) id = noteId(`${at}|${t}|${i}`);
  const note: Note = { id, text: t, by, at };
  const e = evidence?.trim().replace(/\s+/g, " ");
  if (e) note.evidence = clampText(e, MAX_EVIDENCE_CHARS);
  return note;
}

/** A note by 1-based position or id. */
export function findNote(notes: Note[], ref: string): Note | undefined {
  const r = ref.trim();
  if (/^\d+$/.test(r)) return notes[Number(r) - 1];
  return notes.find((n) => n.id === r);
}

/** The same note already exists (same text, whitespace- and case-insensitive). */
export function duplicateOf(notes: Note[], text: string): Note | undefined {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const t = norm(text);
  return notes.find((n) => norm(n.text) === t);
}

/** One note as the prompt shows it: author and id (the `forget_note` tool takes the id), text, evidence, stale flag. */
export function formatNote(n: Note, stale?: string): string {
  let s = `(${n.by} ${n.id}) ${n.text}`;
  if (n.evidence) s += ` — evidence: ${n.evidence}`;
  if (stale) s += ` [may be stale: ${stale}]`;
  return s;
}

/**
 * Notes for the prompt within a character budget. The top layer of memory must stay small, so
 * what does not fit is counted and referenced by path, never silently dropped.
 */
export function renderNotes(notes: Note[], stale: Map<string, string>, budget: number, notesPath: string | undefined): string[] {
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  for (const n of notes) {
    const s = formatNote(n, stale.get(n.id));
    if (shown > 0 && used + s.length > budget) break;
    out.push(s);
    used += s.length;
    shown++;
  }
  const rest = notes.length - shown;
  if (rest > 0) out.push(`(+${rest} more note${rest === 1 ? "" : "s"}${notesPath ? ` in \`${notesPath}\` under user.notes` : ""})`);
  return out;
}

/** Path-like backticked tokens of a note: one `/` at least, no spaces, globs, URLs, placeholders or versions. */
export function pathTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1]!.trim();
    if (!tok.includes("/") || /[\s*?<>|$~:]|:\/\//.test(tok) || /^-/.test(tok) || /@\d/.test(tok)) continue;
    if (!/^(?:\.{0,2}\/)?[\w@.+()[\]-]+(?:\/[\w@.+()[\]-]+)*\/?$/.test(tok)) continue;
    out.push(tok.replace(/\/$/, ""));
  }
  return out;
}

/**
 * Sleep pass over the notes: a note that names a path that no longer exists under the project or
 * the git root may be stale. Returns note id → reason. Only certain checks: a wrong flag costs trust.
 */
export function validateNotes(notes: Note[], roots: string[]): Map<string, string> {
  const stale = new Map<string, string>();
  for (const n of notes) {
    const missing = pathTokens(n.text).filter((tok) => {
      if (isAbsolute(tok)) return !existsSync(tok);
      const rel = tok.replace(/^\.\//, "");
      return !roots.some((r) => existsSync(join(r, rel)));
    });
    if (missing.length) stale.set(n.id, `${missing.map((m) => `\`${m}\``).join(", ")} ${missing.length === 1 ? "does" : "do"} not exist`);
  }
  return stale;
}

/** Overrides that fresh detection reproduces: the memory of a correction that the repository no longer needs. */
export function redundantOverrides(stored: StoredProfile): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(stored.user.overrides)) {
    if (v !== null && stored.detected.commands[k]?.cmd === v) out.push(k);
  }
  return out.sort();
}

/** Human listing for `/profile notes` and the dream message. */
export function listNotes(notes: Note[], stale: Map<string, string>): string[] {
  return notes.map((n, i) => {
    const when = n.at ? `, ${n.at}` : "";
    let line = `${i + 1}. [${n.id}] (${n.by}${when}) ${n.text}`;
    if (n.evidence) line += ` — evidence: ${n.evidence}`;
    const s = stale.get(n.id);
    if (s) line += `\n   ⚠ may be stale: ${s}`;
    return line;
  });
}
