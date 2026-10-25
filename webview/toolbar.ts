import { Codicon as BundledCodicon } from "monaco-editor/base/common/codicons.js";
import "./toolbar.css";

// The local Monaco declaration lists the original toolbar subset only.
const Codicon = BundledCodicon as typeof BundledCodicon &
  Readonly<
    Record<"checklist" | "fold" | "whitespace", { readonly id: string }>
  >;

const icons = {
  review: [Codicon.check],
  nextUnreviewed: [Codicon.checklist, Codicon.arrowRight],
  focus: [Codicon.fold],
  whitespace: [Codicon.whitespace],
  previousFile: [Codicon.goToFile, Codicon.arrowLeft],
  nextFile: [Codicon.goToFile, Codicon.arrowRight],
  previousHunk: [Codicon.arrowUp],
  nextHunk: [Codicon.arrowDown],
  undo: [Codicon.discard],
  redo: [Codicon.redo],
  reset: [Codicon.refresh],
  fileOperation: [Codicon.fileCode],
  export: [Codicon.export],
  apply: [Codicon.check],
  save: [Codicon.save],
  transferLineLeft: [Codicon.diffSingle, Codicon.arrowRight],
  transferLineRight: [Codicon.diffSingle, Codicon.arrowLeft],
  transferHunkLeft: [Codicon.diffMultiple, Codicon.arrowRight],
  transferHunkRight: [Codicon.diffMultiple, Codicon.arrowLeft],
};
export type ToolbarIcon = keyof typeof icons;

let tooltip: HTMLDivElement | undefined;
let owner: HTMLButtonElement | undefined;

function hideTooltip() {
  owner?.removeAttribute("aria-describedby");
  owner = undefined;
  if (tooltip) tooltip.hidden = true;
}

function showTooltip(button: HTMLButtonElement, text: string) {
  hideTooltip();
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "toolbar-tooltip";
    tooltip.className = "toolbar-tooltip";
    tooltip.setAttribute("role", "tooltip");
    document.body.append(tooltip);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideTooltip();
    });
    window.addEventListener("resize", hideTooltip);
    window.addEventListener("blur", hideTooltip);
  }
  owner = button;
  tooltip.textContent = text;
  tooltip.hidden = false;
  button.setAttribute("aria-describedby", tooltip.id);
  const anchor = button.getBoundingClientRect();
  const width = tooltip.getBoundingClientRect().width;
  tooltip.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
  tooltip.style.top = `${anchor.bottom + 6}px`;
}

export function toolbarGroup(
  parent: HTMLElement,
  label: string,
  caption?: string,
) {
  const group = document.createElement("div");
  group.className = "toolbar-group";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);
  if (caption) {
    const text = document.createElement("span");
    text.className = "toolbar-caption";
    text.textContent = caption;
    group.append(text);
  }
  parent.append(group);
  return group;
}

export function iconButton(
  parent: HTMLElement,
  icon: ToolbarIcon,
  label: string,
  tooltipText: string,
  action: () => void,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = tooltipText;
  for (const item of icons[icon]) {
    const glyph = document.createElement("span");
    glyph.className = `codicon codicon-${item.id}`;
    glyph.setAttribute("aria-hidden", "true");
    button.append(glyph);
  }
  button.onclick = () => {
    hideTooltip();
    action();
  };
  button.addEventListener("pointerenter", () =>
    showTooltip(button, tooltipText),
  );
  button.addEventListener("pointerleave", hideTooltip);
  button.addEventListener("focus", () => showTooltip(button, tooltipText));
  button.addEventListener("blur", hideTooltip);
  parent.append(button);
  return button;
}
