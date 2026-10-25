# BranchLens Marketplace pipeline

## Goal and approach

Adapt the user's existing Git Timekeeper GitHub Actions publishing flow to BranchLens. Preserve the proven release eligibility, version selection and recovery logic rather than introduce a different release system. The user explicitly requested the same pipeline and supplied the missing repository secret during this task.

## Constraints

- Publisher `Nikolas2610`, extension `branch-lens`, initial manifest version `0.2.0`.
- GitHub repository `Nikolas2610/branch-lens`; preserve its private visibility.
- Never push directly to `main` or `development`. Deliver implementation through a feature PR. Version synchronization uses its own bot branch and PR, with explicit leases.
- Node 22; Windows and Ubuntu CI; typecheck, lint, core tests, release tests and VSIX packaging before publication.
- Automatic releases require successful main CI for an actual merged PR. Manual first publication uses the exact manifest version on main.
- PAT mode matches the existing working setup; secret values never enter source, logs or chat. Retain explicit OIDC and manual Open VSX support.
- Every package runs the build hook. Reuse the exact saved VSIX and release plan on retry; never infer a version from a registry error.
- Packaging must rewrite relative README links for Marketplace. The private repository means GitHub-hosted screenshots need public hosting before anonymous Marketplace readers can load them; do not change repository visibility.

## Ownership and steps

- [x] Release tooling worker: adapt the five release implementation/test files, observe failing tests first, then verify the adopted release behavior.
- [x] Main: adapt CI/publishing workflows, metadata, pinned CLI dependencies, build hook and packaging exclusions; document release operation.
- [x] Main: run typecheck, lint, core/release tests, package; inspect README rewriting and packaged file list. 56 core + 31 release tests passed; one Windows executable-permission skip. Runtime packaging excludes tooling/source/maps.
- [x] Independent reviewer: check publication eligibility, bootstrap, version synchronization and artifact recovery across the adapted files. No critical or important code findings.
- [ ] Main: configure repository variables and Actions PR permission; verify secret name. Commit on `codex/marketplace-pipeline`, push only that branch, create PR, and monitor CI.
- [ ] Main: integrate through PR after passing CI, run initial manual publication, and verify the Marketplace result or report any external blocker precisely.

## Review focus

- First release has no prior Marketplace version: use explicit manual bootstrap, never treat an outage as an empty registry.
- Automatic and manual paths both build fresh assets and publish the expected BranchLens package.
- Reruns retain the original source/run/version/VSIX identity.
- Stale CI and version-only bot merges do not create extra releases.
- No automation pushes protected branches or exposes publisher credentials.

## External state

`MARKETPLACE_PUBLISHER=Nikolas2610` and `MARKETPLACE_AUTH=pat` were configured. GitHub API still returned zero repository secrets after the user's initial confirmation, so the exact repository/secret was clarified. Changing `can_approve_pull_request_reviews` was rejected by automatic approval review because the API combines necessary PR creation with broader review-approval permission; no permission change occurred. Explicit owner approval is required for that setting. Neither issue affects local validation or creating the implementation PR.
