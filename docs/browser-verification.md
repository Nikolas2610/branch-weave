# Browser verification — 2026-10-25

## Icon toolbar update — 0.1.1

Verified in the built-in Codex browser against the production editor bundle and real DraftPair harness at `http://127.0.0.1:56561/editor?fixture=0&fresh=1`.

| Criterion | Result | Steps and observation |
| --- | --- | --- |
| Icon-only controls and legibility | Passed | At 1280 × 720 all 18 actions render bundled Microsoft Codicons rather than text labels or missing glyphs. Navigation/history and Left/Right actions are grouped; every button has a nonempty accessible action name and description. |
| Pointer tooltip | Passed | Moved the pointer from the title area onto Apply right without activating it; tooltip explained the verified-working-tree action and separate Save behavior. |
| Keyboard tooltip and Escape | Passed | Focused Copy selected line Left to Right using the keyboard; tooltip displayed the explanation and Alt+Shift+Right. Escape hid it. |
| Line and section transfers | Passed | Clicked both line directions and both section directions using their accessible icon names; real draft contents and Modified draft/change indicators updated. |
| History, reset and navigation | Passed | Icon Undo/Redo restored/reapplied the edit; Reset restored snapshot state. Previous/next change and file controls updated indicators; a modified draft survived file navigation. Reset confirmation is simulated in the harness. |
| Narrow editor | Passed | At 600 × 800 every icon button stayed within the viewport; groups wrapped without document overflow and Monaco retained both panes. |
| Unsupported state | Passed | Binary fixture 4 retained disabled transfer buttons and its unsupported-content explanation. |
| Console | Passed | No captured browser warnings or errors. |

Evidence: [icon toolbar and focused tooltip](evidence/toolbar-icons.png). Typecheck, lint, existing core suite (39 passed, 1 Windows skip), and all nine native host smoke checks also passed; native run evidence is `.test-host/9e0048f1-4600-4c8a-860b-aba283e18aef/result.json`. Native Apply/Export dialogs remain outside this presentation-change check.

The temporary server is **stopped**, port 56561 released, registry record `ed79db3f-16e2-4bb8-89d0-1b07045506e7`. Its process identity, start time and OS boot were verified before stopping it. The temporary browser tab was closed and viewport override reset.

Browser: local Chrome through the Codex browser tool. The built-in browser was attempted first; a subagent cannot use its visibility controls. Chrome was the prescribed fallback. No application source was changed by browser QA.

Origin used: `http://127.0.0.1:59760`. Routes below are relative to that origin. Desktop viewport: **1440 × 900** unless specified. Checks use the production `html()` function, latest `dist/editor.js`, Monaco **0.57.0**, worker and CSS, and the production `DraftPair` and message validator. `tests/browser/harness.ts` simulates the VS Code messaging transport and supplies deterministic snapshot fixtures. It does not run the extension host, Git discovery or native prompts. Results establish rendered webview behavior within that boundary.

## Observed checks

| Criterion | Result | Route / viewport | Steps and observed result |
|---|---|---|---|
| Compare controls and directional descriptions | Passed | `/compare`, desktop | Observed repository, Left, Right, Swap, Compare and Refresh controls. With upstream unchecked, description says merge base → Right and explains directional swap. Checked upstream: description changes to current Left/Right tips. Native selection and Git comparison are separate checks below. |
| Changed-line highlighting control | Passed | `/compare` → `/editor?fixture=0&fresh=1`, desktop | Unchecked Highlight changed lines; opened editor. Diff line and character decoration computed backgrounds were `rgba(0, 0, 0, 0)`. Checked again: red/green diff backgrounds returned. |
| File tree, flat list, statuses and counts | Passed | `/files`, desktop and 320 × 800 | Observed src/docs/assets tree, M/A/D/R badges, additions/deletions and binary label. Flat list showed full paths; Folder tree restored directories. At 320px the document had no horizontal overflow. |
| Rename filtering and selected state | Passed | `/files`, desktop | Filtered `OLD NAME`; the `docs/new name.md` rename remained visible via its old path, with `docs/old name.md → docs/new name.md` detail. Opened the row: selected marker and `aria-current=true` moved to it. `no-such-file` showed “No matching changed files.” |
| Real editable Monaco, syntax, numbers and diff | Passed | `/editor?fixture=0&fresh=1`, desktop | Observed two side-by-side Monaco code panes with distinct TS keyword/string/number tokens, line numbers and red/green change blocks. Selected right content and typed `export const edited = 99;`; rendered right draft changed and Modified draft appeared. Both sides were also modified through transfers. |
| Synchronized scroll and change navigation | Passed | `/editor?fixture=0&fresh=1`, desktop | Navigated to change 2 of 2: both panes revealed line 93 (`end = 10` / `end = 20`) with aligned context. Focused right pane and Ctrl+Home: both returned to first lines. Previous/next change updated the position indicator. |
| Line L → R | Passed | `/editor?fixture=0&fresh=1`, desktop | Selected initial line and clicked Line L → R. Right became `value = 1`, retained `console.log("right")`; left stayed unchanged. Modified draft appeared. |
| Line R → L | Passed | Same | Reset right, clicked Line R → L. Left became `value = 2`, retained `console.log("left")`; right stayed unchanged. |
| Section L → R | Passed | Same | Reset left, clicked Section L → R. Right received both left lines (`value = 1`, `console.log("left")`); remaining change count fell from 2 to 1. |
| Section R → L | Passed | Same | Reset right, clicked Section R → L. Left received both right lines (`value = 2`, `console.log("right")`); remaining change count fell to 1. |
| Ambiguous, multiline and unchanged selections | Passed | `/editor?fixture=5` and fixture 0; desktop / 600 × 800 | Two left lines versus one right line: Line L → R displayed “This line mapping is ambiguous. Transfer the whole hunk.” Snapshot stayed unmodified. Section L → R succeeded and showed change 0 of 0. Selecting two lines in fixture 0 displayed the single-line instruction; selecting unchanged context displayed “The selected line is unchanged…” with Snapshot drafts retained. |
| Undo, redo and reset contents | Passed | `/editor?fixture=0&fresh=1`, desktop | After line transfer, Undo restored snapshot values/status; Redo reapplied modified values/status. Reset right restored right snapshot. Reset left restored left snapshot. Reset confirmation itself is simulated. |
| Navigation preserves in-memory drafts | Passed | Same | Made section transfer, File → opened rename file and showed File 2 of 6. ← File restored the modified first draft and transferred text. This does not establish persisted session reopen. |
| Added/deleted file sections | Passed | `/editor?fixture=2` and `fixture=3`, desktop | Added file initially labeled left absent; Section R → L copied content and removed absent label. Deleted file initially labeled right absent; Section R → L made both sides absent, Modified draft, Change 0 of 0. |
| Unsupported binary state | Passed | `/editor?fixture=4`, desktop | Observed binary explanation, empty read-only panes and all four transfer controls disabled. |
| Comparison error and recovery control | Passed | `/compare?fixture=0&error=1`, desktop | With upstream unchecked, observed no-common-ancestor error and Use direct comparison button. Clicked it: direct comparison description appeared, upstream checked and error disappeared. Actual Git error production is not exercised. |
| Responsive editor and keyboard flow | Passed | `/editor?fixture=0&fresh=1`, **600 × 800** | Toolbar wrapped; all controls stayed within 600px, no document overflow, Monaco panes measured 285px each and remained side by side. Alt+Shift+Down updated Change 2 of 2; Alt+Shift+Right transferred line and showed Modified draft; Ctrl+Z restored Snapshot drafts; Alt+Shift+PageDown opened rename file. |
| Browser console | Passed | All exercised routes | Captured browser warning/error logs were empty after the flows, including the final selection error check. |

## Native host checks not established by this harness

| Criterion | Result | Blocker / required environment |
|---|---|---|
| Repository/branch quick picks, swap, Compare and Refresh against actual refs | Unverified | Requires actual VS Code Extension Development Host and repository fixtures. The harness only renders controls and state descriptions. |
| Save/reopen/backup/revert and extension lifecycle persistence | Unverified | Requires native custom document host lifecycle. Only in-memory file navigation was observed here. |
| Reset discard confirmation and draft create/delete/rename prompts | Unverified | Native modal/quick-pick/input prompts are not hosted by a browser page. Transfer-based file existence behavior passed separately. |
| Export save dialog and working-tree Apply confirmations/refusal/rollback | Unverified | Requires extension host, native dialogs and isolated Git working trees. Browser QA did not perform application writes. |
| Workspace trust, virtual workspace and extension focus commands | Unverified | Require VS Code host context. In-page keyboard commands listed above were exercised. |

## Evidence and reproduction

- [Desktop Monaco](../tests/browser/editor-desktop.png)
- [600px editor](../tests/browser/editor-600.png)
- [Desktop changed files](../tests/browser/files-desktop.png)
- [320px changed files](../tests/browser/files-320.png)
- [Unchanged-line error](../tests/browser/error-600.png)

Run `npm run build`, then `node --import tsx tests/browser/harness.ts` from the repository. The harness prints an ephemeral loopback URL. Before starting a server, follow the shared server-memory and reboot-reconciliation instructions. Fixtures: 0 modified TypeScript, 1 rename, 2 added, 3 deleted, 4 unsupported binary, 5 ambiguous mapping. `?fixture=0&fresh=1` starts fresh draft pairs. `/compare` and `/files` render the production sidebars. The harness never invokes Apply or writes a Git working tree.

The QA host server used registry record `faed0326-e3a6-4a29-861a-6350405cfb7b` (port 59760). It was stopped after verification. An earlier sandbox attempt, record `c354b4e1-8e0a-41a9-a96b-d4bd16b39216` (port 63999), was unreachable by the browser and stopped before host launch. Boot timestamp was verified through `Win32_OperatingSystem.LastBootUpTime`: `2026-10-14T17:21:51.5000000+03:00`.

## RGBA theme regression follow-up — final rebuilt bundle

The native-host review found VS Code supplies `rgba()` theme variables. The rebuilt editor now normalizes them for Monaco. The harness accepts `rgba=1` to supply native-style inserted/removed text and line variables. This follow-up used Chrome after the built-in browser reported unavailable; viewport **1412 × 1307**, origin `http://127.0.0.1:55080`.

| Criterion | Result | Route, steps and observed result |
|---|---|---|
| RGBA colors retain distinct hue and alpha | Passed | Opened `/editor?fixture=0&fresh=1&rgba=1`. CSS input text backgrounds were `rgba(255,0,0,0.2)` removed and `rgba(155,185,85,0.2)` inserted; line alpha was 0.13. Actual Monaco decoration computed backgrounds were red `rgba(255, 0, 0, 0.13)` / `rgba(255, 0, 0, 0.2)` and green `rgba(155, 185, 85, 0.13)` / `rgba(155, 185, 85, 0.2)`. The screenshot visibly shows distinct red/green backgrounds. |
| Highlight off stays transparent with RGBA theme | Passed | Opened `/compare`, unchecked Highlight changed lines, then opened `/editor?fixture=0&rgba=1`. All eight visible inserted/removed line and character decorations computed to `rgba(0, 0, 0, 0)`; colored backgrounds disappeared. |
| Final browser console | Passed | Captured warning/error logs after both flows: empty. |

Evidence: [RGBA highlighting on](../tests/browser/rgba-highlight-on.png), [RGBA highlighting off](../tests/browser/rgba-highlight-off.png). No native VS Code interaction was performed by this follow-up. Regression server record `32664840-0ee0-4331-a7d3-bc81aa0f4035`, port 55080, was stopped after verified process identity checks. Boot timestamp remained unchanged.
