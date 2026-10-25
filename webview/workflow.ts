import type { ReviewView, StagingView, ImpactView } from "../src/workflowTypes";
import { iconButton, toolbarGroup } from "./toolbar";

interface WorkflowState {
  fileKey?: string;
  index?: number;
  sessionId?: string;
  unsupported?: string;
  review?: ReviewView;
  staging?: StagingView;
  impact?: ImpactView;
  focusMode?: boolean;
  ignoreWhitespace?: boolean;
  hunks?: unknown[];
}
function node(tag: string, text?: string, cls?: string) {
  const item = document.createElement(tag);
  if (text) item.textContent = text;
  if (cls) item.className = cls;
  return item;
}
export function createWorkflow(
  parent: HTMLElement,
  toolbar: HTMLElement,
  dispatch: (action: string, value?: unknown) => void,
  jump: (side: "left" | "right", line: number) => void,
) {
  let state: WorkflowState = {};
  let current = 0;
  let pending = false;
  let fileIdentity = "";
  let noteDraft = "";
  let noteTarget = "file";
  let renderedReview: ReviewView | undefined;
  let renderedStaging: StagingView | undefined;
  let renderedImpact: ImpactView | undefined;
  const tools = toolbarGroup(toolbar, "Review and display options");
  const reviewed = iconButton(
    tools,
    "review",
    "Mark file reviewed",
    "Toggle reviewed for this file",
    () => dispatch("reviewFile", !state.review?.reviewed),
  );
  iconButton(
    tools,
    "nextUnreviewed",
    "Next unreviewed change",
    "Go to the next unreviewed section or file",
    () => dispatch("nextUnreviewed"),
  );
  const focused = iconButton(
    tools,
    "focus",
    "Focus changed regions",
    "Collapse unchanged editor regions",
    () => dispatch("focusMode", !state.focusMode),
  );
  const whitespace = iconButton(
    tools,
    "whitespace",
    "Ignore trim whitespace",
    "Toggle whitespace-only presentation differences; transfers retain the full change mapping",
    () => dispatch("ignoreWhitespace", !state.ignoreWhitespace),
  );
  const progress = node("span", "", "review-progress");
  progress.setAttribute("aria-live", "polite");
  tools.append(progress);
  const container = node("div", undefined, "workflow-panels");
  container.id = "workflow";
  parent.append(container);
  const reviewPanel = panel("Review & notes");
  const changesPanel = panel("Git index changes");
  const impactPanel = panel("Changed symbols & tests");
  const reviewBody = node("div", undefined, "workflow-body");
  const changesBody = node("div", undefined, "workflow-body");
  const impactBody = node("div", undefined, "workflow-body");
  reviewPanel.append(reviewBody);
  changesPanel.append(changesBody);
  impactPanel.append(impactBody);
  container.append(reviewPanel, changesPanel, impactPanel);
  function panel(title: string) {
    const details = document.createElement("details");
    details.className = "workflow-panel";
    details.append(node("summary", title));
    return details;
  }
  function action(
    text: string,
    name: string,
    value?: unknown,
    disabled = pending,
  ) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.disabled = disabled;
    button.onclick = () => dispatch(name, value);
    return button;
  }
  function hint(text: string) {
    return node("p", text, "description");
  }
  function renderReview() {
    reviewBody.replaceChildren();
    const review = state.review;
    if (pending)
      reviewBody.append(hint("Updating review anchors and index mapping…"));
    if (!review) {
      reviewBody.append(
        hint(
          "Review progress and local notes are unavailable for this comparison.",
        ),
      );
      return;
    }
    const row = node("div", undefined, "row");
    row.append(
      action(
        pending
          ? "Updating review…"
          : review.reviewed
            ? "Mark file unreviewed"
            : "Mark file reviewed",
        "reviewFile",
        !review.reviewed,
      ),
    );
    const count = state.hunks?.length || 0;
    if (count) {
      const checked = review.reviewedHunks.includes(current);
      row.append(
        action(
          `${checked ? "Unreview" : "Review"} section ${current + 1}`,
          "reviewHunk",
          { index: current, reviewed: !checked },
        ),
      );
    }
    row.append(action("Export Markdown", "exportReview", undefined));
    reviewBody.append(
      row,
      hint(
        pending
          ? "Review status is updating for the edited content."
          : `${review.reviewedHunks.length} of ${review.totalHunks} sections reviewed · Notes stay local to this repository.`,
      ),
    );
    const form = node("form", undefined, "note-form") as HTMLFormElement;
    const text = document.createElement("textarea");
    text.rows = 2;
    text.placeholder = "Add a local review note (up to 4,000 characters)…";
    text.setAttribute("aria-label", "Local review note");
    text.value = noteDraft;
    text.maxLength = 4000;
    text.setAttribute(
      "aria-description",
      "Up to 4,000 characters. Notes stay local to this repository.",
    );
    const target = document.createElement("select");
    target.setAttribute("aria-label", "Note anchor");
    const options = [
      ["file", "This file"],
      ...(count ? [["section", `Current section (${current + 1})`]] : []),
    ];
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      target.append(option);
    }
    if (!count) noteTarget = "file";
    target.value = noteTarget;
    target.onchange = () => {
      noteTarget = target.value;
    };
    const add = action(
      "Add note",
      "addNote",
      undefined,
      pending || !noteDraft.trim(),
    );
    add.type = "submit";
    add.onclick = null;
    text.oninput = () => {
      noteDraft = text.value;
      add.disabled = pending || !noteDraft.trim();
    };
    form.onsubmit = (event) => {
      event.preventDefault();
      if (pending || !noteDraft.trim()) return;
      dispatch("addNote", {
        text: noteDraft.trim(),
        ...(noteTarget === "section" ? { hunk: current } : {}),
      });
      noteDraft = "";
      text.value = "";
      add.disabled = true;
    };
    const compose = node("div", undefined, "row");
    compose.append(target, add);
    form.append(text, compose);
    reviewBody.append(form);
    const notes = node("div", undefined, "review-notes");
    for (const note of review.notes) {
      const article = node("article", undefined, "review-note");
      const meta = node("div", undefined, "row");
      meta.append(
        node(
          "small",
          `${note.hunk === undefined ? "File note" : `Section ${note.hunk + 1}`} ${note.stale ? "· anchor changed" : ""}`,
          note.stale ? "stale-note" : "description",
        ),
      );
      const remove = action("Delete", "deleteNote", note.id);
      remove.setAttribute(
        "aria-label",
        `Delete note: ${note.text.slice(0, 60)}`,
      );
      meta.append(remove);
      article.append(meta, node("p", note.text));
      notes.append(article);
    }
    if (!review.notes.length) notes.append(hint("No notes for this file."));
    reviewBody.append(notes);
  }
  function renderStaging() {
    changesBody.replaceChildren();
    const staging = state.staging;
    changesBody.append(
      hint(
        "Actual Git index changes, independent of the reference comparison. Staging changes the index; it does not save working files.",
      ),
    );
    if (!staging) {
      changesBody.append(hint("Index changes are unavailable for this file."));
      return;
    }
    if (staging.bufferUnsaved)
      changesBody.append(
        node("p", "Stage includes unsaved working-file text.", "unsaved-note"),
      );
    if (staging.error) {
      const error = node("p", staging.error, "error");
      error.setAttribute("role", "status");
      changesBody.append(error);
    }
    for (const [label, sections, operation] of [
      ["Unstaged · working text → index", staging.unstaged, "stageHunk"],
      ["Staged · index → HEAD", staging.staged, "unstageHunk"],
    ] as const) {
      const group = node("section", undefined, "index-group");
      group.append(node("h3", `${label} (${sections.length})`));
      if (!sections.length)
        group.append(
          hint(
            operation === "stageHunk"
              ? "No unstaged sections."
              : "No staged sections.",
          ),
        );
      for (const section of sections) {
        const details = document.createElement("details");
        details.className = "index-section";
        details.append(node("summary", section.summary));
        const preview = node("pre", section.preview, "patch-preview");
        preview.tabIndex = 0;
        preview.setAttribute(
          "aria-label",
          `${operation === "stageHunk" ? "Unstaged" : "Staged"} section preview`,
        );
        details.append(
          preview,
          action(
            operation === "stageHunk"
              ? "Stage this section"
              : "Unstage this section",
            operation,
            { index: section.index, token: staging.token },
            pending || !!staging.error || !staging.token,
          ),
        );
        group.append(details);
      }
      changesBody.append(group);
    }
  }
  function renderImpact() {
    impactBody.replaceChildren();
    const impact = state.impact;
    if (!impact) {
      impactBody.append(
        hint("Changed-symbol analysis is unavailable for this file."),
      );
      return;
    }
    if (impact.message) impactBody.append(hint(impact.message));
    for (const symbol of impact.symbols) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "symbol-row";
      button.textContent = `${symbol.name} · ${symbol.kind} · ${symbol.side === "left" ? "Reference" : "Working"} L${symbol.startLine}–${symbol.endLine} · ${symbol.hunks.length} section${symbol.hunks.length === 1 ? "" : "s"}`;
      button.disabled = pending;
      button.onclick = () => jump(symbol.side, symbol.startLine);
      impactBody.append(button);
    }
    if (!impact.symbols.length)
      impactBody.append(hint("No changed symbols found."));
    impactBody.append(
      node("h3", "Candidate related tests"),
      hint(
        "Filename and import matches are suggestions, not a dependency guarantee.",
      ),
    );
    for (const test of impact.tests) {
      const row = node("div", undefined, "candidate-test");
      const button = action(test.path, "openRelatedTest", test.path);
      button.className = "symbol-row";
      row.append(button, node("small", test.reason, "description"));
      impactBody.append(row);
    }
    if (!impact.tests.length)
      impactBody.append(hint("No related test candidates found."));
  }
  return {
    update(
      next: WorkflowState,
      hunk: number,
      awaitingAcknowledgement: boolean,
    ) {
      const identity = `${next.sessionId}:${next.fileKey ?? next.index}`;
      const fileChanged = identity !== fileIdentity;
      const pendingChanged = pending !== awaitingAcknowledgement;
      const refreshReview =
        fileChanged ||
        pendingChanged ||
        renderedReview !== next.review ||
        current !== hunk;
      const refreshStaging =
        fileChanged || pendingChanged || renderedStaging !== next.staging;
      const refreshImpact =
        fileChanged || pendingChanged || renderedImpact !== next.impact;
      const activeNote = reviewBody.querySelector("textarea");
      const restoreNote = !fileChanged && activeNote === document.activeElement;
      const selection =
        restoreNote && activeNote
          ? [activeNote.selectionStart, activeNote.selectionEnd]
          : undefined;
      if (fileChanged) {
        fileIdentity = identity;
        noteDraft = "";
        noteTarget = "file";
      }
      state = next;
      current = hunk;
      pending = awaitingAcknowledgement;
      reviewed.disabled = pending || !state.review;
      reviewed.setAttribute(
        "aria-pressed",
        String(!pending && !!state.review?.reviewed),
      );
      reviewed.setAttribute(
        "aria-label",
        state.review?.reviewed ? "Mark file unreviewed" : "Mark file reviewed",
      );
      focused.setAttribute("aria-pressed", String(!!state.focusMode));
      whitespace.setAttribute("aria-pressed", String(!!state.ignoreWhitespace));
      progress.textContent = pending
        ? "Updating review…"
        : state.review
          ? `${state.review.filesReviewed}/${state.review.totalFiles} files reviewed`
          : "";
      container.classList.toggle("mapping-pending", pending);
      container.setAttribute("aria-busy", String(pending));
      if (refreshReview) {
        renderReview();
        if (restoreNote) {
          const text = reviewBody.querySelector("textarea");
          text?.focus({ preventScroll: true });
          text?.setSelectionRange(
            selection?.[0] ?? text.value.length,
            selection?.[1] ?? text.value.length,
          );
        }
      }
      if (refreshStaging) renderStaging();
      if (refreshImpact) renderImpact();
      renderedReview = next.review;
      renderedStaging = next.staging;
      renderedImpact = next.impact;
    },
  };
}
