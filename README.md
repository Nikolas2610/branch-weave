# BranchLens

Compare a Git reference branch with the branch you currently have checked out. Browse changed files, inspect isolated change sections, and copy lines or sections into the real working files.

## Install and develop

Requires VS Code 1.95+ and Git on PATH. Run **Extensions: Install from VSIX…**, select `branch-lens-0.2.0.vsix`, and reload the extension if VS Code requests it. There is no backend, account, telemetry, automatic fetch or runtime dependency installation.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run package
```

Press F5 and choose **Run BranchLens** for an isolated Extension Development Host. `npm run test:host` runs the native smoke suite against disposable Git fixtures using installed VS Code. Set `VSCODE_EXECUTABLE_PATH` for a nondefault installation.

## Compare with the current branch

1. Open **BranchLens** in the Activity Bar and select a repository.
2. Select the **Reference branch** on the left. Searchable local and locally available remote-tracking references are supported. The default is `development` when available.
3. The right side always follows the **Current branch**: the checkout already open in that repository. It includes staged, unstaged, nonignored untracked files, and unsaved VS Code file buffers. It is not another branch selector.
4. Choose **Compare**. Browse the **Changed Files** folder tree or flat list, filter paths, and open a file. Status, old/new rename paths and available line counts remain visible.

Selecting a reference does not check out either branch. BranchLens does not fetch, including lazy fetching of missing promisor objects. Refresh/hydrate remote data manually with your usual Git workflow when needed. Repository discovery is bounded to 250 directories/four levels and skips dependency/build directories; add deeper repositories as workspace folders.

## Comparison modes

**Include upstream changes off:** resolve the merge base of the reference branch and current HEAD. Compare that immutable base with the **current working tree**, including local and unsaved changes. This extends the branch-only `Reference...HEAD` comparison to your working files and excludes changes introduced exclusively on the reference after divergence.

**Include upstream changes on:** compare the reference tip directly with the **current working tree**, including changes present only on the reference and all local edits.

The left label identifies its exact commit/merge-base SHA. The right label explicitly identifies the current working tree. A missing merge base has an action to enable direct comparison. Checkout changes are detected; a stale edit is refused if its intended branch or expected content no longer matches. BranchLens never switches branches automatically.

## A comparison panel, not a new file

BranchLens opens one reusable **comparison panel**. It is not a `.branchlens` document, has no unsaved-file dot, and never needs Save/Save As for a comparison session. Closing it does not prompt to save a session file. The panel can reopen from the changed-file view; preview state is recovered automatically in extension workspace storage per repository/current branch.

**Right-side edits are real working-file edits.** Typing and Left → Right transfers update the actual VS Code file buffer through `WorkspaceEdit`, preserving normal editor undo. They do not automatically save the file. The **Working file unsaved** label and Save icon indicate pending file changes. Ctrl/Cmd+S or the Save icon saves that real current file; neither action creates a session file or commits anything. Closing BranchLens leaves the real working buffer available to VS Code, with its ordinary save/backup behavior.

The left is an editable **reference preview draft**. Copying Right → Left or typing there changes the preview only, never a Git commit. Modified reference previews are automatically stored. Changing the comparison warns before replacing them. Export a patch or use the explicit left Apply action if you need those preview changes elsewhere.

Versions before 0.2 used saveable `.branchlens` comparison documents. Version 0.2 no longer creates or associates those files; existing explicitly saved files remain on disk.

## Change-section islands and tools

Changed sections are inset, rounded **islands** with subtle theme-aware backgrounds and borders. Inline word changes remain visible within them. A dashed boundary marks an insertion/deletion with no source lines on one side. **Highlight change sections** hides both the islands and inline highlights; file status colors remain available.

The editor provides syntax coloring, line numbers, aligned sections, synchronized scrolling, previous/next file and section actions, and position indicators. A resolved file can remain open for Undo while disappearing from the actual changed-file tree. The panel explains that it has no remaining branch differences.

All toolbar actions use locally bundled Microsoft Codicons. Pointer hover or keyboard focus shows an explanation and shortcut; Escape dismisses the tooltip. Buttons have accessible names and Left/Right grouping.

- **Copy selected line Left to Right / Right to Left** replaces the matching destination line. Sources are retained. Unequal replacements without a unique mapping, multiple selected lines, and deletions without a source line explicitly require the whole section.
- **Copy section Left to Right / Right to Left** transfers the complete change section, including file existence for complete additions/deletions. A missing file is different from an empty file.
- **Undo / Redo** operate on the current file's comparison edits. Right-side undo/redo updates the real buffer and remains unsaved until Save.
- **Reset** returns the selected side to its opening content after confirmation. On the right, this changes the real buffer.
- **File operations** explicitly create, delete or rename a preview/working file. Working-tree file operations can affect the filesystem immediately and retain VS Code workspace-edit undo. Right-side deletion asks for confirmation. Copying retains the destination path; use Rename to change it.
- **Export** writes a Git-compatible unified patch relative to that side's opening baseline. Whole-file context preserves exact line endings and missing final newlines.
- **Apply left** explicitly selects a verified local branch/worktree for a reference preview. A merge-base or remote-tracking reference needs an explicit writable local target. Creating a worktree is offered only through explicit dialogs.

Working edits verify safe paths, current branch, file existence and expected buffer content, including unsaved buffers, before applying. A changed buffer is not overwritten; a reconciliation diff is shown. Applying a left preview also verifies disk content and rename destinations. Normal Save uses VS Code's usual external-disk-conflict handling. No action automatically stashes, commits, pushes, resets or rewrites refs.

## Keyboard shortcuts

Defaults are scoped to the active BranchLens panel. They can be rebound in Keyboard Shortcuts; toolbar and keyboard commands share the same action path.

| Action | Default |
| --- | --- |
| Save current real working file | Ctrl/Cmd+S |
| Next / previous file | Alt+Shift+PageDown / PageUp |
| Next / previous section | Alt+Shift+Down / Up |
| Focus changed files | Alt+Shift+F |
| Focus reference / current editor | Alt+Shift+1 / 2 |
| Copy selected line L → R / R → L | Alt+Shift+Right / Left |
| Copy current section L → R / R → L | Alt+Shift+L / R |
| Toggle upstream mode | Alt+Shift+U |
| Refresh comparison | Alt+Shift+C |
| Undo / redo comparison edit | Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z |

## Limits and verification

- UTF-8 text up to 2 MiB per side is supported, including uniform LF/CRLF and missing trailing newlines. Binary files, invalid UTF-8, mixed/standalone-CR endings, LFS pointers, symlinks, submodules and oversized content show explicit unsupported states.
- Unsupported permission changes, executable-file creation, unsafe paths, symbolic-link ancestors and case-only renames on Windows are refused. Git-compatible patch export preserves content that cannot be represented by a native VS Code text edit.
- Large/complex line comparisons use a bounded computation budget and may fall back to a larger section. Undo history is bounded to 50 snapshots and a 16 MiB budget per file pair.
- Monaco language grammars are bundled; full language-server/editor integrations are outside this embedded editor. The extension uses stable public VS Code and Monaco editor APIs, restrictive CSP, validated messages and local assets.
- Workspace Trust and a local filesystem are required. Disk is not locked against external programs; ordinary VS Code save reconciliation still applies.

The native host suite checks the non-document panel, working-buffer edits, real-file Save, Undo on resolved sections, live discovery after edits and preservation of Git HEAD/current checkout. Pure integration tests cover divergence, unrelated histories, file operations, partial clones/no automatic fetch, unsaved conflicts, path safety, line endings and detached HEAD identity. See [working-tree browser verification](docs/current-working-tree-browser.md) and [delivery report](docs/DELIVERY.md) for actual evidence and remaining interactive boundaries.
