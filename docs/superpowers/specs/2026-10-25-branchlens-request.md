Build a VS Code extension called **BranchLens** using TypeScript.

The goal is a PhpStorm-inspired branch comparison workflow: choose two Git branches, browse changed files in the sidebar, open a side-by-side diff, and transfer individual lines or complete change sections between the two sides.

Deliver a working, installable extension, not just a design or scaffold.

## 1. Sidebar structure

Create a dedicated BranchLens Activity Bar container with two vertically stacked, collapsible views.

### First view: Compare Branches

Include:

- Repository selector for workspaces containing multiple Git repositories.
- Searchable Left Branch and Right Branch selectors.
- Support local branches and locally available remote-tracking branches.
- Default Left Branch to `development` when available and Right Branch to the current branch.
- Swap Branches button.
- Compare and Refresh buttons.
- A switch named **Include upstream changes**.
- A brief description of the active comparison mode.
- A **Highlight changed lines** toggle controlling line and inline highlighting inside the diff editor. File status colors remain visible regardless.
- Remember selections and preferences per repository.

Branch selection must not check out either branch. Remote-tracking refs reflect local Git data; do not automatically fetch.

### Second view: Changed Files

Display the comparison results as a folder tree, with an optional flat-list mode.

Each file should show:

- Its name and path.
- Added, Modified, Deleted, or Renamed status, using VS Code theme-aware colors and status indicators.
- Added/deleted line counts when available.
- Old and new paths for renamed files.
- A selected-file indicator.

Include:

- File-path filtering.
- Total changed-file count.
- Refresh action.
- Loading, empty, and error states.
- Clear messaging for binary files and unsupported content.

Clicking a file opens its side-by-side comparison in the main editor area.

## 2. Exact Git comparison semantics

The switch must distinguish these two modes:

**Include upstream changes OFF: branch changes only**

Compare the merge base of Left and Right against Right:

`git diff Left...Right`

For example, if a feature branch started from development, show the feature branch changes since their merge base. Do not show changes introduced exclusively on development afterward.

The actual editor sides must match this comparison: merge-base content on the left and Right branch content on the right. Clearly label the left side as a merge-base snapshot, not the current Left branch tip.

**Include upstream changes ON: all branch differences**

Compare the current tips directly:

`git diff Left Right`

Show all differences between those two snapshots, including changes present only on Left.

Resolve refs to commit SHAs for each comparison session. Use the same resolved endpoints for file discovery, counts, and content loading.

Switching modes or swapping branches must recompute the comparison. Explain that branch-only mode is directional.

If there is no merge base, show an actionable error and allow switching to direct comparison.

This switch is unrelated to uncommitted local changes.

## 3. Side-by-side diff editor

Open:

- Left snapshot on the left.
- Right snapshot on the right.
- Clear branch, commit, and merge-base labels where relevant.
- Syntax highlighting.
- Line numbers.
- Aligned change sections and synchronized scrolling.
- Added/deleted line highlighting and inline word changes when enabled.
- Previous/next change controls.
- Previous/next file controls.
- A visible position indicator such as “File 3 of 12 · Change 2 of 5”.

Reuse one comparison editor when navigating files by default.

Use supported stable VS Code APIs. First verify whether the native diff editor exposes enough functionality for the required bidirectional line/hunk controls. If not, use a custom webview with a locally bundled Monaco diff editor or another justified editor implementation.

Do not rely on private VS Code DOM access, proposed APIs, or undocumented internal commands. Do not silently omit transfer functionality because the native editor cannot provide it.

## 4. Transfer lines and sections

Provide visible controls for:

- Copy selected line change Left → Right.
- Copy selected line change Right → Left.
- Copy entire change section/hunk Left → Right.
- Copy entire change section/hunk Right → Left.

Transfers replace the corresponding destination content; they do not remove content from the source.

Support insertions, deletions, replacements, unequal line counts, and changes at the beginning/end of a file. Recompute change mappings after every edit. Handle ambiguous line selections explicitly rather than guessing.

### Drafts and applying changes

Git commit snapshots are immutable. Never present an edit as if it directly modified a branch commit.

- Start each side from its comparison snapshot.
- Transfers modify editable session drafts.
- Clearly mark modified drafts and provide Undo, Redo, Reset Side, and Export Patch actions.
- Preserve drafts when navigating files; warn before discarding them during session changes or closing.
- Provide an explicit **Apply Draft to Working Tree** action.

Applying a draft must target real files belonging to the intended branch:

- Use the open working tree if it has the intended branch checked out.
- Otherwise use an existing worktree for that branch or offer an explicit action to create one.
- Never automatically switch the user's active branch, stash changes, commit, push, reset, or rewrite refs.
- If a remote-tracking branch needs an editable destination, require selection or creation of a local branch/worktree.
- Merge-base snapshots have no writable branch destination. Allow their drafts to be exported or applied to an explicitly selected working tree.

Before applying, verify that the destination still matches the expected starting content. If it differs, show a reconciliation diff instead of overwriting it. Include unsaved VS Code buffers in this check.

Use VS Code document editing APIs for open files and preserve undo behavior. Clearly separate Apply from Save.

Handle file creation, deletion, and renames as explicit file operations, not as empty-text replacements.

## 5. Keyboard navigation

Expose commands for:

- Next/previous changed file.
- Next/previous change section.
- Focus changed-files view.
- Focus left/right editor.
- Transfer selected line change in either direction.
- Transfer current section in either direction.
- Toggle upstream comparison mode.
- Refresh comparison.

Contribute configurable default keybindings with `when` clauses scoped to BranchLens. Avoid overriding common editor shortcuts globally.

Show shortcuts in tooltips and document them in the README. Ensure toolbar actions and shortcuts invoke the same commands.

## 6. Reliability and implementation

- Use TypeScript with separated Git, comparison, draft, editor, and sidebar layers.
- Execute Git with argument arrays, never interpolated shell commands.
- Handle unusual filenames using NUL-delimited output.
- Detect renames.
- Distinguish missing files from empty files.
- Handle spaces, Unicode paths, CRLF/LF, missing trailing newlines, binary files, and large files.
- Explain unavailable remote content or Git LFS content instead of showing misleading text.
- Load file contents lazily and cache them by commit SHA and path.
- Cancel or ignore outdated requests when selections change quickly.
- Refresh appropriately after relevant Git changes.
- Respect Workspace Trust.
- Bundle all webview assets locally, validate messages and paths, and apply a restrictive CSP.
- Match VS Code themes and support keyboard accessibility.
- Do not require a backend, account, paid service, or telemetry.

## 7. Verification

Create temporary Git repositories for meaningful integration tests covering:

- Branch divergence: a feature-only change and an upstream-only change.
- Branch-only mode excluding upstream-only changes.
- Direct mode including both sets of differences.
- Correct editor content matching each mode's actual endpoints.
- Swapped branches and unrelated histories.
- Added, deleted, renamed, and empty files.
- Line/hunk transfers in both directions, including unequal line counts.
- Undo/redo and stale draft mappings.
- Applying changes to the correct working tree.
- Refusing to overwrite changed files or unsaved buffers.
- Paths containing spaces and Unicode, CRLF, and missing trailing newlines.

Run type checks, lint, tests, and extension packaging. Perform an Extension Development Host smoke test if the environment supports it; otherwise state clearly which interactive checks remain unverified.

## 8. Deliverables

Provide:

- Complete extension source.
- Development launch configuration.
- An installable `.vsix`.
- README with installation, usage, keyboard shortcuts, comparison semantics, draft/apply behavior, and limitations.
- A concise final report with implemented behavior, verification results, and remaining limitations.

Inspect the existing repository first and follow its conventions. If it is empty, initialize the extension project.

Write a concise implementation plan, choose reasonable technical defaults, and proceed with implementation. Ask only when a missing answer genuinely blocks implementation. Do not stop after planning.