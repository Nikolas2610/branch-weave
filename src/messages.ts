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
  "reviewFile",
  "reviewHunk",
  "nextUnreviewed",
  "addNote",
  "deleteNote",
  "exportReview",
  "focusMode",
  "ignoreWhitespace",
  "filter",
  "savePreset",
  "loadPreset",
  "deletePreset",
  "stageHunk",
  "unstageHunk",
  "openRelatedTest",
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
    if (
      [
        "upstream",
        "highlight",
        "flat",
        "focusMode",
        "ignoreWhitespace",
        "reviewFile",
      ].includes(String(m.action))
    )
      return typeof m.value === "boolean" || m.value === undefined;
    const payload = m.value as Record<string, unknown> | undefined;
    if (m.action === "reviewHunk")
      return (
        !!payload &&
        Number.isInteger(payload.index) &&
        Number(payload.index) >= 0 &&
        typeof payload.reviewed === "boolean"
      );
    if (m.action === "stageHunk" || m.action === "unstageHunk")
      return (
        payload === undefined ||
        (!!payload &&
          Number.isInteger(payload.index) &&
          Number(payload.index) >= 0 &&
          typeof payload.token === "string" &&
          /^[a-f0-9]{64}$/.test(payload.token))
      );
    if (m.action === "addNote")
      return (
        payload === undefined ||
        (!!payload &&
          typeof payload.text === "string" &&
          !!payload.text.trim() &&
          payload.text.length <= 4000 &&
          (payload.hunk === undefined ||
            (Number.isInteger(payload.hunk) && Number(payload.hunk) >= 0)))
      );
    if (
      ["savePreset", "loadPreset", "deletePreset", "deleteNote"].includes(
        String(m.action),
      )
    )
      return (
        m.value === undefined ||
        (typeof m.value === "string" &&
          !!m.value.trim() &&
          m.value.length <= 80)
      );
    if (m.action === "filter")
      return typeof m.value === "string" && m.value.length <= 512;
    if (m.action === "openRelatedTest")
      return (
        typeof m.value === "string" &&
        !!m.value &&
        m.value.length <= 2048 &&
        !/[\\\0:]/.test(m.value) &&
        !m.value.startsWith("/") &&
        !m.value
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.toLowerCase() === ".git" ||
              /[. ]$/.test(part),
          )
      );
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
