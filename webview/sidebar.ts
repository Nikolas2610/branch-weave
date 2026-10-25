declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
const root = document.getElementById("sidebar")!;
const kind = document.body.dataset.view;
let state: any = { repos: [], settings: {}, files: [] };
let filter = "";
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let presetName = "";
let presetsOpen = false;
const send = (action: string, value?: unknown) =>
  api.postMessage({ type: "action", action, value });
function element(tag: string, text?: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function button(text: string, action: string, value?: unknown, cls?: string) {
  const b = element("button", text, cls) as HTMLButtonElement;
  b.onclick = () => send(action, value);
  return b;
}
function field(label: string, value: string, action: string) {
  const f = element("label", undefined, "field");
  f.append(
    element("span", label),
    button(value || "Select…", action, undefined, "selector"),
  );
  return f;
}
function toggle(label: string, checked: boolean, action: string) {
  const f = element("label", undefined, "switch");
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = checked;
  c.onchange = () => send(action, c.checked);
  f.append(c, document.createTextNode(label));
  return f;
}
function presetPanel() {
  const panel = document.createElement("details");
  panel.className = "preset-panel";
  panel.open = presetsOpen;
  panel.ontoggle = () => {
    presetsOpen = panel.open;
  };
  panel.append(
    element("summary", "Comparison presets"),
    element(
      "p",
      "Save the reference, comparison and display settings, and path filter. Loading preserves the current checkout.",
      "description",
    ),
  );
  const form = document.createElement("form");
  form.className = "preset-form";
  const name = document.createElement("input");
  name.type = "text";
  name.placeholder = "Preset name";
  name.maxLength = 120;
  name.setAttribute("aria-label", "Comparison preset name");
  name.value = presetName;
  const save = button("Save preset", "savePreset");
  save.type = "submit";
  save.onclick = null;
  save.disabled = !presetName.trim() || !state.root;
  name.oninput = () => {
    presetName = name.value;
    save.disabled = !presetName.trim() || !state.root;
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (!presetName.trim()) return;
    send("savePreset", presetName.trim());
    presetName = "";
    name.value = "";
    save.disabled = true;
  };
  form.append(name, save);
  panel.append(form);
  for (const preset of state.presets || []) {
    const row = element("div", undefined, "preset-row");
    const load = button(preset.name, "loadPreset", preset.id, "selector");
    load.title = `Load ${preset.name} · ${preset.left}`;
    const remove = button("Delete", "deletePreset", preset.id);
    remove.setAttribute("aria-label", `Delete preset ${preset.name}`);
    row.append(load, remove);
    panel.append(row);
  }
  if (!state.presets?.length)
    panel.append(element("p", "No saved presets.", "description"));
  return panel;
}
function render() {
  const active = document.activeElement as HTMLInputElement | null;
  const restoreFilter = active?.id === "path-filter";
  const selection = restoreFilter
    ? [active.selectionStart, active.selectionEnd]
    : undefined;
  root.replaceChildren();
  if (kind === "compare") {
    root.append(
      field(
        "Repository",
        state.root?.split(/[\\/]/).pop() || "Choose repository",
        "repository",
      ),
      field("Reference branch · Left", state.settings.left, "left"),
    );
    const current = element("div", undefined, "field current-branch");
    current.append(
      element("span", "Current branch · Right"),
      element(
        "strong",
        state.currentBranch || state.settings.right || "Current checkout",
      ),
      element(
        "small",
        "Working tree, including unsaved editor changes",
        "description",
      ),
    );
    root.append(current);
    const row = element("div", undefined, "row");
    row.append(
      button("Compare", "compare", undefined, "primary"),
      button("Refresh", "refresh"),
    );
    root.append(row);
    root.append(
      toggle(
        "Include upstream changes",
        !!state.settings.includeUpstream,
        "upstream",
      ),
      element(
        "p",
        state.settings.includeUpstream
          ? "Compare the reference branch with the current working tree, including upstream changes and unsaved edits."
          : "Compare the merge base with the current working tree, including unsaved edits.",
        "description",
      ),
      toggle(
        "Highlight change sections",
        state.settings.highlight !== false,
        "highlight",
      ),
    );
    root.append(
      toggle("Focus changed regions", !!state.settings.focusMode, "focusMode"),
      toggle(
        "Ignore trim whitespace in editor",
        !!state.settings.ignoreWhitespace,
        "ignoreWhitespace",
      ),
      presetPanel(),
    );
    root.append(
      element(
        "p",
        "Choose a local reference branch. Right always follows the checked-out branch; selecting a reference never checks out or fetches.",
        "description",
      ),
    );
  } else {
    const row = element("div", undefined, "row");
    row.append(
      element("strong", `${state.files?.length || 0} changed files`),
      button("Refresh", "refresh"),
      button(
        state.settings.flat ? "Folder tree" : "Flat list",
        "flat",
        !state.settings.flat,
      ),
    );
    root.append(row);
    if (state.reviewProgress) {
      const review = element("div", undefined, "review-sidebar");
      const progress = document.createElement("progress");
      progress.max = Math.max(1, state.reviewProgress.total);
      progress.value = state.reviewProgress.reviewed;
      progress.setAttribute("aria-label", "Reviewed files");
      review.append(
        element(
          "span",
          `${state.reviewProgress.reviewed}/${state.reviewProgress.total} files reviewed`,
        ),
        progress,
        button("Next unreviewed", "nextUnreviewed"),
      );
      root.append(review);
    }
    const input = document.createElement("input");
    input.type = "text";
    input.id = "path-filter";
    input.placeholder = "Filter file paths";
    input.setAttribute("aria-label", "Filter changed file paths");
    input.value = filter;
    input.oninput = () => {
      filter = input.value;
      renderFiles(list);
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        filterTimer = undefined;
        send("filter", filter);
      }, 250);
    };
    root.append(input);
    const list = element("div");
    root.append(list);
    renderFiles(list);
    if (restoreFilter) {
      input.focus();
      input.setSelectionRange(
        selection?.[0] ?? input.value.length,
        selection?.[1] ?? input.value.length,
      );
    }
  }
  if (state.loading)
    root.append(element("p", "Comparing snapshots…", "description"));
  if (state.error) {
    root.append(element("p", state.error, "error"));
    if (!state.settings.includeUpstream)
      root.append(button("Use direct comparison", "upstream", true));
  }
}
function renderFiles(list: HTMLElement) {
  list.replaceChildren();
  const files = (state.files || [])
    .map((f: any, index: number) => ({ ...f, index }))
    .filter((f: any) =>
      (f.oldPath + " " + f.newPath)
        .toLocaleLowerCase()
        .includes(filter.toLocaleLowerCase()),
    );
  if (!files.length && !state.loading)
    list.append(
      element(
        "p",
        state.session
          ? "No matching changed files."
          : "Select a reference branch and choose Compare.",
        "description",
      ),
    );
  const dirs = new Map<string, HTMLElement>();
  dirs.set("", list);
  for (const f of files) {
    let parent = list;
    const parts = f.newPath.split("/");
    if (!state.settings.flat) {
      let path = "";
      for (const part of parts.slice(0, -1)) {
        const prev = path;
        path += (path ? "/" : "") + part;
        if (!dirs.has(path)) {
          const d = document.createElement("details");
          d.open = true;
          d.append(element("summary", part));
          dirs.get(prev)!.append(d);
          dirs.set(path, d);
        }
        parent = dirs.get(path)!;
      }
    }
    const b = button(
      "",
      "open",
      f.index,
      "file-row" + (state.active === f.index ? " selected" : ""),
    );
    const reviewed = state.reviewedFiles?.includes(f.index);
    b.setAttribute(
      "aria-label",
      `${f.status} ${f.newPath}${reviewed ? ", reviewed" : ", unreviewed"}`,
    );
    b.setAttribute("aria-current", state.active === f.index ? "true" : "false");
    b.title = `${f.status === "R" ? f.oldPath + " → " : ""}${f.newPath}`;
    b.append(
      element("span", f.status, "status " + f.status),
      element(
        "span",
        (state.active === f.index ? "▸ " : "") +
          (state.settings.flat ? f.newPath : parts.at(-1)),
        "file-name",
      ),
    );
    if (reviewed) {
      const indicator = element("span", "✓", "reviewed-indicator");
      indicator.title = "Reviewed";
      indicator.setAttribute("aria-hidden", "true");
      b.append(indicator);
    }
    if (f.additions !== null) {
      const counts = element("span", undefined, "counts");
      counts.append(
        element("span", "+" + f.additions, "added"),
        document.createTextNode(" "),
        element("span", "−" + f.deletions, "deleted"),
      );
      b.append(counts);
    } else b.append(element("span", "binary", "path"));
    parent.append(b);
    if (f.status === "R")
      parent.append(element("div", f.oldPath + " → " + f.newPath, "path"));
  }
}
window.addEventListener("message", (e) => {
  if (e.data.type === "state") {
    state = e.data;
    if (typeof state.settings?.filter === "string" && !filterTimer)
      filter = state.settings.filter;
    render();
  }
});
api.postMessage({ type: "ready" });
