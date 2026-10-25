# Current working tree and hunk islands: rendered browser checks

Verified 2026-10-25 with the built-in Codex Browser (in-app Chromium), using `node --import tsx tests/browser/harness.ts` and the built production webview assets. Origin: `http://127.0.0.1:64281`. Viewports: desktop 1440×900 and narrow editor/sidebar 600×800. Each `fresh` fixture navigation resets test-only DraftPair state.

The final accessibility correction was verified in Chrome at origin `http://127.0.0.1:64222` because the built-in browser was unavailable when the follow-up began. Chrome was selected after an actual built-in browser availability failure, following the required fallback order.

The harness renders the real webview and uses the real DraftPair transfer/history implementation. Its bridge supplies current-branch labels, `rightWorkingTree`, `rightUnsaved`, `leftDirty`, and session/index/version acknowledgements. **Save is simulated in memory. This report does not establish native VS Code TextDocument integration, native Quick Pick behavior, disk persistence, native dirty tabs, save conflicts, reload persistence, or checkout behavior. Those require extension-host verification.**

| Criterion | Result | Route / viewport | Steps and observed result |
| --- | --- | --- | --- |
| Fixed current branch; reference remains selectable; no Right selector or Swap | Passed, rendered UI | `/compare?fixture=0&fresh=8`, 600×800 | Observed Reference branch · Left as a button and Current branch · Right as static `feature/current`. No right-selection or Swap button exists in the rendered control tree. Working-tree/unsaved explanation is visible. Native reference selection is outside this harness. |
| Inset rounded islands on both sides with inline changes | Passed | `/editor?fixture=0&fresh=1`, 1440×900; `/editor?fixture=0&fresh=7`, 600×800 | Observed continuous red reference and green working regions across the first two changed lines, with independent inline character emphasis. Decoration pseudo-elements have horizontal 8px inset and 6px top/bottom corner radii. Shared context remains unfilled. |
| Zero-length added/deleted side boundary | Passed | `/editor?fixture=2&fresh=9` and `fixture=3`, 600×800 | Added file shows a dashed reference-side boundary and “empty side · change boundary”, green working island, and reference `file absent`. Deleted file shows the matching working-side boundary, red reference island, and working `file absent`. |
| Highlight off removes islands and inline emphasis | Passed | `/compare?fixture=0&fresh=11` → `/editor?fixture=0`, 600×800 | Unchecked Highlight change sections, loaded editor preserving the fixture setting, and observed plain unfilled changed lines with no inline emphasis. DOM inspection found zero island/boundary and inline change elements. |
| Copy selected line Left to Right | Passed | `/editor?fixture=0&fresh=1`, 1440×900 | Clicked line-copy control at initial first-line cursor. Working first line changed from value 2 to 1; second line remained `console.log("right")`. Outbound draft message has `transferLine`, side `left`, line 0, hunk 0, version 0, and current session/index. Status becomes Working file unsaved. |
| Copy selected line Right to Left | Passed | `/editor?fixture=0&fresh=2`, 1440×900 | Clicked reverse line-copy control. Reference first line changed from value 1 to 2 while its second line remained `console.log("left")`. Message side is `right`; status becomes Reference draft modified. |
| Copy section Left to Right | Passed | `/editor?fixture=0&fresh=3`, 1440×900 | Clicked section control. Both working changed lines match the reference value 1 and `console.log("left")`. Message action is `transferHunk`, side `left`; Working file unsaved is visible. |
| Copy section Right to Left | Passed | `/editor?fixture=0&fresh=4`, 1440×900 | Clicked reverse section control. Both reference changed lines match the working value 2 and `console.log("right")`. Message side is `right`; Reference draft modified is visible. |
| Right typing updates text and unsaved labels | Passed, bridge only | `/editor?fixture=0&fresh=6`, 1440×900 | Clicked visible working first-line text, pressed Ctrl+Home, typed `// qa `. Observed `// qa export const value = 2;`, Working file unsaved, and `· unsaved` in the right label. Six edit messages advanced versions 0 through 5 with current session/index; host acknowledgement mapping restored islands. |
| Save icon | Passed, simulated only | `/editor?fixture=0&fresh=5`, 1440×900 | Copied one reference line into working, clicked Save current file. Message action `save`, version 1, session/index matched the active file. Simulated globalstatus cleared unsaved text and showed Working file saved. |
| Ctrl+S while editor focused | Passed, simulated only | `/editor?fixture=0&fresh=6`, 1440×900 | After typing, pressed Ctrl+S with the working editor focused. Outbound Save carries version 6 and active session/index. Unsaved labels clear to Working file saved. No browser Save dialog opened. |
| Undo and Redo | Passed | `/editor?fixture=0&fresh=4`, 1440×900 | After reverse section copy, clicked Undo then Redo. Undo restored original reference and Working file saved status; Redo restored copied reference and Reference draft modified. |
| Change and file navigation, including keyboard | Passed | `/editor?fixture=0&fresh=7`, 1440×900 | Next section changed position from Change 1 of 2 to 2 of 2 and scrolled to the final changed line. Alt+Shift+Up returned to 1 of 2. Alt+Shift+PageDown opened renamed `docs/old name.md → docs/new name.md`; Previous changed file returned to `src/example.ts`. |
| Tooltip and keyboard focus | Passed for toolbar | `/editor?fixture=0&fresh=10`, 1440×900; narrow editor at 600×800 | Keyboard focus on Save displayed “Save the current working file to disk · Ctrl/Cmd+S”. At 600px, Tab from Save focused Reset and displayed its complete wrapped tooltip. Focus outline and all toolbar controls remained within the viewport. |
| Responsive editor | Passed | `/editor?fixture=0&fresh=7`, 600×800 | Right actions wrap to a second row, branch labels wrap, transfers remain visible, editors remain side by side. No document-level horizontal overflow; every header button's bounding rectangle is within 600px. |
| Multi-line line-copy error | Passed | `/editor?fixture=0&fresh=10`, 1440×900 | Selected first two reference lines using Ctrl+Home then Shift+Down; clicked selected-line copy. Observed “Select exactly one changed line, or use Section to copy the whole change.” No draft message was sent and contents stayed unchanged. |
| Binary error/read-only state | Passed | `/editor?fixture=4`, 600×800 | Observed Binary files cannot be edited as text, all four copy buttons disabled, and empty editors. Clicked working text surface and typed `x`; no text changed and protocol log remained ready-only. |
| Unrelated-history error recovery | Passed, fixture only | `/compare?fixture=0&error=1`, 600×800 | Observed No common ancestor notice and Use direct comparison action. Clicking it checks Include upstream changes, clears the notice, and updates the comparison explanation. Actual Git history lookup is not simulated. |
| Changed-file selection and no-results state | Passed | `/files?fixture=0`, 600×800 | Filtered to `does-not-exist`: No matching changed files. Filtered to `added`, clicked A src/added.ts: selected arrow moved to added.ts. |
| Native working-file lifecycle and branch safety | Unverified here | VS Code extension host | A browser bridge cannot prove real disk writes, save participants/prompts, ordinary native editor synchronization, dirty-tab lifecycle, checkout/fetch absence, or branch-switch refresh. Parent's native-host checks own this proof. |
| Side-specific editor accessibility names | Passed after correction | `http://127.0.0.1:64222/editor?fixture=0&fresh=1`, 1440×900 and 600×800 | Loaded latest bundle and observed the actual EditContext textbox names in both DOM attributes and accessibility snapshot: “Reference branch draft, editable” and “Current branch working file, editable; Save writes to disk”. Copied selected line Left to Right at desktop size and confirmed working value changed 2 → 1, Working file unsaved appeared, and both names remained correct after the file response. Reloaded at 600×800; both names remained correct. The earlier missing/undefined names are resolved. |

No error or warning console messages were observed in the browser log checks. Browser input needed a click on the visible Monaco code surface; targeting its hidden IME textarea did not edit content. No product source was changed by this QA pass.

The harness changes pass `npm run typecheck`. An initial inspection pass, a rebuild verification, and one narrowly scoped follow-up for the corrected accessibility labels were performed. The follow-up checked only names at both viewport sizes and one normal line transfer. No rendered functional failures remain in this report; native host behaviors are still outside its proof boundary.

## Evidence

- [Desktop islands](evidence/working-islands-desktop.png)
- [600px editor and keyboard tooltip](evidence/working-islands-600.png)
- [Fixed current branch at 600px](evidence/working-islands-compare-600.png)
- [Typed working-file unsaved state](evidence/working-islands-unsaved.png)
- [Highlight off](evidence/working-islands-highlight-off.png)
- [Added-file boundary](evidence/working-islands-added-600.png)
- [Deleted-file boundary](evidence/working-islands-deleted-600.png)
- [Save tooltip](evidence/working-islands-save-tooltip.png)
- [Binary state](evidence/working-islands-binary-600.png)
- [Unrelated-history error](evidence/working-islands-error-600.png)
- [Final accessibility fix and transfer at desktop](evidence/working-islands-accessibility-final-desktop.png)
- [Final accessibility fix at 600px](evidence/working-islands-accessibility-final-600.png)

## Server

Registry record `48a4bd17-79ba-40c8-b575-72ea1248ced7` tracks the loopback harness at port 64281, PID 90832, terminal session 9154. Its boot timestamp was verified from Win32_OperatingSystem; the registry had no verified earlier-boot active records requiring reconciliation. The harness was stopped after verification and the record updated to `stopped` with reason `browser_qa_complete`.

The final accessibility follow-up used a fresh registered harness, record `11e9cc4a-ad93-4d35-a783-c592a6d03e31`, port 64222, PID 99912, terminal session 79947. Current OS boot time, process identity/start time, and actual listener were verified. This harness was also stopped after verification and its record updated to `stopped` with reason `browser_qa_complete`.
