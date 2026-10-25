# BranchLens 0.2.0 delivery — current working tree

Install `branch-lens-0.2.0.vsix` with Extensions: Install from VSIX. This release implements the user's corrections to comparison lifetime, current-branch editing, and section highlighting. Source and F5 launch configuration remain in this workspace.

## Result

- The comparison is a reusable `WebviewPanel`, not a CustomDocument. There is no comparison-file URI, unsaved dot, Save As requirement, or session-save prompt on close. BranchLens supplies its own tab icon. Preview recovery is automatic in extension workspace storage, separated by repository/current branch.
- The left selector chooses a reference. The right side follows the checked-out branch and its real working tree, including staged, unstaged, nonignored untracked and unsaved file-buffer changes. Switching references never checks out or fetches a branch.
- Right-side typing, transfers, Undo and Redo update the actual VS Code working-file buffer with expected-content/branch/path guards. They do not save it automatically. Save/Ctrl+S saves the real file through normal VS Code behavior. Left-side edits remain explicitly labeled reference preview drafts.
- Changes are rounded, inset section islands with inline word emphasis. Empty sides have an explicit dashed change boundary. Highlight off removes section/inline highlighting. Keyboard navigation, icon tooltips and both transfer directions remain available.
- Automatic refresh continues discovering new files after edits. Stable session/file identities reject stale changes while preserving pending typing through list reordering. A resolved active file can stay pinned for Undo without inflating the changed-file count.

## Verified

| Check | Evidence/result |
| --- | --- |
| TypeScript, lint, build, packaging | Passed |
| Core/integration suite | 56 passed, 0 failed, 1 Windows executable-bit skip |
| Native VS Code 1.143.1 host | 10 checks passed; `.test-host/ceaa1124-ee11-4890-a36a-a2fd96a4c1a2/result.json` |
| Rendered UI | Desktop 1440×900 and narrow 600×800; all requested functional/visual criteria passed, including corrected side-specific accessibility names |
| Review | Independent focused reviews of live Git integration, branch identity, panel disposal, stable file mappings, and write preflight; reported important findings fixed |

The native suite uses public VS Code APIs and the actual rendered webview command bridge. It verifies a non-dirty panel; initial unsaved/new-file inclusion; actual unsaved buffer changes; line and section transfer plus Undo/Redo; preserving unrelated local lines; automatic discovery after editing; reopening without a session-save prompt; saving real disk content; and unchanged Git HEAD/current checkout. An initial late-file test assertion was corrected to use Windows case-insensitive path identity.

Detailed browser criteria, routes, steps, viewports and screenshots: [current working-tree browser verification](current-working-tree-browser.md). Those browser tests simulate only the messaging transport and Save state; real document/disk behavior is established separately by the native suite.

## Limits and remaining checks

Native reference-selection/worktree/file-operation confirmation dialogs and external-disk-conflict Save prompts have not been manually exercised in this release. Their pure preflight/path/buffer tests pass, and ordinary actual-file Save is native-tested. The existing explicit Apply-left workflow remains available for preview drafts; it does not change the right-side live-edit behavior.

UTF-8 snapshots are limited to 2 MiB and uniform LF/CRLF. Binary, LFS pointer, submodule, symlink, invalid UTF-8, mixed-ending and oversized content is explicitly unsupported. Executable permission changes and unsafe paths are refused. Modified reference previews can pause automatic comparison replacement to preserve their contents; Refresh asks before replacing them. Real working buffers remain intact.

The extension does not commit, push, stash, reset, automatically check out branches, or fetch missing objects. There is no telemetry, account, backend or paid service.

## Cleanup

QA web servers are stopped, with boot/PID/start-time/listener reconciliation retained in `C:\Users\Nikolas\Documents\Codex\server-memory`:

| Registry record | Former URL | Status |
| --- | --- | --- |
| `48a4bd17-79ba-40c8-b575-72ea1248ced7` | `http://127.0.0.1:64281` | Stopped |
| `11e9cc4a-ad93-4d35-a783-c592a6d03e31` | `http://127.0.0.1:64222` | Stopped |

Both ports were checked closed before delivery; no stop action is needed. Isolated native test hosts exited normally, and no normal user VS Code profile was modified.
