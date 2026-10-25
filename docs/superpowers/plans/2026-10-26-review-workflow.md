# BranchWeave review workflow implementation

The user explicitly requested all six previously proposed features. Implement the established proposal in the existing local-only extension, retaining published ID `Nikolas2610.branch-lens` and all existing editor/file safety guarantees.

## Scope and decisions

1. Persistent per-file and per-section review progress, content-bound invalidation, next-unreviewed navigation.
2. Stage and unstage actual Git index sections independently of branch comparison hunks; include current unsaved buffer content when explicitly staging, never save/change working files as a side effect. Index/HEAD/branch changes reject stale selections. Atomic index lock and expected-content checks preserve unrelated staged changes.
3. Focus mode collapses unchanged editor regions; whitespace toggle changes presentation without changing the transfer mapping or hiding actual index changes.
4. File/section notes, stale-anchor indication, deletion, Markdown report export. Notes remain local and survive comparison refresh/restart.
5. Named repository comparison presets covering reference, mode, highlight, tree/list, focus, whitespace and path filter. Loading a preset never checks out a branch and preserves normal preview-replacement confirmation.
6. Changed-symbol grouping for JS/TS using the TypeScript parser, file-level fallback for other languages, candidate related tests by filename/import evidence, safe jump to symbols/tests. Candidate tests are suggestions, not a dependency-analysis guarantee.

## Ownership

- Main: `src/workflowTypes.ts`, review/preset model, host controller/protocol integration, manifest/dependencies, docs, native host integration and final delivery.
- Staging worker: `src/staging.ts` and focused staging tests only.
- Impact worker: `src/impact.ts` and focused impact tests only.
- UI worker: `webview/editor.ts`, `webview/sidebar.ts`, `webview/toolbar.ts`, `webview/style.css`, `src/webview.ts`, optional new `webview/workflow.ts`. No host controller/message/manifest edits.
- Separate browser QA after integration; use built-in browser if available, Chrome otherwise, Playwright fallback when neither surface is available. Register and stop every temporary server.

## Webview contract

Shared view types are in `src/workflowTypes.ts`. Existing `file` messages gain `review`, `staging`, `impact`, `focusMode`, `ignoreWhitespace`. Sidebar `state` gains `presets`, `reviewedFiles: number[]`, `reviewProgress: {reviewed,total}`, and the three new settings `focusMode`, `ignoreWhitespace`, `filter`.

New action values:

- `reviewFile`: boolean or undefined; `reviewHunk`: `{index:number, reviewed:boolean}`.
- `nextUnreviewed`, `exportReview`: undefined.
- `addNote`: `{text:string, hunk?:number}`; `deleteNote`: note ID string.
- `focusMode`, `ignoreWhitespace`: boolean or undefined; `filter`: string.
- `savePreset`: name string; `loadPreset`, `deletePreset`: preset ID string (undefined may open native input/pick for command palette).
- `stageHunk`, `unstageHunk`: `{index:number, token:string}` matching the active file staging lists.
- `openRelatedTest`: repository-relative path string. Symbol jumps are local webview navigation using side and 1-based line.

Every active-file mutation retains session/file/version checks. Git index sections are a separate authoritative list; never reuse reference-branch hunks as index coordinates. Review state must also update in `edited` acknowledgements and after external buffer/index changes.

## Validation checklist

- [x] Review/preset pure tests: serialization, exact-content invalidation, duplicate sections, stale notes, Markdown escaping, scoped persistence and unsafe input rejection.
- [x] Staging integration: partial stage/unstage, unrelated staged work preserved, unsaved content, new/deleted/empty files, stale HEAD/index/branch, unsupported content, lock failure, no working-file writes.
- [x] Impact tests: TS/JS functions/classes/methods, deleted symbols, comment/string false matches, candidate test association, unsupported-language fallback.
- [x] Typecheck, lint, existing core/release suite, build/package.
- [x] Native host tests exercise new actions, persistence, real staging and test-file opening.
- [x] Rendered browser checklist for all six features, desktop/narrow, empty/unsupported/stale states. No frontend completion claim with failed/unverified required criteria.
- [x] Independent review of index safety, stale messages, note/preset persistence, and final integration; fix important findings.
- [x] Feature branch PR only; no protected-branch pushes. Keep original user checkout intact.
