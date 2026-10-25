# BranchLens Implementation Plan

Goal: Deliver the complete installable TypeScript extension described in the supplied request.

Architecture: immutable SHA-resolved Git endpoints feed lazily loaded file snapshots. A locally bundled Monaco diff editor renders editable, persistent session drafts. A stable VS Code custom editor owns draft lifetime and save/close confirmation; explicit working-tree application verifies original content and buffers before WorkspaceEdit.

Defaults: VS Code 1.95+, Node tooling, Monaco, diff package, no backend or telemetry. The user explicitly authorized reasonable defaults and proceeding without design questions. Native vscode.diff lacks public bidirectional hunk/line mapping APIs; use Monaco public APIs instead.

- [x] Git layer: argument arrays, NUL-safe rename/count parsing, merge-base and direct sessions, cache, worktrees, integration fixtures.
- [x] Draft layer: exact text/EOL/existence, versioned mappings, both transfer directions, line ambiguity rejection, undo/redo/reset/export, integration tests.
- [x] Host and UI: two views, branch quick picks, tree/filter/status, custom draft document, Monaco controls, commands, per-repository settings, trust/CSP/message validation.
- [x] Apply: select verified branch/worktree, optional explicit creation, baseline and unsaved-buffer conflict diff, WorkspaceEdit file operations, separate saving.
- [x] Verify: typecheck, lint, tests, package, browser checklist and development host smoke where supported; document exact remaining limitations.

Browser checklist: sidebar controls/selectors and modes; tree/status/filter/selection; Monaco aligned syntax-highlighted sides and labels; all four transfers and ambiguous selections; undo/redo/reset/draft preservation; highlight toggle; file/hunk navigation; responsive and keyboard states; apply conflict and close guard.

Review focus: snapshots never mutate refs; no automatic fetch/checkouts; stale requests/transfers rejected; absent and empty files distinct; no silent overwrite of external/unsaved edits; paths/symlinks safe; immutable endpoints across the session.

Verification evidence: docs/browser-verification.md and docs/host-verification.md. Core suite: 39 passed, one Windows permission skip. Native Reset/Export/Save As/Apply and close-confirmation interactions remain unverified because the automation tool detected user input/minimized windows; this limitation is retained in delivery, not inferred from other checks.
