import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftPair } from "../src/draft";
import {
  ReviewStore,
  snapshotFingerprint,
  exportReviewMarkdown,
  PresetStore,
} from "../src/review";

const content = (text: string) => ({
  path: "src/a.ts",
  exists: true,
  text,
  mode: "100644",
});
const pair = () =>
  new DraftPair(content("one\ncontext\ntwo\n"), content("ONE\ncontext\nTWO\n"));
const snapshot = (p: DraftPair) => ({ ...p.current, hunks: p.hunks() });

test("review state persists and exact-content changes invalidate file completion", () => {
  const p = pair(),
    s = snapshot(p),
    store = new ReviewStore();
  store.markFile("a", s, true);
  assert.equal(store.inspect("a", s).reviewed, true);
  const restored = new ReviewStore(store.serialize());
  assert.equal(restored.matchesFile("a", snapshotFingerprint(s)), true);
  p.setText("right", "ONE changed\ncontext\nTWO\n", p.version);
  assert.equal(restored.inspect("a", snapshot(p)).reviewed, false);
  assert.equal(
    restored.matchesFile("a", snapshotFingerprint(snapshot(p))),
    false,
  );
});

test("section reviews complete a file only when every current section is reviewed", () => {
  const s = snapshot(pair()),
    store = new ReviewStore();
  store.markHunk("a", s, 0, true);
  assert.deepEqual(store.inspect("a", s).reviewedHunks, [0]);
  assert.equal(store.inspect("a", s).reviewed, false);
  store.markHunk("a", s, 1, true);
  assert.equal(store.inspect("a", s).reviewed, true);
  store.markHunk("a", s, 0, false);
  assert.equal(store.inspect("a", s).reviewed, false);
  assert.throws(() => store.markHunk("a", s, 99, true));
});

test("notes retain text, expose stale anchors and survive review reset and serialization", () => {
  const p = pair(),
    s = snapshot(p),
    store = new ReviewStore();
  const note = store.addNote("a", s, "Needs a test\nsecond line", 0);
  const fileNote = store.addNote("a", s, "Check callers");
  store.markFile("a", s, false);
  assert.equal(store.inspect("a", s).notes[0].stale, false);
  p.setText("right", "different\ncontext\nTWO\n", p.version);
  const restored = new ReviewStore(store.serialize());
  assert.ok(restored.inspect("a", snapshot(p)).notes.every((n) => n.stale));
  restored.deleteNote("a", note.id);
  assert.deepEqual(
    restored.inspect("a", snapshot(p)).notes.map((n) => n.id),
    [fileNote.id],
  );
  assert.throws(() => store.addNote("a", s, " "));
  assert.throws(() => store.addNote("a", s, "x".repeat(4001)));
});

test("duplicate change sections do not share a review mark and existence/mode affect fingerprints", () => {
  const p = new DraftPair(
    content("x\na\nx\na\nx\n"),
    content("x\nb\nx\nb\nx\n"),
  );
  const s = snapshot(p),
    store = new ReviewStore();
  store.markHunk("a", s, 0, true);
  assert.deepEqual(store.inspect("a", s).reviewedHunks, [0]);
  assert.notEqual(
    snapshotFingerprint(s),
    snapshotFingerprint({ ...s, right: { ...s.right, mode: "100755" } }),
  );
  store.markFile("a", s, true);
  assert.equal(
    store.inspect("a", { ...s, right: { ...s.right, mode: "100755" } })
      .reviewed,
    false,
  );
  const changedContext = {
    ...s,
    left: { ...s.left, text: s.left.text + "more shared context\n" },
    right: { ...s.right, text: s.right.text + "more shared context\n" },
  };
  assert.equal(store.inspect("a", changedContext).reviewed, false);
});

test("review export includes progress and safely quotes paths and multiline notes", () => {
  const s = snapshot(pair()),
    store = new ReviewStore();
  store.addNote("a", s, "line one\n# note heading", 0);
  const report = exportReviewMarkdown({
    reference: "main",
    current: "feature",
    files: [{ path: "src/[a].ts", review: store.inspect("a", s) }],
  });
  assert.match(report, /0 of 1/);
  assert.match(report, /src\/\\\[a\\\]\.ts/);
  assert.match(report, /> line one\n> # note heading/);
});

test("presets are validated, immutable, restored and retain only supported comparison settings", () => {
  const store = new PresetStore();
  const saved = store.save("Feature review", {
    left: "main",
    includeUpstream: true,
    highlight: true,
    flat: false,
    focusMode: true,
    ignoreWhitespace: true,
    filter: "src/",
    right: "must-not-checkout",
  });
  assert.equal(saved.filter, "src/");
  assert.equal("right" in saved, false);
  saved.name = "mutated";
  assert.equal(store.list()[0].name, "Feature review");
  assert.deepEqual(new PresetStore(store.serialize()).list(), store.list());
  assert.throws(() => store.save(" ", { left: "main" }));
  assert.throws(() => store.save("Bad", { left: "--danger" }));
  assert.equal(
    new PresetStore([{ id: "bad", name: "bad", left: "--danger" }]).list()
      .length,
    0,
  );
  store.remove(store.list()[0].id);
  assert.equal(store.list().length, 0);
});
test("review storage never silently evicts notes and exports notes outside the current file list", () => {
  const s = snapshot(pair()),
    store = new ReviewStore();
  for (let i = 0; i < 500; i++) store.addNote("file-" + i, s, "Keep note " + i);
  assert.throws(() => store.addNote("overflow", s, "Would evict"), /limit/i);
  assert.equal(store.inspect("file-0", s).notes[0].text, "Keep note 0");
  const saved = store.storedNotes();
  assert.equal(saved.length, 500);
  saved[0].notes[0].text = "mutated";
  assert.equal(store.inspect("file-0", s).notes[0].text, "Keep note 0");
  const report = exportReviewMarkdown({
    reference: "main",
    current: "feature",
    files: [],
    archivedNotes: [
      { path: "resolved.ts", notes: store.inspect("file-0", s).notes },
    ],
  });
  assert.match(report, /0 of 0 files/);
  assert.match(report, /Notes outside the current changed files/);
  assert.match(report, /Keep note 0/);
  store.deleteNote("file-0", store.inspect("file-0", s).notes[0].id);
  assert.doesNotThrow(() =>
    store.addNote("overflow", s, "Space reclaimed without losing other notes"),
  );
});
test("ambiguous repeated section anchors expire when the surrounding file changes", () => {
  const left =
    "start\nx\nx\nx\none\nx\nx\nx\nmiddle\nx\nx\nx\none\nx\nx\nx\nend\n";
  const right = left.replaceAll("one\n", "ONE\n");
  const p = new DraftPair(content(left), content(right)),
    store = new ReviewStore();
  store.markHunk("a", snapshot(p), 0, true);
  store.addNote("a", snapshot(p), "First repeated block", 0);
  const next = new DraftPair(
    content(left + "tail\n"),
    content(right + "tail\n"),
  );
  assert.deepEqual(store.inspect("a", snapshot(next)).reviewedHunks, []);
  assert.equal(store.inspect("a", snapshot(next)).notes[0].stale, true);
});
