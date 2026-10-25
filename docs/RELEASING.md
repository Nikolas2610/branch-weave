# Release BranchWeave

BranchWeave follows the Git Timekeeper GitHub Actions release flow: test a merged PR, publish an exact VSIX, then synchronize automatic version bumps through another PR.

## Repository configuration

| Setting | Value |
| --- | --- |
| Marketplace display name | `BranchWeave` |
| Extension ID | `Nikolas2610.branch-lens` |
| Actions variable `MARKETPLACE_PUBLISHER` | `Nikolas2610` |
| Actions variable `MARKETPLACE_AUTH` | `pat` for the current setup; `oidc` after configuring trusted publishing |
| Actions secret `VSCE_PAT` | Publisher-authorized token with Marketplace Manage permission, required in PAT mode |
| Actions secret `OVSX_PAT` | Only required for manual Open VSX publication |

The version-sync bot needs permission to create PRs under **Settings → Actions → General**. GitHub exposes this as a combined setting allowing Actions to create and approve pull requests; changing it requires explicit owner approval. The workflows themselves never approve or merge PRs. Keep default workflow permissions read-only; publication requests its additional permissions at job level.

Secret values must never be committed, printed, or pasted into chat. GitHub does not allow reading a stored repository secret back to copy it to another repository.

## First publication

Automatic version selection requires an existing stable Marketplace release:

1. Merge the pipeline implementation PR into `main` after **CI** succeeds.
2. Open **Actions → Publish Extension → Run workflow**.
3. Select branch **main**, target **vscode**, and the exact manifest version (initially `0.2.0`).
4. Check the workflow result and Marketplace publisher page. Marketplace validation may still be processing after acceptance.

The initial automatic run can fail because there is no published version yet. It does not guess a version or interpret registry failure as an empty registry. The manual path publishes the explicit manifest version without automatic version discovery. Later application merges use automatic publication.

## Automatic publication

**CI** runs on PRs and pushes to `main` and `development`, using Node 22 on Ubuntu and Windows. Both platforms run typecheck, lint, core/release tests, and packaging. Ubuntu uploads `branch-lens.vsix` as an installable artifact.

After successful push CI on `main`, **Publish Extension** verifies that the exact source commit belongs to a merged PR in this repository. Failed CI, unmerged PRs, feature-branch pushes, and direct main pushes without a matching merged PR cannot publish automatically.

Version selection uses the latest stable Marketplace version. A newer manifest version is published as-is; otherwise the latest published patch is incremented. Registry errors, malformed versions and missing stable releases stop the run.

Preparation updates the manifest and both root lockfile versions in the build checkout. `vscode:prepublish` always builds the extension/webviews, including when release tooling invokes VSCE directly. The pipeline persists the release plan and exact `output/release/branch-lens.vsix` before any upload.

After publication, the bot opens or updates `codex/marketplace-version-sync` → `main` with only version changes. Review and merge normally. A verified bot version-only merge does not publish another patch; a newer main version is never downgraded. The build-only `branchLensRelease` identity marker is not synchronized into source.

Neither local delivery nor release automation pushes directly to `main` or `development`. Before an explicit leased push to its dedicated branch, synchronization verifies its branch, upstream, remote URL, destination ref and expected old SHA.

## Reruns and recovery

Use **Re-run all jobs** on the original automatic publication run. Reruns restore the same plan and VSIX and verify their SHA256/source/run/version identity. They never select a different patch. An existing Marketplace version must contain this release's marker; an unrelated duplicate fails.

If upload succeeded but PR creation failed, correct the reported permission/problem and rerun the original run. Missing or expired artifacts stop recovery rather than silently creating a new release. Retention is 90 days, subject to repository limits.

Automatic and manual publication share a concurrency group. GitHub can coalesce pending runs during bursts of merges. Already released or superseded source commits are skipped.

Manual publication uses an exact version without the automatic recovery plan. Check Marketplace before retrying an uncertain manual upload; never bump solely to hide uncertainty.

## Marketplace assets and private source

Packaging rewrites relative README links and screenshots to HTTPS GitHub URLs using repository metadata, following the [VS Code publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

The source repository is private. Anonymous Marketplace readers cannot load its GitHub-hosted screenshots or open its source/issue links. Public screenshots need an owner-approved public HTTPS image host configured with `vsce.baseImagesUrl`, or explicit authorization to make the repository public. The pipeline preserves repository visibility. Screenshot files remain included in the VSIX.

## OIDC and Open VSX

The pinned official `@vscode/vsce@4.0.1-4` matches the reference pipeline and supports `--oidc`. To enable it, configure a Marketplace trust policy for owner `Nikolas2610`, repository `branch-lens`, workflow `publish.yml`, branch `main`, with no named GitHub environment. Set `MARKETPLACE_AUTH=oidc`. The job requests `id-token: write`; OIDC failures do not fall back to PAT. See the [official CLI documentation](https://github.com/microsoft/vscode-vsce#trusted-publishing).

Manual Open VSX publication requires a registered namespace and its own `OVSX_PAT`. Marketplace credentials do not establish those permissions. Open VSX publication is never triggered automatically.

## Local checks

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run package
npm run package:list
```

Native host checks (`npm run test:host`) need installed VS Code and run separately from two-platform CI. No tag or GitHub Release is created automatically.
