import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/basic-languages/monaco.contribution.js";
import { iconButton, toolbarGroup, type ToolbarIcon } from "./toolbar";
import { normalizeThemeColor } from "./colors";
import { createWorkflow } from "./workflow";
declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
(globalThis as any).MonacoEnvironment = {
  getWorker: () => new Worker(document.body.dataset.worker!),
};
const el = (id: string) => document.getElementById(id)!;
let state: any;
let version = 0;
let acknowledged = 0;
let updating = false;
let currentHunk = 0;
let focus: "left" | "right" = "right";
let key = "";
// Monaco can emit nested auto-close events for the same final model text.
// Revisions track distinct outgoing snapshots, not editor event counts.
const outgoingText: Partial<Record<"left" | "right", string>> = {};
const diff = monaco.editor.createDiffEditor(el("editor"), {
  automaticLayout: true,
  renderSideBySide: true,
  useInlineViewWhenSpaceIsLimited: false,
  originalEditable: true,
  readOnly: false,
  ignoreTrimWhitespace: false,
  renderOverviewRuler: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  lineNumbers: "on",
  diffWordWrap: "off",
  accessibilityVerbose: false,
  originalAriaLabel: "Reference branch draft, editable",
  modifiedAriaLabel:
    "Current branch working file, editable; Save writes to disk",
  renderMarginRevertIcon: false,
});
diff
  .getOriginalEditor()
  .updateOptions({ ariaLabel: "Reference branch draft, editable" });
diff.getModifiedEditor().updateOptions({
  ariaLabel: "Current branch working file, editable; Save writes to disk",
});
const islands = {
  left: diff.getOriginalEditor().createDecorationsCollection(),
  right: diff.getModifiedEditor().createDecorationsCollection(),
};
const footer = document.querySelector("footer span");
if (footer)
  footer.textContent =
    "Right edits update working files; Save writes them to disk. Left edits are reference drafts.";
let models:
  | { left: monaco.editor.ITextModel; right: monaco.editor.ITextModel }
  | undefined;
function post(action: string, value?: unknown) {
  api.postMessage({
    type: "action",
    action,
    value,
    version,
    sessionId: state?.sessionId,
    index: state?.index,
    fileKey: state?.fileKey,
  });
}
const files = toolbarGroup(el("navigation"), "File navigation");
const changes = toolbarGroup(el("navigation"), "Change navigation");
const history = toolbarGroup(el("navigation"), "Draft history");
function addButton(
  parent: HTMLElement,
  icon: ToolbarIcon,
  label: string,
  description: string,
  action: string,
  value?: unknown,
) {
  iconButton(parent, icon, label, description, () => dispatch(action, value));
}
addButton(
  files,
  "previousFile",
  "Previous changed file",
  "Previous changed file · Alt+Shift+PageUp",
  "previousFile",
);
addButton(
  files,
  "nextFile",
  "Next changed file",
  "Next changed file · Alt+Shift+PageDown",
  "nextFile",
);
addButton(
  changes,
  "previousHunk",
  "Previous change section",
  "Previous change section · Alt+Shift+Up",
  "previousHunk",
);
addButton(
  changes,
  "nextHunk",
  "Next change section",
  "Next change section · Alt+Shift+Down",
  "nextHunk",
);
addButton(
  history,
  "undo",
  "Undo draft edit",
  "Undo draft edit · Ctrl/Cmd+Z",
  "undo",
);
addButton(
  history,
  "redo",
  "Redo draft edit",
  "Redo draft edit · Ctrl/Cmd+Shift+Z",
  "redo",
);
for (const side of ["left", "right"] as const) {
  const name = side === "left" ? "Left" : "Right";
  const tools = toolbarGroup(
    el("navigation"),
    side === "left"
      ? "Reference draft actions"
      : "Current working file actions",
    name,
  );
  if (side === "right")
    addButton(
      tools,
      "save",
      "Save current file",
      "Save the current working file to disk · Ctrl/Cmd+S",
      "save",
    );
  addButton(
    tools,
    "reset",
    side === "left" ? "Reset reference draft" : "Reset current file edits",
    side === "left"
      ? "Reset the reference draft to its comparison snapshot"
      : "Reset the current working file to its comparison snapshot (does not Save)",
    "reset",
    side,
  );
  addButton(
    tools,
    "fileOperation",
    side === "left"
      ? "Reference draft file operations"
      : "Current working file operations",
    side === "left"
      ? "Create, delete or rename the reference draft file"
      : "Create, delete or rename the current working file",
    "fileOperation",
    side,
  );
  addButton(
    tools,
    "export",
    `Export ${side} patch`,
    side === "left"
      ? "Export the reference draft as a Git patch"
      : "Export the current working file as a Git patch",
    "export",
    side,
  );
  if (side === "left")
    addButton(
      tools,
      "apply",
      "Apply reference draft",
      "Apply the reference draft to a verified working tree (does not Save)",
      "apply",
      side,
    );
  const transfers = toolbarGroup(
    el("transfers"),
    side === "left" ? "Copy Left to Right" : "Copy Right to Left",
  );
  const direction = side === "left" ? "Left to Right" : "Right to Left";
  addButton(
    transfers,
    side === "left" ? "transferLineLeft" : "transferLineRight",
    `Copy selected line ${direction}`,
    `Copy selected changed line ${direction} · Alt+Shift+${side === "left" ? "Right" : "Left"}`,
    "transferLine",
    side,
  );
  addButton(
    transfers,
    side === "left" ? "transferHunkLeft" : "transferHunkRight",
    `Copy section ${direction}`,
    `Copy entire change section ${direction} · Alt+Shift+${side === "left" ? "L" : "R"}`,
    "transferHunk",
    side,
  );
}
const workflowRoot =
  document.getElementById("workflow-root") || document.createElement("div");
if (!workflowRoot.isConnected) el("notice").before(workflowRoot);
const workflow = createWorkflow(
  workflowRoot,
  el("navigation"),
  dispatch,
  (side, line) => {
    const editor =
      side === "left" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const safeLine = Math.max(
      1,
      Math.min(editor.getModel()?.getLineCount() || 1, line),
    );
    editor.revealLineInCenter(safeLine);
    editor.setPosition({ lineNumber: safeLine, column: 1 });
    editor.focus();
  },
);
function updateWorkflow() {
  if (state) workflow.update(state, currentHunk, acknowledged !== version);
}
function displayOptions() {
  diff.updateOptions({
    hideUnchangedRegions: {
      enabled: !!state?.focusMode,
      contextLineCount: 3,
      minimumLineCount: 5,
      revealLineCount: 10,
    },
    ignoreTrimWhitespace: !!state?.ignoreWhitespace,
  });
}
function theme() {
  const light = document.body.classList.contains("vscode-light");
  const hc = document.body.classList.contains("vscode-high-contrast");
  const hcLight = document.body.classList.contains(
    "vscode-high-contrast-light",
  );
  const css = getComputedStyle(document.body);
  const get = (name: string, fallback: string) =>
    normalizeThemeColor(
      css.getPropertyValue("--vscode-" + name).trim(),
      fallback,
    );
  monaco.editor.defineTheme("branchlens", {
    base: hc ? "hc-black" : hcLight ? "hc-light" : light ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": get(
        "editor-background",
        light ? "#ffffff" : "#1e1e1e",
      ),
      "editor.foreground": get(
        "editor-foreground",
        light ? "#333333" : "#cccccc",
      ),
      "diffEditor.insertedTextBackground":
        state?.highlight === false
          ? "#00000000"
          : get("diffEditor-insertedTextBackground", "#9bb95533"),
      "diffEditor.removedTextBackground":
        state?.highlight === false
          ? "#00000000"
          : get("diffEditor-removedTextBackground", "#ff000033"),
      "diffEditor.insertedLineBackground": "#00000000",
      "diffEditor.removedLineBackground": "#00000000",
      "diffEditorGutter.insertedLineBackground":
        state?.highlight === false ? "#00000000" : "#81b88b55",
      "diffEditorGutter.removedLineBackground":
        state?.highlight === false ? "#00000000" : "#c74e3955",
      "diffEditorOverview.insertedForeground":
        state?.highlight === false ? "#00000000" : "#81b88b",
      "diffEditorOverview.removedForeground":
        state?.highlight === false ? "#00000000" : "#c74e39",
      "diffEditor.insertedTextBorder":
        state?.highlight === false ? "#00000000" : "#81b88b44",
      "diffEditor.removedTextBorder":
        state?.highlight === false ? "#00000000" : "#c74e3944",
      "diffEditor.diagonalFill": "#00000000",
    },
  });
  monaco.editor.setTheme("branchlens");
}
/** Presentation only: authoritative host hunk coordinates remain unchanged. */
function whitespaceOnlyHunk(hunk: {
  leftStart: number;
  leftCount: number;
  rightStart: number;
  rightCount: number;
}): boolean {
  if (!models || hunk.leftCount === 0 || hunk.leftCount !== hunk.rightCount)
    return false;
  for (let offset = 0; offset < hunk.leftCount; offset++) {
    const leftLine = hunk.leftStart + offset + 1;
    const rightLine = hunk.rightStart + offset + 1;
    if (
      leftLine > models.left.getLineCount() ||
      rightLine > models.right.getLineCount()
    )
      return false;
    const trim = (model: monaco.editor.ITextModel, line: number) =>
      model.getLineContent(line).replace(/^[ \t]+|[ \t]+$/g, "") +
      // A changed final newline or EOL is not leading/trailing spaces or tabs.
      (line < model.getLineCount() ? model.getEOL() : "");
    if (trim(models.left, leftLine) !== trim(models.right, rightLine))
      return false;
  }
  return true;
}
/** Only public model decorations: no Monaco-owned DOM is inspected or modified. */
function decorateHunks() {
  for (const side of ["left", "right"] as const) {
    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    const model = models?.[side];
    if (model && state?.highlight !== false && acknowledged === version) {
      for (const hunk of state?.hunks || []) {
        if (state.ignoreWhitespace && whitespaceOnlyHunk(hunk)) continue;
        const start = hunk[side + "Start"] as number;
        const count = hunk[side + "Count"] as number;
        const color = side === "left" ? "reference" : "working";
        if (count === 0) {
          const line = Math.max(1, Math.min(model.getLineCount(), start));
          decorations.push({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: `branchlens-boundary branchlens-${color} ${start === 0 ? "branchlens-boundary-before" : "branchlens-boundary-after"}`,
              hoverMessage: {
                value:
                  "Change boundary: this section has no lines on this side.",
              },
              stickiness:
                monaco.editor.TrackedRangeStickiness
                  .NeverGrowsWhenTypingAtEdges,
            },
          });
          continue;
        }
        const first = Math.max(1, start + 1);
        const last = Math.min(model.getLineCount(), start + count);
        for (let line = first; line <= last; line++) {
          decorations.push({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: `branchlens-island branchlens-${color}${line === first ? " branchlens-island-first" : ""}${line === last ? " branchlens-island-last" : ""}`,
              stickiness:
                monaco.editor.TrackedRangeStickiness
                  .NeverGrowsWhenTypingAtEdges,
            },
          });
        }
      }
    }
    islands[side].set(decorations);
  }
}
function updateLabels() {
  if (!state) return;
  const statuses = [];
  if (state.leftDirty) statuses.push("Reference draft modified");
  if (state.rightUnsaved) statuses.push("Working file unsaved");
  el("draft-status").textContent = statuses.join(" · ") || "Working file saved";
  el("left-label").textContent =
    state.leftLabel +
    (state.leftDirty ? " · reference draft modified" : " · reference draft") +
    (state.left.exists ? "" : " · file absent") +
    " · " +
    state.left.path;
  el("right-label").textContent =
    state.rightLabel +
    (state.rightWorkingTree ? " · working tree, including unsaved edits" : "") +
    (state.rightUnsaved ? " · unsaved" : "") +
    (state.right.exists ? "" : " · file absent") +
    " · " +
    state.right.path;
}
function language(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        php: "php",
        json: "json",
        py: "python",
        css: "css",
        html: "html",
        md: "markdown",
        yml: "yaml",
        yaml: "yaml",
        sh: "shell",
        sql: "sql",
        rs: "rust",
        go: "go",
        java: "java",
        cs: "csharp",
        cpp: "cpp",
        xml: "xml",
      } as Record<string, string>
    )[extension || ""] || "plaintext"
  );
}
function updatePosition() {
  updateWorkflow();
  const current = state?.hunks?.[currentHunk];
  const hidden =
    state?.ignoreWhitespace &&
    current &&
    acknowledged === version &&
    whitespaceOnlyHunk(current)
      ? " · whitespace-only section hidden"
      : "";
  if (state?.filePosition) {
    el("position").textContent =
      state.filePosition +
      ` · Change ${state.hunks?.length ? currentHunk + 1 : 0} of ${state.hunks?.length || 0}${hidden}`;
    return;
  }
  el("position").textContent =
    `File ${(state?.index ?? 0) + 1} of ${state?.total ?? 0} · Change ${state?.hunks?.length ? currentHunk + 1 : 0} of ${state?.hunks?.length ?? 0}${hidden}`;
}
function navigateHunk(delta: number) {
  const hunks = state?.hunks || [];
  if (!hunks.length) return;
  currentHunk = (currentHunk + delta + hunks.length) % hunks.length;
  const h = hunks[currentHunk];
  diff.getOriginalEditor().revealLineInCenter(Math.max(1, h.leftStart + 1));
  diff.getModifiedEditor().revealLineInCenter(Math.max(1, h.rightStart + 1));
  updatePosition();
}
function applyNavigation(target: {
  hunk?: number;
  side?: "left" | "right";
  line?: number;
}) {
  if (
    Number.isInteger(target.hunk) &&
    (target.hunk ?? -1) >= 0 &&
    (target.hunk ?? 0) < (state?.hunks?.length || 0)
  ) {
    currentHunk = target.hunk!;
    navigateHunk(0);
  }
  if (Number.isInteger(target.line) && (target.line ?? 0) > 0) {
    const editor =
      target.side === "left"
        ? diff.getOriginalEditor()
        : diff.getModifiedEditor();
    const line = Math.min(target.line!, editor.getModel()?.getLineCount() || 1);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }
}
function dispatch(action: string, value?: unknown) {
  if (action === "reviewHunk" && value === undefined) {
    if (!state?.review || !state.hunks?.length) return;
    value = {
      index: currentHunk,
      reviewed: !state.review.reviewedHunks.includes(currentHunk),
    };
  }
  if (action === "navigate" && value && typeof value === "object") {
    applyNavigation(
      value as { hunk?: number; side?: "left" | "right"; line?: number },
    );
    return;
  }
  if (
    [
      "reviewFile",
      "reviewHunk",
      "addNote",
      "deleteNote",
      "stageHunk",
      "unstageHunk",
      "nextUnreviewed",
      "exportReview",
    ].includes(action) &&
    acknowledged !== version
  ) {
    el("notice").textContent =
      "Wait for the draft change mapping to update, then retry.";
    return;
  }
  if (action === "focusLeft" || action === "focusRight") {
    (action === "focusLeft"
      ? diff.getOriginalEditor()
      : diff.getModifiedEditor()
    ).focus();
    return;
  }
  if (action === "nextHunk" || action === "previousHunk") {
    navigateHunk(action === "nextHunk" ? 1 : -1);
    return;
  }
  if (action === "undo" || action === "redo") {
    api.postMessage({
      type: "draft",
      action,
      version,
      sessionId: state?.sessionId,
      index: state?.index,
      fileKey: state?.fileKey,
    });
    return;
  }
  if (action === "transferLine" || action === "transferHunk") {
    if (acknowledged !== version) {
      el("notice").textContent =
        "Wait for the draft change mapping to update, then retry.";
      return;
    }
    const side = (value || focus) as "left" | "right";
    const editor =
      side === "left" ? diff.getOriginalEditor() : diff.getModifiedEditor();
    const selection = editor.getSelection();
    if (
      action === "transferLine" &&
      selection &&
      selection.startLineNumber !== selection.endLineNumber
    ) {
      el("notice").textContent =
        "Select exactly one changed line, or use Section to copy the whole change.";
      return;
    }
    api.postMessage({
      type: "draft",
      action,
      side,
      version,
      sessionId: state?.sessionId,
      index: state?.index,
      fileKey: state?.fileKey,
      hunk: currentHunk,
      line: (editor.getPosition()?.lineNumber ?? 1) - 1,
    });
    return;
  }
  post(action, value);
}
for (const [side, editor] of [
  ["left", diff.getOriginalEditor()],
  ["right", diff.getModifiedEditor()],
] as const) {
  editor.onDidFocusEditorText(() => {
    focus = side;
  });
  editor.onDidChangeCursorPosition(() => {
    const line = (editor.getPosition()?.lineNumber ?? 1) - 1;
    const found = state?.hunks?.findIndex(
      (h: any) =>
        line >= h[side + "Start"] &&
        line < h[side + "Start"] + Math.max(1, h[side + "Count"]),
    );
    if (found >= 0) {
      currentHunk = found;
      updatePosition();
    }
  });
  editor.onDidChangeModelContent(() => {
    if (updating || !models) return;
    const text = models[side].getValue(
      monaco.editor.EndOfLinePreference.TextDefined,
      true,
    );
    if (text === outgoingText[side]) return;
    outgoingText[side] = text;
    api.postMessage({
      type: "draft",
      action: "edit",
      side,
      sessionId: state?.sessionId,
      index: state?.index,
      fileKey: state?.fileKey,
      text,
      version,
    });
    version++;
    islands.left.clear();
    islands.right.clear();
    if (state) {
      if (side === "left") state.leftDirty = true;
      else state.rightUnsaved = true;
      updateLabels();
      updateWorkflow();
    }
  });
}
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      dispatch("save");
      return;
    }
    if (
      (e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLSelectElement) &&
      !mod
    )
      return;
    if (
      mod &&
      e.key.toLowerCase() === "z" &&
      !(
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLInputElement
      )
    ) {
      e.preventDefault();
      e.stopPropagation();
      dispatch(e.shiftKey ? "redo" : "undo");
    }
    if (e.altKey && e.shiftKey) {
      const action =
        (
          {
            ArrowDown: "nextHunk",
            ArrowUp: "previousHunk",
            PageDown: "nextFile",
            PageUp: "previousFile",
            ArrowRight: "transferLine",
            ArrowLeft: "transferLine",
            l: "transferHunk",
            r: "transferHunk",
          } as Record<string, string>
        )[e.key] ||
        ({ L: "transferHunk", R: "transferHunk" } as Record<string, string>)[
          e.key
        ];
      if (action) {
        e.preventDefault();
        dispatch(
          action,
          e.key === "ArrowRight" || e.key.toLowerCase() === "l"
            ? "left"
            : e.key === "ArrowLeft" || e.key.toLowerCase() === "r"
              ? "right"
              : undefined,
        );
      }
    }
  },
  true,
);
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.type === "command") {
    dispatch(msg.action, msg.value);
    return;
  }
  if (msg.type === "error") {
    el("notice").textContent = msg.message;
    return;
  }
  if (msg.type === "globalstatus") {
    if (
      state &&
      (msg.sessionId === undefined || msg.sessionId === state.sessionId) &&
      (msg.index === undefined || msg.index === state.index)
    ) {
      if (typeof msg.rightUnsaved === "boolean")
        state.rightUnsaved = msg.rightUnsaved;
      if (typeof msg.leftDirty === "boolean") state.leftDirty = msg.leftDirty;
      updateLabels();
    }
    return;
  }
  if (msg.type === "edited") {
    if (
      !state ||
      (msg.sessionId !== undefined && msg.sessionId !== state.sessionId) ||
      (msg.index !== undefined && msg.index !== state.index) ||
      msg.version !== version
    )
      return;
    acknowledged = msg.version;
    if (state) {
      state.hunks = msg.hunks;
      state.dirty = msg.dirty;
      for (const field of [
        "review",
        "staging",
        "impact",
        "focusMode",
        "ignoreWhitespace",
      ]) {
        if (Object.prototype.hasOwnProperty.call(msg, field))
          state[field] = msg[field];
      }
      displayOptions();
      if (typeof msg.leftDirty === "boolean") state.leftDirty = msg.leftDirty;
      if (typeof msg.rightUnsaved === "boolean")
        state.rightUnsaved = msg.rightUnsaved;
      updateLabels();
      currentHunk = Math.min(currentHunk, Math.max(0, msg.hunks.length - 1));
      updatePosition();
      decorateHunks();
    }
    return;
  }
  if (msg.type !== "file") return;
  const sameLiveFile =
    state &&
    msg.sessionId === state.sessionId &&
    (msg.fileKey !== undefined
      ? msg.fileKey === state.fileKey
      : msg.index === state.index);
  if (sameLiveFile && msg.version < version) {
    state.index = msg.index;
    state.total = msg.total;
    state.filePosition = msg.filePosition;
    updatePosition();
    return;
  }
  state = msg;
  version = msg.version;
  acknowledged = msg.version;
  updating = true;
  const newKey = msg.sessionId + ":" + (msg.fileKey ?? msg.index);
  if (key !== newKey) {
    const old = models;
    models = {
      left: monaco.editor.createModel(msg.left.text, language(msg.left.path)),
      right: monaco.editor.createModel(
        msg.right.text,
        language(msg.right.path),
      ),
    };
    diff.setModel({ original: models.left, modified: models.right });
    old?.left.dispose();
    old?.right.dispose();
    key = newKey;
    currentHunk = 0;
  } else {
    for (const side of ["left", "right"] as const) {
      if (
        models![side].getValue(
          monaco.editor.EndOfLinePreference.TextDefined,
          true,
        ) !== msg[side].text
      )
        models![side].setValue(msg[side].text);
    }
  }
  for (const side of ["left", "right"] as const) {
    outgoingText[side] = models![side].getValue(
      monaco.editor.EndOfLinePreference.TextDefined,
      true,
    );
  }
  updating = false;
  diff.updateOptions({
    readOnly: !!msg.unsupported,
    originalEditable: !msg.unsupported,
  });
  diff
    .getOriginalEditor()
    .updateOptions({ ariaLabel: "Reference branch draft, editable" });
  diff.getModifiedEditor().updateOptions({
    ariaLabel: "Current branch working file, editable; Save writes to disk",
  });
  el("file-label").textContent = msg.path;
  updateLabels();
  el("notice").textContent = msg.unsupported || "";
  el("transfers")
    .querySelectorAll("button")
    .forEach((b) => {
      b.disabled = !!msg.unsupported;
    });
  theme();
  displayOptions();
  updatePosition();
  decorateHunks();
  if (msg.pendingNavigation) applyNavigation(msg.pendingNavigation);
});
new MutationObserver(theme).observe(document.body, {
  attributes: true,
  attributeFilter: ["class", "style"],
});
theme();
api.postMessage({ type: "ready" });
