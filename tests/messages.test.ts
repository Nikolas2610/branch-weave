import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMessage, matchesDraftTarget } from "../src/messages";
test("webview protocol rejects unknown commands and invalid edit payloads", () => {
  assert.equal(
    validateMessage({ type: "action", action: "executeAnything" }),
    false,
  );
  assert.equal(
    validateMessage({
      type: "draft",
      action: "edit",
      side: "left",
      text: "hello",
      version: 0,
      sessionId: "session",
      index: 0,
    }),
    true,
  );
  assert.equal(
    validateMessage({
      type: "draft",
      action: "edit",
      side: "outside",
      text: "hello",
      version: 0,
    }),
    false,
  );
  assert.equal(
    validateMessage({
      type: "draft",
      action: "transferHunk",
      side: "left",
      hunk: -1,
      version: 0,
    }),
    false,
  );
  assert.equal(
    validateMessage({ type: "action", action: "open", value: "../../evil" }),
    false,
  );
  assert.equal(
    validateMessage({
      type: "draft",
      action: "edit",
      side: "left",
      text: "x".repeat(2_100_000),
      version: 0,
    }),
    false,
  );
  assert.equal(
    validateMessage({ type: "action", action: "highlight", value: true }),
    true,
  );
});
test("edits from a previous file or session cannot target a draft with the same version", () => {
  const m = { sessionId: "one", index: 0, version: 0 };
  assert.equal(matchesDraftTarget(m, "one", 0, 0), true);
  assert.equal(matchesDraftTarget(m, "one", 1, 0), false);
  assert.equal(matchesDraftTarget(m, "two", 0, 0), false);
  assert.equal(matchesDraftTarget(m, "one", 0, 1), false);
});
test("live file identity survives changed-file list reordering without accepting another file", () => {
  const m = { sessionId: "live", index: 0, version: 4, fileKey: "a.ts" };
  assert.equal(matchesDraftTarget(m, "live", 2, 4, "a.ts"), true);
  assert.equal(matchesDraftTarget(m, "live", 0, 4, "b.ts"), false);
  assert.equal(matchesDraftTarget(m, "next", 2, 4, "a.ts"), false);
});
