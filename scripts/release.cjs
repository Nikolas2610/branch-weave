// Release tooling only. This module is never shipped in the extension.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const core = require('./release-core.cjs');

const SYNC_BRANCH = 'codex/marketplace-version-sync';
const releaseDir = path.resolve('output/release');
const planPath = path.join(releaseDir, 'plan.json');
const vsixPath = path.join(releaseDir, 'branch-lens.vsix');
const vsce = path.resolve('node_modules/@vscode/vsce/vsce');

function releaseContext(event, context, pr) {
  if (event.repository?.full_name !== context.repository || !/^[a-f0-9]{40}$/.test(context.sourceSha)) {
    throw new Error('Unexpected source repository or commit.');
  }
  if (context.eventName === 'workflow_dispatch' && context.ref === 'refs/heads/main') {
    return { automatic: false, sourceSha: context.sourceSha };
  }
  const run = event.workflow_run;
  if (context.eventName !== 'workflow_run' || run?.event !== 'push' || run.conclusion !== 'success' ||
      run.head_branch !== 'main' || run.head_sha !== context.sourceSha ||
      run.head_repository?.full_name !== context.repository || !pr?.merged ||
      pr.merge_commit_sha !== context.sourceSha || pr.base?.ref !== 'main' ||
      pr.base.repo?.full_name !== context.repository) {
    throw new Error('Automatic publication requires successful main CI for an actual merged PR.');
  }
  return { automatic: true, sourceSha: context.sourceSha, pullNumber: pr.number };
}

function validatePlan(plan, context) {
  if (plan.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(plan.sourceSha) ||
      !/^[a-f0-9]{64}$/.test(plan.vsixSha256) || !/^\d+$/.test(plan.runId)) {
    throw new Error('Invalid persisted release plan.');
  }
  for (const key of ['repository', 'sourceSha', 'runId', 'extensionId']) {
    if (plan[key] !== context[key]) throw new Error(`Release plan ${key} does not match this run.`);
  }
  core.parseVersion(plan.version);
  core.parseVersion(plan.manifestVersion);
  return plan;
}

function releaseMarker(plan) {
  return { repository: plan.repository, sourceSha: plan.sourceSha, runId: plan.runId };
}

function matchesPublishedRelease(plan, manifest) {
  return `${manifest?.publisher}.${manifest?.name}` === plan.extensionId &&
    manifest.version === plan.version && isDeepStrictEqual(manifest.branchLensRelease, releaseMarker(plan));
}

function needsVersionSync(currentVersion, publishedVersion) {
  return core.compareVersions(currentVersion, publishedVersion) < 0;
}

function sourceAlreadyReleased(plan, publishedManifest, isAncestor) {
  const marker = publishedManifest?.branchLensRelease;
  return marker?.repository === plan.repository && /^[a-f0-9]{40}$/.test(marker.sourceSha) &&
    (marker.sourceSha === plan.sourceSha || isAncestor(plan.sourceSha, marker.sourceSha));
}

function isSyncMerge(pr, repository, change) {
  const mergeFiles = change.mergeFiles ?? change.files;
  if (!core.isTrustedSyncPr(pr, repository) ||
      !isDeepStrictEqual([...change.files].sort(), ['package-lock.json', 'package.json'])) return false;
  if (mergeFiles.length === 0) return isDeepStrictEqual(change.beforeManifest, change.afterManifest) &&
    isDeepStrictEqual(change.beforeLock, change.afterLock);
  return isDeepStrictEqual([...mergeFiles].sort(), ['package-lock.json', 'package.json']) &&
    core.isVersionOnlyChange(change.beforeManifest, change.beforeLock, change.afterManifest, change.afterLock);
}

function canReuseSyncBranch(change, pr, plan) {
  if (!isDeepStrictEqual([...change.files].sort(), ['package-lock.json', 'package.json']) ||
      !core.isVersionOnlyChange(change.beforeManifest, change.beforeLock, change.afterManifest, change.afterLock)) return false;
  const ownedPr = pr?.user?.login === 'github-actions[bot]' && pr.user.type === 'Bot' &&
    pr.base?.ref === 'main' && pr.base.repo?.full_name === plan.repository &&
    pr.head?.ref === SYNC_BRANCH && pr.head.repo?.full_name === plan.repository && pr.head.sha === change.sha;
  const recovery = change.parentOnMain && change.afterManifest.version === plan.version &&
    change.authorEmail === '41898282+github-actions[bot]@users.noreply.github.com' &&
    change.message === `chore: synchronize Marketplace version ${plan.version}`;
  return Boolean(ownedPr || (!pr && recovery));
}

async function requestJson(url, { fetchImpl = fetch, ...options } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(30000), ...options });
  } catch {
    throw new Error('Remote request failed; no release version was inferred.');
  }
  if (!response.ok) throw new Error(`Remote request failed with HTTP ${response.status}.`);
  try { return await response.json(); } catch { throw new Error('Remote response is not valid JSON.'); }
}

function run(command, args, { cwd = process.cwd(), env = process.env, visible = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    stdio: visible ? 'inherit' : 'pipe' });
  if (result.error || result.status !== 0) {
    // Do not include arguments, environment or authenticated response bodies in errors.
    throw new Error(`${path.basename(command)} failed (exit ${result.status ?? 'unknown'}).`);
  }
  return result.stdout?.trim() ?? '';
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const gitJson = (ref, file, cwd) => JSON.parse(run('git', ['show', `${ref}:${file}`], { cwd }));

function contextFromEnv() {
  const manifest = readJson('package.json');
  return { repository: process.env.GITHUB_REPOSITORY, sourceSha: process.env.SOURCE_SHA,
    runId: process.env.GITHUB_RUN_ID, extensionId: `${manifest.publisher}.${manifest.name}`,
    eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF };
}

function output(key, value) {
  if (!/^[a-z_]+$/.test(key) || /[\r\n]/.test(String(value))) throw new Error('Invalid Actions output.');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}

function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
}

async function github(endpoint, options = {}) {
  if (!process.env.GH_TOKEN) throw new Error('Missing GitHub token for release coordination.');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GH_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
  return requestJson(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${endpoint}`, {
    ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
}

async function allPages(endpoint) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await github(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('Invalid paginated GitHub response.');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error('GitHub pagination limit exceeded.');
}

function gallery() {
  const manifest = readJson('package.json');
  const data = JSON.parse(run(process.execPath, [vsce, 'show', `${manifest.publisher}.${manifest.name}`, '--json']));
  if (data?.extensionName !== manifest.name || data?.publisher?.publisherName !== manifest.publisher) {
    throw new Error('Unexpected Marketplace extension identity.');
  }
  return data;
}

function loadPlan() {
  const plan = validatePlan(readJson(planPath), contextFromEnv());
  if (hash(vsixPath) !== plan.vsixSha256) throw new Error('VSIX does not match the persisted release plan.');
  return plan;
}

async function checkContext() {
  const context = contextFromEnv();
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  if (run('git', ['rev-parse', 'HEAD']) !== context.sourceSha) throw new Error('Checkout is not the source commit.');
  run('git', ['merge-base', '--is-ancestor', context.sourceSha, 'origin/main']);
  let pr;
  if (context.eventName === 'workflow_run') {
    const associated = await allPages(`commits/${context.sourceSha}/pulls`);
    const matching = associated.filter(item => item.merged_at && item.merge_commit_sha === context.sourceSha && item.base?.ref === 'main');
    if (matching.length !== 1) throw new Error('Expected one merged PR for the CI source commit.');
    pr = await github(`pulls/${matching[0].number}`);
  }
  const selected = releaseContext(event, context, pr);
  let skip = false;
  if (selected.automatic && core.isTrustedSyncPr(pr, context.repository)) {
    const files = (await allPages(`pulls/${pr.number}/files`)).map(file => file.filename);
    skip = isSyncMerge(pr, context.repository, { files,
      mergeFiles: run('git', ['diff', '--name-only', `${context.sourceSha}^1`, context.sourceSha]).split('\n').filter(Boolean),
      beforeManifest: gitJson(`${context.sourceSha}^1`, 'package.json'),
      beforeLock: gitJson(`${context.sourceSha}^1`, 'package-lock.json'),
      afterManifest: readJson('package.json'), afterLock: readJson('package-lock.json') });
  }
  output('skip', skip);
  output('automatic', selected.automatic);
  if (skip) summary('Version synchronization PR merged: repository files updated; no additional publication.');
}

function prepare() {
  if (Number(process.env.GITHUB_RUN_ATTEMPT) > 1) {
    const plan = loadPlan();
    output('version', plan.version);
    summary(`Reusing release plan for ${plan.sourceSha} at version ${plan.version}.`);
    return;
  }
  const manifest = readJson('package.json');
  const context = contextFromEnv();
  if (manifest.publisher !== process.env.MARKETPLACE_PUBLISHER || manifest.private) {
    throw new Error('Set MARKETPLACE_PUBLISHER to the registered publisher matching the non-private manifest.');
  }
  const explicit = process.env.RELEASE_VERSION;
  const version = explicit && explicit !== 'auto' ? explicit : core.selectReleaseVersion(manifest.version, gallery());
  core.parseVersion(version);
  if (explicit && explicit !== 'auto' && version !== manifest.version) throw new Error('Manual version must match package.json exactly.');
  const updated = core.withVersion(manifest, readJson('package-lock.json'), version);
  const plan = { schemaVersion: 1, ...context, manifestVersion: manifest.version, version };
  updated.manifest.branchLensRelease = releaseMarker(plan);
  writeJson('package.json', updated.manifest);
  writeJson('package-lock.json', updated.lockfile);
  fs.mkdirSync(releaseDir, { recursive: true });
  run(process.execPath, [vsce, 'package', '--no-dependencies', '--out', vsixPath], { visible: true });
  plan.vsixSha256 = hash(vsixPath);
  validatePlan(plan, context);
  writeJson(planPath, plan);
  output('version', version);
  summary(`Prepared ${context.extensionId} ${version} from ${context.sourceSha}. VSIX SHA256: ${plan.vsixSha256}`);
}

function manifestAssetUrl(data, extensionId, version) {
  const extension = data?.results?.[0]?.extensions?.find(item =>
    `${item.publisher?.publisherName}.${item.extensionName}` === extensionId);
  const entry = extension?.versions?.find(item => item.version === version);
  if (!entry) throw new Error('Marketplace manifest asset metadata is missing.');
  const asset = entry.files?.find(file => file.assetType === 'Microsoft.VisualStudio.Code.Manifest');
  const uri = new URL(asset?.source ?? `${entry.assetUri}/Microsoft.VisualStudio.Code.Manifest`);
  if (uri.protocol !== 'https:' || !/(^|\.)(vsassets\.io|visualstudio\.com)$/.test(uri.hostname)) {
    throw new Error('Unexpected Marketplace asset URL.');
  }
  return uri.toString();
}

async function publishedManifest(version, extensionId) {
  // `vsce show --json` excludes IncludeAssetUri/IncludeFiles. Request those flags
  // explicitly using the public Gallery API before retrieving the package manifest.
  const data = await requestJson('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST', headers: { Accept: 'application/json;api-version=3.0-preview.1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ filters: [{ pageNumber: 1, pageSize: 1,
      criteria: [{ filterType: 7, value: extensionId }] }], flags: 147,
      assetTypes: ['Microsoft.VisualStudio.Code.Manifest'] })
  });
  return requestJson(manifestAssetUrl(data, extensionId, version.version));
}

async function existingRelease(plan, data = gallery()) {
  const versions = data.versions;
  if (!Array.isArray(versions)) throw new Error('Marketplace returned no version list.');
  const version = versions.find(item => item.version === plan.version);
  if (!version) return false;
  const manifest = await publishedManifest(version, plan.extensionId);
  if (!matchesPublishedRelease(plan, manifest)) {
    throw new Error(`Marketplace version ${plan.version} belongs to a different release. Refusing to overwrite or silently skip it.`);
  }
  return true;
}

async function publish() {
  const plan = loadPlan();
  const data = gallery();
  core.selectReleaseVersion(plan.version, data); // Validate every registry entry, including on recovery.
  if (await existingRelease(plan, data)) {
    output('published', true);
    summary(`Marketplace already contains this exact release (${plan.version}); continuing version synchronization.`);
    return;
  }
  // The CI completion queue is not FIFO. Never release an older source over a newer one.
  const latest = data.versions.filter(item => !item.properties?.some(property =>
    property.key === 'Microsoft.VisualStudio.Code.PreRelease' && [true, 'true'].includes(property.value)))
    .sort((a, b) => core.compareVersions(b.version, a.version))[0];
  const latestManifest = await publishedManifest(latest, plan.extensionId);
  const isAncestor = (older, newer) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { encoding: 'utf8' });
    if (result.status !== 0 && result.status !== 1) throw new Error('Cannot verify published source ancestry.');
    return result.status === 0;
  };
  if (sourceAlreadyReleased(plan, latestManifest, isAncestor)) {
    output('published', false);
    summary('This source is already released or superseded by a newer published merge; no additional publication or version PR.');
    return;
  }
  const auth = process.env.MARKETPLACE_AUTH || 'oidc';
  if (!['oidc', 'pat'].includes(auth)) throw new Error('MARKETPLACE_AUTH must be oidc or pat.');
  const env = { ...process.env };
  const args = [vsce, 'publish', '--packagePath', vsixPath];
  if (auth === 'oidc') { delete env.VSCE_PAT; args.push('--oidc'); }
  else if (!env.VSCE_PAT) throw new Error('PAT mode requires the VSCE_PAT Actions secret.');
  try { run(process.execPath, args, { env, visible: true }); }
  catch (error) {
    // A network failure can occur after acceptance. Accept only our persisted marker.
    if (!(await existingRelease(plan))) throw error;
  }
  summary(`Submitted ${plan.extensionId} ${plan.version} to Marketplace. Marketplace validation may still be processing.`);
  output('published', true);
}

function gitAuthEnv() {
  if (!process.env.GH_TOKEN) throw new Error('Missing GitHub token for version synchronization.');
  return { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64')}` };
}

async function sync() {
  const plan = loadPlan();
  const repo = process.env.GITHUB_REPOSITORY;
  const env = gitAuthEnv();
  const expectedUrl = `https://github.com/${repo}`;
  if (run('git', ['remote', 'get-url', 'origin']).replace(/\.git$/, '') !== expectedUrl) throw new Error('Unexpected Git push destination.');
  run('git', ['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], { env });
  const mainSha = run('git', ['rev-parse', 'origin/main']);
  const manifest = gitJson(mainSha, 'package.json');
  const lock = gitJson(mainSha, 'package-lock.json');
  const pulls = await allPages(`pulls?state=open&base=main&head=${encodeURIComponent(`${repo.split('/')[0]}:${SYNC_BRANCH}`)}`);
  if (pulls.length > 1) throw new Error('Multiple version synchronization PRs found.');
  const existing = pulls[0];
  if (existing && (existing.user?.login !== 'github-actions[bot]' || existing.user?.type !== 'Bot' || existing.head?.repo?.full_name !== repo)) {
    throw new Error('Existing synchronization PR is not owned by the expected bot.');
  }
  const remoteLine = run('git', ['ls-remote', 'origin', `refs/heads/${SYNC_BRANCH}`], { env });
  const oldSha = remoteLine ? remoteLine.split(/\s/)[0] : '';
  if (oldSha && existing && existing.head.sha !== oldSha) throw new Error('Synchronization branch changed concurrently.');
  if (oldSha && (existing || needsVersionSync(manifest.version, plan.version))) {
    run('git', ['fetch', '--no-tags', 'origin', `refs/heads/${SYNC_BRANCH}`], { env });
    const mergeBase = run('git', ['merge-base', mainSha, oldSha]);
    // A retained, already merged branch has no diff against main. Inspect its last
    // generated version commit instead, and require its historical bot PR.
    const base = mergeBase === oldSha ? run('git', ['rev-parse', `${oldSha}^1`]) : mergeBase;
    let owner = existing;
    if (!owner) {
      const history = await allPages(`pulls?state=closed&base=main&head=${encodeURIComponent(`${repo.split('/')[0]}:${SYNC_BRANCH}`)}`);
      owner = history.find(item => item.head?.sha === oldSha && item.user?.login === 'github-actions[bot]');
    }
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', base, mainSha], { encoding: 'utf8' });
    if (ancestry.status !== 0 && ancestry.status !== 1) throw new Error('Cannot verify synchronization branch ancestry.');
    const change = { sha: oldSha, files: run('git', ['diff', '--name-only', base, oldSha]).split('\n').filter(Boolean),
      beforeManifest: gitJson(base, 'package.json'), beforeLock: gitJson(base, 'package-lock.json'),
      afterManifest: gitJson(oldSha, 'package.json'), afterLock: gitJson(oldSha, 'package-lock.json'),
      parentOnMain: ancestry.status === 0,
      authorEmail: run('git', ['show', '-s', '--format=%ae', oldSha]),
      message: run('git', ['show', '-s', '--format=%B', oldSha]) };
    if (!canReuseSyncBranch(change, owner, plan)) throw new Error('Synchronization branch is not a verified version-only bot branch.');
  }
  if (!needsVersionSync(manifest.version, plan.version)) {
    if (existing && !needsVersionSync(manifest.version, gitJson(oldSha, 'package.json').version)) {
      // Ownership and the complete version-only branch diff were verified above.
      // An old release rerun must not close a PR for a newer published version.
      await github(`pulls/${existing.number}`, { method: 'PATCH', body: { state: 'closed' } });
    }
    summary(`main already has version ${manifest.version}; no version downgrade or extra PR is needed.`);
    return;
  }
  if (oldSha) {
    if (core.compareVersions(gitJson(oldSha, 'package.json').version, plan.version) > 0) {
      summary('A newer version synchronization PR already exists; leaving it intact.');
      return;
    }
  }
  const updated = core.withVersion(manifest, lock, plan.version);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-lens-release-'));
  run('git', ['worktree', 'add', '--detach', temp, mainSha]);
  // Only this isolated, generated worktree is mutated; application checkout/artifact stay intact.
  run('git', ['switch', '-c', SYNC_BRANCH], { cwd: temp });
  writeJson(path.join(temp, 'package.json'), updated.manifest);
  writeJson(path.join(temp, 'package-lock.json'), updated.lockfile);
  run('git', ['add', '--', 'package.json', 'package-lock.json'], { cwd: temp });
  run('git', ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `chore: synchronize Marketplace version ${plan.version}`], { cwd: temp });
  // Immediately verify branch, upstream, commit, URL and exact remote lease before every push.
  const current = run('git', ['branch', '--show-current'], { cwd: temp });
  const upstream = run('git', ['for-each-ref', '--format=%(upstream)', `refs/heads/${SYNC_BRANCH}`], { cwd: temp });
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: temp });
  const destination = run('git', ['remote', 'get-url', '--push', 'origin'], { cwd: temp }).replace(/\.git$/, '');
  const actualRemote = run('git', ['ls-remote', 'origin', `refs/heads/${SYNC_BRANCH}`], { cwd: temp, env }).split(/\s/)[0];
  if (current !== SYNC_BRANCH || upstream || !/^[a-f0-9]{40}$/.test(commit) || destination !== expectedUrl || actualRemote !== oldSha) {
    throw new Error('Version synchronization push safety checks failed.');
  }
  run('git', ['push', `--force-with-lease=refs/heads/${SYNC_BRANCH}:${oldSha}`, 'origin', `HEAD:refs/heads/${SYNC_BRANCH}`], { cwd: temp, env });
  const body = `Synchronize package.json and package-lock.json with published Marketplace version **${plan.version}**.\n\nSource commit: ${plan.sourceSha}\nPublication run: https://github.com/${repo}/actions/runs/${plan.runId}\n\nOnly version fields change. Merging this authenticated bot PR does not publish another patch. Review and merge it through the normal checks.\n\nIf Actions asks for approval, approve the workflow runs for this bot PR.`;
  const result = await github(existing ? `pulls/${existing.number}` : 'pulls', { method: existing ? 'PATCH' : 'POST',
    body: { title: `chore: synchronize Marketplace version ${plan.version}`, body, ...(existing ? {} : { head: SYNC_BRANCH, base: 'main' }) } });
  summary(`Version synchronization PR: ${result.html_url}`);
}

module.exports = { releaseContext, validatePlan, releaseMarker, matchesPublishedRelease, manifestAssetUrl, needsVersionSync, sourceAlreadyReleased, isSyncMerge, canReuseSyncBranch, requestJson };

if (require.main === module) {
  const commands = { context: checkContext, prepare, verify: loadPlan, publish, sync };
  Promise.resolve().then(() => {
    const command = commands[process.argv[2]];
    if (!command) throw new Error('Expected release command: context, prepare, verify, publish or sync.');
    return command();
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
