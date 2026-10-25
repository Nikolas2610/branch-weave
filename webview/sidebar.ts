declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const api = acquireVsCodeApi();
const root = document.getElementById("sidebar")!;
const kind = document.body.dataset.view;
let state: any = { repos: [], settings: {}, files: [] };
let filter = "";
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
function render() {
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
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Filter file paths";
    input.setAttribute("aria-label", "Filter changed file paths");
    input.value = filter;
    input.oninput = () => {
      filter = input.value;
      renderFiles(list);
    };
    root.append(input);
    const list = element("div");
    root.append(list);
    renderFiles(list);
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
    b.setAttribute("aria-label", `${f.status} ${f.newPath}`);
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
    render();
  }
});
api.postMessage({ type: "ready" });
