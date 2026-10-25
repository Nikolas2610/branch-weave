# BranchWeave

**Compare your branch. Review each change. Keep editing.**

BranchWeave brings branch comparison into VS Code. Choose a reference branch, see what changed in your current checkout, and copy individual lines or complete change sections into your working files. Your staged, unstaged, new, and unsaved changes are included.

![BranchWeave comparison with review progress, notes and section tools](docs/evidence/workflow-desktop-review.png)

## Why BranchWeave?

- **Review your work in context.** Browse changed files in a folder tree or flat list, filter by path, and jump between changes.
- **See changes clearly.** Rounded section highlights and inline word differences make edits easy to follow.
- **Move only what you need.** Copy a changed line or a whole section in either direction.
- **Keep working in the comparison.** Edit your current file on the right, then save it with Ctrl+S on Windows/Linux or Cmd+S on macOS.
- **Find tools without a crowded toolbar.** Hover over an icon or focus it with the keyboard to see what it does.
- **Finish a review.** Track reviewed files and sections, keep local notes, and export a Markdown report.
- **Prepare a focused commit.** Stage or unstage individual Git index sections without saving or replacing your working file.
- **Return to your workflow.** Save comparison presets, collapse unchanged context, and inspect changed functions with candidate tests.

## Get started

Once BranchWeave is installed:

1. Open a trusted folder containing your Git repository in VS Code.
2. Select **BranchWeave** in the Activity Bar.
3. Choose your **Repository** if more than one is available.
4. Choose a **Reference branch** to compare against, such as `development` or `main`.
5. Click **Compare**, then select a file under **Changed Files**.

The **Current branch** on the right is the branch already checked out in your repository. Selecting a reference leaves your checkout unchanged.

For example, if you are working on `feature/login`, choose `development` as the reference to review your feature changes alongside edits you have not committed or saved yet.

![Comparison controls with a reference branch selector, current branch, and highlighting options](docs/evidence/branchweave-controls.jpg)

*Screenshots show the BranchWeave interface with sample repository data.*

## Understand the two sides

| Side | What you see | What editing does |
| --- | --- | --- |
| **Left — reference preview** | The comparison baseline from your selected reference. | Changes a preview draft. The reference branch and its commits stay unchanged. |
| **Right — current working file** | Your checked-out branch, including local and unsaved edits. | Updates the actual VS Code file buffer. Use Save to write text edits to disk. |

**Edits on the right affect your working file.** This includes typing, copying from the left, Undo, Redo, and Reset. Text edits stay unsaved until you save the file. Explicit create, rename, or delete operations can affect the filesystem immediately; deleting a working file asks for confirmation.

The comparison opens as a reusable panel. You do not need to name or save a comparison-session file. Closing the panel leaves your working-file edits in VS Code, where normal save and backup behavior applies.

## Review and copy changes

1. Select a changed file. Use the previous/next file icons to move through the list.
2. Use the up/down change icons to jump between highlighted sections.
3. Place the cursor on one changed line and choose **Copy selected line**, or choose **Copy entire change section** to transfer the whole block.
4. Choose the direction: **Left to Right** updates your working file; **Right to Left** updates the reference preview.
5. Review the result and save the working file when ready.

Copying replaces the matching destination content and keeps the source. If a line cannot be matched unambiguously, BranchWeave asks you to copy the whole section instead. A complete added or deleted section can also create or remove a file.

**Undo** and **Redo** let you revisit comparison edits. **Reset** restores the chosen side to its content when the file was opened in the comparison, after confirmation. Hover or keyboard-focus any toolbar icon for its description and available shortcut; press Escape to dismiss the tooltip.

### Change highlighting

Use **Highlight change sections** to show or hide the rounded section backgrounds and inline word highlights. An insertion or deletion with no lines on one side appears as a dashed boundary.

### Save your work

The **Working file unsaved** label means the current file has pending text changes. Click the Save icon or press Ctrl+S / Cmd+S to save that file. Saving does not commit your changes.

![Working-file edits with the Working file unsaved status](docs/evidence/branchweave-unsaved.jpg)

## Choose what to compare

**Include upstream changes** controls the baseline on the left:

| Setting | Comparison | Use it to… |
| --- | --- | --- |
| **Off** | The common ancestor of the reference and your current branch → your working files. | Review changes on your branch since it diverged, including your local edits. |
| **On** | The latest locally available reference commit → your working files. | See all differences from the reference, including changes made only on that reference. |

BranchWeave uses local branches and locally available remote-tracking references. It does not fetch automatically. To compare against newer remote changes, fetch using your usual Git tools, then **Refresh** the comparison.

## Review progress and notes

Use the review icon to mark the current file reviewed. Open **Review & notes** to review an individual section, add a note to the file or current section, and delete notes. **Next unreviewed change** moves to a section or file that still needs attention. The toolbar and changed-file list show progress.

Review completion belongs to the exact file content: editing either side clears the file's completion. Section marks can remain for unchanged, unambiguous sections. Notes stay stored when their section changes, with an **anchor changed** label so you can reassess them.

**Export Markdown** opens a report in the normal VS Code editor. Save or share it when ready. The report includes progress and notes, including saved notes for files no longer in the changed-file list. Notes and review progress are local to the workspace, repository, reference, current branch and comparison mode; they are not uploaded.

## Stage or unstage a section

Open **Git index changes**. This panel has its own sections:

| List | What it compares | Action |
| --- | --- | --- |
| **Unstaged** | The index with the current working-file buffer | **Stage** adds just that section to the next commit. |
| **Staged** | The current HEAD with the index | **Unstage** removes just that section from the next commit. |

Expand a section to inspect its preview before acting. Staging can include unsaved editor text and does not save or alter the working file. Unrelated staged changes are preserved. If the index, branch, HEAD, saved file or live buffer changes during the operation, refresh and select the section again.

The index panel is independent of the reference comparison. A committed branch change can appear in the main editors while having no unstaged index sections. Staging supports the same text-file limits as editing; permission changes should be managed with your usual Git tools.

## Focus mode and whitespace

**Focus changed regions** collapses long unchanged regions while keeping surrounding context. Expand a collapsed region to read more, or toggle focus off to show the whole file.

**Ignore trim whitespace** hides differences caused only by leading or trailing spaces and tabs. Section positions, copying, review anchors and staging retain the exact content mapping. If the current section is hidden by this setting, the position label explains why.

## Save comparison presets

In **Compare Branches**, give the current setup a name and choose **Save preset**. A preset stores the reference branch, upstream mode, highlighting, tree/list layout, focus mode, whitespace option and path filter. Load it to restore those settings, or delete it when no longer needed.

Presets belong to the selected repository. Loading one keeps the currently checked-out branch and uses the normal confirmation before replacing modified reference previews.

## Inspect changed code and candidate tests

Open **Changed symbols & tests** to group JavaScript and TypeScript changes by function, class, method or arrow function. Select a symbol to jump to its location. Deleted symbols point to the reference editor. Other languages, top-level changes and files outside the analysis limits use a file/section fallback.

Candidate tests are suggested from matching filenames or parsed relative imports, including files in conventional `test`, `tests` and `__tests__` folders. Select a candidate to open it in the normal VS Code editor. These are suggestions, not a complete dependency analysis; BranchWeave does not run tests automatically.

## Export or apply a reference preview

Use **Export patch** to save edits from either side as a Git-compatible patch, relative to that side's opening content.

If you edit the left preview and want those edits in another checkout, use **Apply reference draft** and explicitly choose a local branch/worktree. A worktree is a separate folder checked out to a branch. BranchWeave checks the destination before applying and asks you to resolve conflicting content. Save text changes in that destination when ready.

Reference preview drafts are recovered automatically for the workspace and current branch. If changing the comparison would replace a modified preview, BranchWeave asks first.

## Keyboard shortcuts

These defaults apply while the BranchWeave comparison panel is active. You can change them in VS Code's **Keyboard Shortcuts** editor by searching for `BranchWeave`.

| Action | Shortcut |
| --- | --- |
| Save current working file | Ctrl+S / Cmd+S |
| Next / previous file | Alt+Shift+PageDown / PageUp |
| Next / previous change section | Alt+Shift+Down / Up |
| Copy selected line Left → Right / Right → Left | Alt+Shift+Right / Left |
| Copy section Left → Right / Right → Left | Alt+Shift+L / R |
| Focus left / right editor | Alt+Shift+1 / 2 |
| Focus changed files | Alt+Shift+F |
| Toggle upstream comparison | Alt+Shift+U |
| Refresh comparison | Alt+Shift+C |
| Undo / redo comparison edit | Ctrl+Z / Ctrl+Shift+Z; macOS: Cmd+Z / Cmd+Shift+Z |

## Requirements and supported files

- **VS Code 1.95 or newer**, with Git installed and available on your system PATH.
- A **trusted workspace** with a local Git working tree. Virtual workspaces are not supported.
- **UTF-8 text files up to 2 MiB per side**, using consistent LF or CRLF line endings. Files without a final newline are supported.
- Changed-symbol parsing supports JS/TS source up to 512 KiB. Candidate test inspection is bounded to 200 files / 2 MiB and ignores dependency/build folders.
- Review storage holds up to 500 file records and 100 notes per file; a note is at most 4,000 characters. Named presets are limited to 30 per repository. Limits produce an explicit message rather than silently discarding notes.

Binary files, Git LFS pointers, symlinks, submodules, invalid UTF-8, mixed line endings, and oversized files display an unsupported-file message. Permission changes and case-only renames on Windows are not supported. The comparison editor provides syntax highlighting; full language-server features from the normal VS Code editor are not available inside it.

## Common questions

**Why is my repository missing?**

Open its folder in VS Code, or add it as a workspace folder. Automatic discovery searches up to four directory levels and skips dependency and build folders.

**Why is my remote branch missing or out of date?**

Fetch it with your usual Git tools, then Refresh. BranchWeave only uses references and Git objects already available locally.

**Why are there no changed files?**

Clear the path filter and check your reference and upstream setting. Your files may already match the selected baseline. A file whose differences were resolved can remain open for Undo while disappearing from the changed-file list.

**What if the branches have no common ancestor?**

Choose **Use direct comparison** to compare the reference tip with your working files.

**What if a file changes elsewhere while I am editing?**

BranchWeave checks the expected content before applying edits. If it detects a conflict, it shows a reconciliation diff. Saving also uses VS Code's normal handling of external file changes.

**Does BranchWeave switch branches or change Git history?**

No. It does not automatically check out, stash, commit, push, reset Git, or rewrite references. Creating a worktree requires an explicit choice.

**Do I need an account or online service?**

No. BranchWeave runs locally, with no account, backend, telemetry, or runtime dependency downloads.

## License

[MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependencies.
