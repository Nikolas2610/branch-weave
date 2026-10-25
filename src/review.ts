import { createHash, randomUUID } from "node:crypto";
import type { DraftContent, Hunk } from "./draft";
import type {
  ComparisonPreset,
  ReviewNoteView,
  ReviewView,
} from "./workflowTypes";

export interface ReviewSnapshot {
  left: DraftContent;
  right: DraftContent;
  hunks: Hunk[];
}
interface Note {
  id: string;
  text: string;
  fingerprint: string;
  token?: string;
  hunk?: number;
}
interface Entry {
  fingerprint?: string;
  hunks: string[];
  notes: Note[];
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hashPattern = /^[a-f0-9]{64}$/;
const tokens = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const escape = (text: string) =>
  text.replace(/[\\`*_[\]<>#|]/g, "\\$&").replace(/[\r\n]/g, " ");

export function snapshotFingerprint(
  snapshot: Pick<ReviewSnapshot, "left" | "right">,
): string {
  return digest([
    snapshot.left.path,
    snapshot.left.exists,
    snapshot.left.mode || "100644",
    snapshot.left.text,
    snapshot.right.path,
    snapshot.right.exists,
    snapshot.right.mode || "100644",
    snapshot.right.text,
  ]);
}

function hunkTokens(snapshot: ReviewSnapshot): string[] {
  const left = tokens(snapshot.left.text),
    right = tokens(snapshot.right.text),
    occurrences = new Map<string, number>();
  const signatures = snapshot.hunks.map((h) =>
    digest([
      snapshot.left.path,
      snapshot.right.path,
      snapshot.left.exists,
      snapshot.right.exists,
      left.slice(Math.max(0, h.leftStart - 2), h.leftStart + h.leftCount + 2),
      right.slice(
        Math.max(0, h.rightStart - 2),
        h.rightStart + h.rightCount + 2,
      ),
      h.leftCount,
      h.rightCount,
    ]),
  );
  const counts = new Map<string, number>();
  for (const signature of signatures)
    counts.set(signature, (counts.get(signature) || 0) + 1);
  const fileFingerprint = signatures.some(
    (signature) => counts.get(signature)! > 1,
  )
    ? snapshotFingerprint(snapshot)
    : undefined;
  return signatures.map((signature) => {
    const occurrence = occurrences.get(signature) || 0;
    occurrences.set(signature, occurrence + 1);
    return digest([
      signature,
      occurrence,
      counts.get(signature)! > 1 ? fileFingerprint : undefined,
    ]);
  });
}

export class ReviewStore {
  private entries = new Map<string, Entry>();
  constructor(value?: unknown) {
    const saved = value as { schema?: number; entries?: unknown[] } | undefined;
    if (saved?.schema !== 1 || !Array.isArray(saved.entries)) return;
    for (const item of saved.entries.slice(-500)) {
      if (
        !Array.isArray(item) ||
        typeof item[0] !== "string" ||
        !item[0] ||
        item[0].length > 4096
      )
        continue;
      const entry = item[1] as Partial<Entry> | undefined;
      if (!entry || !Array.isArray(entry.hunks) || !Array.isArray(entry.notes))
        continue;
      this.entries.set(item[0], {
        fingerprint:
          typeof entry.fingerprint === "string" &&
          hashPattern.test(entry.fingerprint)
            ? entry.fingerprint
            : undefined,
        hunks: entry.hunks
          .filter((h) => typeof h === "string" && hashPattern.test(h))
          .slice(0, 1000),
        notes: entry.notes
          .filter(
            (n) =>
              n &&
              typeof n.id === "string" &&
              n.id.length <= 80 &&
              typeof n.text === "string" &&
              n.text.length <= 4000 &&
              typeof n.fingerprint === "string" &&
              hashPattern.test(n.fingerprint) &&
              (n.token === undefined || hashPattern.test(n.token)) &&
              (n.hunk === undefined ||
                (Number.isInteger(n.hunk) && n.hunk >= 0)),
          )
          .slice(0, 100)
          .map((n) => ({ ...n })),
      });
    }
  }
  private entry(key: string): Entry {
    if (!key || key.length > 4096 || key.includes("\0"))
      throw new Error("Invalid review file identity.");
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 500)
        throw new Error(
          "Review storage has reached the 500-file limit. Export and remove old notes before adding more files.",
        );
      entry = { hunks: [], notes: [] };
      this.entries.set(key, entry);
    }
    return entry;
  }
  hasReviewed(key: string): boolean {
    return !!this.entries.get(key)?.fingerprint;
  }
  matchesFile(key: string, fingerprint: string): boolean {
    return this.entries.get(key)?.fingerprint === fingerprint;
  }
  inspect(key: string, snapshot: ReviewSnapshot): ReviewView {
    const entry = this.entries.get(key),
      current = hunkTokens(snapshot),
      fingerprint = snapshotFingerprint(snapshot);
    const reviewedHunks = current.flatMap((token, index) =>
      entry?.hunks.includes(token) ? [index] : [],
    );
    const notes: ReviewNoteView[] = (entry?.notes || []).map((note) => {
      const index = note.token ? current.indexOf(note.token) : -1;
      return {
        id: note.id,
        text: note.text,
        hunk: index >= 0 ? index : note.hunk,
        stale: note.token ? index < 0 : note.fingerprint !== fingerprint,
      };
    });
    return {
      reviewed: entry?.fingerprint === fingerprint,
      reviewedHunks,
      totalHunks: current.length,
      notes,
      filesReviewed: 0,
      totalFiles: 0,
    };
  }
  markFile(key: string, snapshot: ReviewSnapshot, reviewed: boolean): void {
    const entry = this.entry(key);
    entry.fingerprint = reviewed ? snapshotFingerprint(snapshot) : undefined;
    entry.hunks = reviewed ? hunkTokens(snapshot) : [];
    if (!entry.fingerprint && !entry.hunks.length && !entry.notes.length)
      this.entries.delete(key);
  }
  markHunk(
    key: string,
    snapshot: ReviewSnapshot,
    index: number,
    reviewed: boolean,
  ): void {
    const current = hunkTokens(snapshot);
    if (!Number.isInteger(index) || !current[index])
      throw new Error("The selected review section no longer exists.");
    const entry = this.entry(key),
      marks = new Set(entry.hunks);
    if (reviewed) marks.add(current[index]);
    else marks.delete(current[index]);
    entry.hunks = [...marks].slice(-1000);
    entry.fingerprint = current.every((token) => marks.has(token))
      ? snapshotFingerprint(snapshot)
      : undefined;
    if (!entry.fingerprint && !entry.hunks.length && !entry.notes.length)
      this.entries.delete(key);
  }
  addNote(
    key: string,
    snapshot: ReviewSnapshot,
    text: string,
    hunk?: number,
  ): ReviewNoteView {
    if (typeof text !== "string" || !text.trim() || text.length > 4000)
      throw new Error("Enter a note between 1 and 4000 characters.");
    const current = hunkTokens(snapshot);
    if (hunk !== undefined && (!Number.isInteger(hunk) || !current[hunk]))
      throw new Error("The selected note section no longer exists.");
    const entry = this.entry(key);
    if (entry.notes.length >= 100)
      throw new Error(
        "This file has reached the 100-note limit. Export or remove notes first.",
      );
    const note: Note = {
      id: randomUUID(),
      text: text.trim(),
      fingerprint: snapshotFingerprint(snapshot),
      hunk,
      token: hunk === undefined ? undefined : current[hunk],
    };
    entry.notes.push(note);
    return { id: note.id, text: note.text, hunk, stale: false };
  }
  deleteNote(key: string, id: string): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.notes = entry.notes.filter((note) => note.id !== id);
      if (!entry.fingerprint && !entry.hunks.length && !entry.notes.length)
        this.entries.delete(key);
    }
  }
  storedNotes(): { key: string; notes: ReviewNoteView[] }[] {
    return [...this.entries]
      .filter(([, entry]) => entry.notes.length)
      .map(([key, entry]) => ({
        key,
        notes: entry.notes.map((note) => ({
          id: note.id,
          text: note.text,
          hunk: note.hunk,
          stale: true,
        })),
      }));
  }
  serialize(): unknown {
    return { schema: 1, entries: structuredClone([...this.entries]) };
  }
}

export function exportReviewMarkdown(data: {
  reference: string;
  current: string;
  files: { path: string; review: ReviewView }[];
  archivedNotes?: { path: string; notes: ReviewNoteView[] }[];
}): string {
  const done = data.files.filter((f) => f.review.reviewed).length;
  const output = [
    "# BranchWeave review",
    "",
    `Reference: ${escape(data.reference)}`,
    `Current branch: ${escape(data.current)}`,
    "",
    `Reviewed: ${done} of ${data.files.length} files`,
    "",
  ];
  for (const file of data.files) {
    output.push(
      `## ${escape(file.path)}`,
      "",
      `- [${file.review.reviewed ? "x" : " "}] File reviewed`,
      `- Sections reviewed: ${file.review.reviewedHunks.length} of ${file.review.totalHunks}`,
      "",
    );
    for (const note of file.review.notes)
      output.push(
        `### ${note.hunk === undefined ? "File note" : `Section ${note.hunk + 1} note`}${note.stale ? " (anchor changed)" : ""}`,
        "",
        ...note.text.split(/\r?\n/).map((line) => `> ${line}`),
        "",
      );
  }
  if (data.archivedNotes?.length) {
    output.push(
      "## Notes outside the current changed files",
      "",
      "These saved notes are retained; their anchors are not verified in this comparison.",
      "",
    );
    for (const file of data.archivedNotes) {
      output.push(`### ${escape(file.path)}`, "");
      for (const note of file.notes)
        output.push(...note.text.split(/\r?\n/).map((line) => `> ${line}`), "");
    }
  }
  return output.join("\n");
}

const presetFields = (value: Record<string, unknown>) => ({
  left: typeof value.left === "string" ? value.left : "",
  includeUpstream: value.includeUpstream === true,
  highlight: value.highlight !== false,
  flat: value.flat === true,
  focusMode: value.focusMode === true,
  ignoreWhitespace: value.ignoreWhitespace === true,
  filter: typeof value.filter === "string" ? value.filter.slice(0, 512) : "",
});
function validPreset(value: Pick<ComparisonPreset, "name" | "left">): boolean {
  return (
    !!value.name.trim() &&
    value.name.length <= 80 &&
    !!value.left &&
    value.left.length <= 256 &&
    !value.left.startsWith("-") &&
    !/[\0\r\n]/.test(value.left)
  );
}
export class PresetStore {
  private presets: ComparisonPreset[] = [];
  constructor(value?: unknown) {
    if (!Array.isArray(value)) return;
    for (const raw of value.slice(0, 30)) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.id !== "string" ||
        raw.id.length > 80 ||
        typeof raw.name !== "string"
      )
        continue;
      const preset = { id: raw.id, name: raw.name, ...presetFields(raw) };
      if (validPreset(preset) && !this.presets.some((p) => p.id === preset.id))
        this.presets.push(preset);
    }
  }
  list(): ComparisonPreset[] {
    return this.presets.map((p) => ({ ...p }));
  }
  save(name: string, settings: Record<string, unknown>): ComparisonPreset {
    const previous = this.presets.find(
      (p) => p.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
    );
    const preset = {
      id: previous?.id || randomUUID(),
      name: name.trim(),
      ...presetFields(settings),
    };
    if (!validPreset(preset))
      throw new Error(
        "Enter a preset name (1–80 characters) and a valid reference branch.",
      );
    if (previous)
      this.presets = this.presets.filter((p) => p.id !== previous.id);
    else if (this.presets.length >= 30)
      throw new Error("Remove a preset before saving more than 30 presets.");
    this.presets.push(preset);
    return { ...preset };
  }
  remove(id: string): void {
    this.presets = this.presets.filter((p) => p.id !== id);
  }
  serialize(): unknown {
    return this.list();
  }
}
