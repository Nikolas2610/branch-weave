# BranchWeave 0.3.0 review workflow

All six requested features are implemented: content-bound review progress, safe section staging/unstaging, focus/trim-whitespace presentation, local notes and Markdown export, repository comparison presets, and changed-symbol/candidate-test navigation.

## Validation

| Check | Result |
| --- | --- |
| TypeScript and ESLint | Passed |
| Core/integration tests | 95 passed, 1 Windows executable-bit skip; 96 total |
| Release tests | 31 passed |
| Native VS Code 1.143.1 host | 14 checks passed |
| Real browser, 1440×900 and 600×800 | All six workflow groups passed, including responsive/error/empty/stale states |
| Independent code review | Important findings fixed with regressions; no unresolved important findings |

Native evidence: `.test-host/4b356399-12d0-4609-859c-f053227ffdc6/result.json`. Full suite output: `.test-host/review-workflow-tests.log`. These paths are local, ignored test artifacts.

The native host proves real buffer edits, actual Git index stage/unstage without saving working files, unchanged unrelated index content/HEAD, notes/review invalidation and panel reopen, real Markdown report creation, preset mode restoration without checkout, and opening a safe candidate test in VS Code.

The [browser report](workflow-browser-verification.md) gives each criterion, route, viewport, steps and observed result. Its bridge simulates index mutations/test opening; real effects are established separately by native/Git integration tests. Model serialization and native panel reopen are verified; a full VS Code restart/persistence round-trip and interactive native conflict/Quick Pick dialogs have not been manually exercised in this release.

## Safety findings addressed

- Index tokens bind saved content and live buffers independently, including file existence and mode; equivalent object property ordering cannot change token identity.
- Exclusive Git index locks, isolated temporary indexes, unrelated-entry comparison and final disk/HEAD/ref/index/live-buffer checks prevent stale publication.
- Review completion requires the exact file fingerprint; repeated ambiguous anchors invalidate conservatively and notes are not silently evicted at storage limits.
- Markdown export retains notes for files outside the current changed-file list.
- Duplicate Monaco full-text events no longer advance client revision twice; arrow-function typing/Undo/Redo regression passed in the browser.
- Ignoring trim whitespace removes custom islands/inline emphasis for trim-only changes while preserving exact host mappings.
- Candidate tests include conventional test folders with parsed import evidence, not just `.test`/`.spec` suffixes.

## Limits

Text and index operations retain the extension's 2 MiB UTF-8/uniform-line-ending restrictions. Symbol parsing is JS/TS up to 512 KiB, with file-level fallback. Candidate test inspection is bounded and advisory; it does not resolve every alias or provide whole-program dependency analysis. Notes/presets stay in workspace storage, scoped to the repository/comparison, and are not uploaded. Staging text preserves existing index permissions; use normal Git tools for permission changes.

## Cleanup

QA browser session closed; native hosts exited. The temporary server at `http://127.0.0.1:58217` is stopped. Registry record `93d258df-efc2-402a-b5f2-a8c9b93ebfb3` records process/boot identity and verified listener absence; the earlier fixture-correction record `0a540bbe-fddc-423a-8cd1-619591798d1d` is also stopped. No stop action is required.

Implementation is isolated on `codex/review-workflow`; the user's renamed `branch-weave` checkout was preserved. Package identity remains `Nikolas2610.branch-lens`, display name BranchWeave. No direct push to `main` or `development` is used.

## Installable package

`branch-lens.vsix` was built with the prepublish hook and verified as BranchWeave 0.3.0 / `Nikolas2610.branch-lens`, with the bundled TypeScript parser and without source, tests, source maps, QA server artifacts or before-fix captures. SHA-256: `AFBD9703EE5F8AE19FCD627EB8515D1E438FD23345C9A659B6DB7B79027A5BC1`.
