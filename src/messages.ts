export const actions = [
  "repository",
  "left",
  "right",
  "swap",
  "compare",
  "refresh",
  "upstream",
  "highlight",
  "flat",
  "open",
  "nextFile",
  "previousFile",
  "nextHunk",
  "previousHunk",
  "focusLeft",
  "focusRight",
  "transferLine",
  "transferHunk",
  "undo",
  "redo",
  "reset",
  "export",
  "apply",
  "focusFiles",
  "fileOperation",
  "save",
] as const;
export type Action = (typeof actions)[number];
export function matchesDraftTarget(
  message: {
    sessionId?: unknown;
    index?: unknown;
    version?: unknown;
    fileKey?: unknown;
  },
  sessionId: string,
  index: number,
  version: number,
  fileKey?: string,
): boolean {
  return (
    message.sessionId === sessionId &&
    (message.fileKey !== undefined
      ? message.fileKey === fileKey
      : message.index === index) &&
    message.version === version
  );
}
export function validateMessage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (m.type === "ready") return true;
  if (m.type === "action") {
    if (!actions.includes(m.action as Action)) return false;
    if (m.action === "open")
      return Number.isInteger(m.value) && Number(m.value) >= 0;
    if (["upstream", "highlight", "flat"].includes(String(m.action)))
      return typeof m.value === "boolean" || m.value === undefined;
    if (
      [
        "apply",
        "export",
        "reset",
        "transferLine",
        "transferHunk",
        "fileOperation",
      ].includes(String(m.action))
    )
      return m.value === "left" || m.value === "right" || m.value === undefined;
    return m.value === undefined;
  }
  if (
    m.type !== "draft" ||
    !Number.isInteger(m.version) ||
    Number(m.version) < 0 ||
    typeof m.sessionId !== "string" ||
    !Number.isInteger(m.index) ||
    Number(m.index) < 0
  )
    return false;
  if (m.action === "undo" || m.action === "redo") return true;
  if (m.side !== "left" && m.side !== "right") return false;
  if (m.action === "edit")
    return typeof m.text === "string" && m.text.length <= 2_097_152;
  if (m.action === "transferHunk")
    return Number.isInteger(m.hunk) && Number(m.hunk) >= 0;
  if (m.action === "transferLine")
    return Number.isInteger(m.line) && Number(m.line) >= 0;
  return false;
}
