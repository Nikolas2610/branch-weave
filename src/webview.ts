import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
export function html(
  webview: vscode.Webview,
  extension: vscode.Uri,
  kind: "editor" | "compare" | "files",
): string {
  const nonce = randomBytes(16).toString("hex");
  const asset = (name: string) =>
    webview
      .asWebviewUri(vscode.Uri.joinPath(extension, "dist", name))
      .toString();
  const editor = kind === "editor";
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource} blob:;"><link rel="stylesheet" href="${asset("style.css")}">${editor ? `<link rel="stylesheet" href="${asset("editor.css")}">` : ""}<title>BranchWeave</title></head><body data-view="${kind}" data-worker="${asset("editor.worker.js")}">${editor ? `<header class="editor-header"><div class="title-row"><strong>BranchWeave</strong><span id="position" aria-live="polite"></span><span id="draft-status"></span></div><div id="file-label"></div><div class="toolbar" id="navigation"></div><div class="labels"><span id="left-label"></span><span id="right-label"></span></div><div class="toolbar transfers" id="transfers"></div></header><div id="notice" role="status"></div><main id="editor" aria-label="Branch comparison drafts"></main><footer><span>Transfers edit drafts. Apply updates a working tree; Save persists this session.</span></footer>` : `<main id="sidebar"></main>`}<script nonce="${nonce}" type="module" src="${asset(editor ? "editor.js" : "sidebar.js")}"></script></body></html>`;
}
