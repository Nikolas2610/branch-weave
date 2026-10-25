# Current working branch comparison

The user's correction replaces the saveable comparison document with a reusable WebviewPanel. A selected reference is compared with the checked-out branch's working tree, including staged/unstaged/untracked files and unsaved VS Code buffers. Left retains its explicit reference/merge-base label and optional preview draft; right edits/transfers update guarded real working-file buffers. Save saves that real file, never a comparison-session document. Preview drafts persist automatically in extension workspace storage.

- [x] Git: working-tree discovery and lazy reads with unsaved buffer overlays; meaningful real-Git tests.
- [x] Live buffers: expected-content/branch/path guards, WorkspaceEdit operations, ordinary file Save; pure tests.
- [x] Controller: reusable panel, automatic recovery state, current-branch tracking, buffer synchronization and real-file edits.
- [x] UI: fixed current branch on right; rounded hunk islands, word changes, existing icon controls and actual file Save.
- [x] Verification: typecheck/lint/core and native host tests, rendered UI desktop/narrow/empty/error/keyboard checks, package updated VSIX and report unverified boundaries.

Browser checklist: no session-document save affordance; selected reference and fixed current branch; existing/staged/unstaged/new/unsaved changes; right edit/transfer changes real buffer without saving it; Ctrl+S saves the real file; hunk islands group changes, highlight-off removes them; file/hunk navigation and undo/redo preserve content; conflict/path/branch guards prevent stale overwrites; responsive and keyboard flows remain usable.

Ownership: live_git owns git.ts/Git tests; live_buffers owns live.ts/livePlan.ts/live tests; island_ui owns editor/sidebar/style/toolbar UI; main owns controller/protocol/recovery/native harness/docs/packaging and final verification.
