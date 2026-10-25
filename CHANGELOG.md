# Changelog

## 0.3.0

- Add persistent file/section review progress and next-unreviewed navigation.
- Add local file/section notes, stale-anchor labels and Markdown reports retaining notes outside the current changed-file list.
- Stage and unstage actual Git index sections with snapshot/lock guards, preserving working files and unrelated staged changes.
- Add focus mode and trim-whitespace presentation controls while retaining exact transfer mappings.
- Save, load and delete repository comparison presets, including path filters and display settings.
- Group changed JS/TS symbols and suggest candidate related tests with safe editor navigation.
- Prevent duplicate Monaco content events from desynchronizing edit acknowledgements.

## 0.2.0

- Publish as **BranchWeave**; internal command IDs and the `branch-lens` package identity remain compatible with development builds.
- Compare a selected reference with the checked-out branch, including staged, unstaged, new and unsaved changes.
- Edit actual working-file buffers on the right; Save writes the current file to disk.
- Use a reusable comparison panel with automatic preview recovery.
- Review rounded change sections with inline differences and empty-side boundaries.
- Copy selected lines or entire sections in either direction, with Undo and Redo.
- Navigate with icon tools, descriptive tooltips and keyboard shortcuts.
- Export patches and explicitly apply reference drafts to local worktrees.

## 0.1.1

- Replace text toolbar actions with icons and accessible tooltips.

## 0.1.0

- Initial branch comparison and editable preview implementation.
