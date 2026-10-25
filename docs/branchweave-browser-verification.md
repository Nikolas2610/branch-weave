# BranchWeave browser verification

Verified 2026-10-25 using the built-in Codex Browser against `node --import tsx tests/browser/harness.ts`, rendering the production webview assets. Base URL was `http://127.0.0.1:61248`. This is a focused verification of the visible rebrand and unchanged nearby controls, using synthetic fixture data.

| Criterion | Result | Route and viewport | Steps and observed result |
| --- | --- | --- | --- |
| Editor visible branding | Passed | `/editor?fixture=0&fresh=1`, 1440 × 900 | Opened the editor. Browser title and visible top-left heading both read **BranchWeave**. Comparison panes and toolbar rendered. |
| Narrow editor branding and layout | Passed | Same editor route, 600 × 800 | Resized the rendered page and inspected it. BranchWeave remained visible. Toolbar wrapped into two rows; branch labels wrapped within the two pane headings. |
| Reference and current branch labels | Passed | Editor at both sizes; `/compare?fixture=0&fresh=1`, 600 × 800 | Inspected headings and comparison controls. Left identifies the merge base/reference draft and `feature/reference`; right identifies `feature/current` and working tree including unsaved edits. Controls explicitly label **REFERENCE BRANCH · LEFT** and **CURRENT BRANCH · RIGHT**. The repository picker displays the synthetic fixture repository basename `branchlens`, an internal fixture value. |
| Section transfer and unsaved status | Passed | `/editor?fixture=0&fresh=1`, 1440 × 900 | Clicked **Copy section Left to Right**. Right editor changed from `value = 2` / `console.log("right")` to the left content `value = 1` / `console.log("left")`. Change count dropped from 2 to 1. Status changed from **Working file saved** to **Working file unsaved**, and the right heading gained **unsaved**. |
| Icon tooltip and keyboard access | Passed | Same editor route, 1440 × 900 | From the transfer button, pressed Tab. Focus moved to **Copy selected line Right to Left** and the visible tooltip read **Copy selected changed line Right to Left · Alt+Shift+Left**. |
| Comparison error and recovery remain usable | Passed | `/compare?fixture=0&fresh=1&error=1`, 600 × 800 | Opened the no-common-ancestor fixture. Error text and **Use direct comparison** button were visible. Clicked the button: the error disappeared, **Include upstream changes** became checked, and explanatory text changed to direct reference/current-working-tree comparison. |

## Captures

Real viewport captures, saved as JPEG to match the browser's actual encoding:

- `evidence/branchweave-comparison.jpg`: desktop editor, 1440 × 900, before transfer.
- `evidence/branchweave-controls.jpg`: comparison controls, 600 × 800.
- `evidence/branchweave-unsaved.jpg`: desktop editor, 1440 × 900, after section transfer.

## Scope and cleanup

The harness does not emulate VS Code native dialogs, native lifecycle, or real filesystem save behavior. Those are outside this copy-only rebrand browser check; no claim about them is made here. No application source was changed during QA.

The first sandbox listener at port 53654 was unreachable by both browser attempts and was stopped after process identity verification. Its registry record is `df229e62-86b2-4726-871c-2e90c6355e7e`. A replacement loopback listener at port 61248 was reachable in the built-in browser. Its PID 96952, process creation time, actual listener, and OS boot timestamp were verified. After QA, it was stopped and both process exit and listener absence were confirmed. Final server registry record: `89a6ef0e-3083-4319-9f5f-974b8b47b7c4`, status **stopped**, stop reason `browser_qa_complete`. No QA server remains running. The temporary viewport override was reset, the successful QA tab and temporary Chrome error tab were closed, and user-owned Chrome tabs were untouched.
