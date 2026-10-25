# Native VS Code host verification

Run the actual installed VS Code Extension Development Host after building:

```powershell
npm run build
node scripts/smoke-host.mjs
```

`VSCODE_EXECUTABLE_PATH` can override the default Windows installation at `C:\Program Files\Microsoft VS Code\Code.exe`. The runner uses `@vscode/test-electron` and the installed executable; it does not download or install an extension into the user's profile. The extension remains loaded only as a development extension.

Each run creates a fresh ignored `.test-host/<UUID>/` directory containing its fixture Git repository, isolated VS Code user data and extension directories, bundled host test, fixture commit IDs, `result.json`, and `launcher-result.json`. Git receives argument arrays and local fixture identity settings. No remote is configured, and no push occurs. Failed application startup is retained in `launcher-result.json`; completed host checks are written incrementally to `result.json`. Commands have a 20-second timeout, and observable draft/tab transitions have a 15-second timeout.

The fixture has a shared base, a `development`-only commit, and two modified text files on `feature/host-smoke`. The suite uses public VS Code APIs and contributed/user-facing commands. It does not mock the extension, access private APIs, inject webview messages, or inspect private DOM. Draft commands travel through the actual custom-editor Monaco webview; the saved session proves that their round trips completed.

## Verified run

On 2026-10-25 in Windows, installed VS Code **1.143.1** returned **exit code 0** for all **nine checks** against the final build, including the unique-session URI and theme-color normalization fixes. Latest evidence: `.test-host/7fb61b30-9164-4bf7-a97c-87dcbcf4fc89/result.json` and `launcher-result.json`; console transcript: `.test-host/latest-host-smoke.log`. The Extension Development Host exited automatically after the tests. This desktop smoke run did not start a development server.

| Criterion | Environment and steps | Observed result |
| --- | --- | --- |
| Activate and register commands | Activate `branchlens.branch-lens` in the fixture workspace; compare every manifest command against `vscode.commands.getCommands()` | **Passed**: extension active, workspace trusted, all contributed commands registered |
| Open contributed views | Open the BranchLens activity-bar container and focus Compare Branches and Changed Files | **Passed**: all three user-facing commands completed |
| Compare real branches | Run `branchlens.compare`; inspect `TabInputCustom` and serialized session | **Passed**: `branchlens.diff` native custom editor opened; development/feature refs and immutable merge-base/right SHA matched the fixture; exactly `a.txt` and `b.txt` changed |
| Transfer one line and undo/redo | Focus left, transfer line left to right, Save, Undo, Save, Redo, Save, Undo | **Passed**: saved right draft changed to base text and returned to feature text; original left/right snapshots stayed unchanged |
| Navigate files and transfer a hunk | Next File, Next/Previous Hunk, Focus Right, transfer current left hunk, Save, Undo, Previous File, Open index 0 | **Passed**: saved active index was 1 and second-file draft received base text; original feature snapshot stayed unchanged |
| Include upstream | Enable upstream, Save; disable upstream, Save | **Passed**: enabled comparison used the development tip and included `upstream.txt`; disabled comparison used the merge base and excluded that file |
| Other command integration | Swap twice, Refresh, toggle highlighting/flat list both ways, focus Changed Files, reopen custom editor and Save | **Passed**: commands completed and saved left/right refs matched each expected direction |
| Draft safety | Compare fixture Git HEAD/status and both file contents before and after all commands | **Passed**: identical HEAD, clean status and byte-identical workspace text |
| Preserve closed saved sessions | Save the current custom document, retain its URI and bytes, close its clean native tab, run Compare again, inspect both session files | **Passed**: the new session used a different URI, the old saved bytes were identical, and the new session preserved the selected development/feature refs |

Draft bridge checks wait for the expected text in the persisted session and log the actual draft version. A dirty tab alone is insufficient acknowledgement because other document changes can also mark a tab dirty. The final run observed versions 1–4 for line transfer/undo/redo and versions 1–2 for second-file hunk transfer/undo.

These are native command and persistence checks, not pixel/layout assertions. Successful focus/presentation commands establish native integration; their visual effects belong to rendered browser/native UI checks. Repository/branch quick pick selection, export/save-as dialogs, reset/file-operation prompts, Apply confirmations, and manual keyboard input remain outside this automated suite.

For a bounded manual native-dialog pass, set `$env:BRANCHLENS_HOST_UI_HOLD = '1'` before running the launcher. After all automated checks pass, the editor remains open for at most 15 minutes and prints `BRANCHLENS_UI_HOLD: <release-path>`. `ui-hold.json` records the wait state and extension-host PID. A QA owner can exercise dialogs in that isolated window, save/close any manual draft, then create the printed release file. The test closes its tabs and VS Code exits normally. The ordinary run does not pause.

## Partial native dialog pass

The hold-mode run `.test-host/bf394dde-c22f-4149-b590-45cb80747a30/` passed all eight automated checks, then remained open for parent-agent native Computer Use verification. Its release sentinel was acknowledged and the host exited normally with **exit code 0**; `ui-hold.json` records `released`, and `launcher-result.json` records the successful exit.

| Native criterion | Observed result |
| --- | --- |
| Render comparison in the actual VS Code custom editor | **Passed**: the editor rendered in the real Extension Development Host |
| Open repository picker | **Passed for opening**: native quick pick displayed the fixture repository path; changing repository selection was not verified |
| Open Left branch picker | **Passed for opening**: native picker displayed `development` as local and `feature/host-smoke` as current; typed search filtering and selection changes were not verified |
| Native Reset, Export, Save As, Apply and replacement/close confirmations | **Unverified**: native tool repeatedly reported `user input detected` and a minimized window; automation stopped to avoid competing with user input. No manual mutation was confirmed |

The native render also exposed a theme compatibility issue: VS Code can supply `rgba(...)` color variables, while Monaco theme colors require hex. The parent agent fixed color normalization and added a regression test. This manual hold run preceded that theme change; the latest nine-check normal host run above includes it, and rendered color regression verification is tracked separately by browser QA. No native dialog outcome is inferred from the successful command-registration checks.

## Regression found by the first host run

The first native run activated the extension and opened both sidebar views, then blocked opening the comparison editor. The provider awaited a webview message before VS Code could finish mounting that webview. Returning from `resolveCustomEditor` first and sending initial content on the `ready` handshake removed that bootstrap deadlock. The successful run above exercised the actual initialized editor after that fix. The original isolated host was closed gracefully after checking its exact PID, profile path and process creation time; no unrelated VS Code process was stopped.

The initial sandboxed launch could not access the installed VS Code directory (`EPERM`/Electron sandbox ACL error). The verified run used an approved execution outside that sandbox; it did not change installation permissions or user profile settings.

The final saved-session check protects against reusing a fixed global-storage filename: starting Compare after a clean saved editor closes must not overwrite that earlier session. New sessions now use `comparison-<session-id>.branchlens`; the native test verifies both URI separation and preservation of the original file bytes.

## Icon toolbar update — 0.1.1

All nine native host checks passed again after the icon toolbar update. Evidence: .test-host/9e0048f1-4600-4c8a-860b-aba283e18aef/result.json. The actual webview transfer, Undo/Redo, navigation, Save, comparison-mode and saved-session checks returned exit 0; the host exited normally. Pointer/keyboard tooltip and responsive visual checks are recorded in browser-verification.md.

