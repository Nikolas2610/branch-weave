const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const release = fs.existsSync(`${__dirname}/release.cjs`) ? require('./release.cjs') : {};
const repository = 'Nikolas2610/branch-lens';
const sourceSha = 'a'.repeat(40);
const context = { repository, sourceSha, runId: '123', extensionId: 'Nikolas2610.branch-lens' };
const plan = () => ({ schemaVersion: 1, ...context, manifestVersion: '0.1.0', version: '0.1.1', vsixSha256: 'b'.repeat(64) });
const event = () => ({ repository: { full_name: repository }, workflow_run: {
  event: 'push', conclusion: 'success', head_branch: 'main', head_sha: sourceSha,
  head_repository: { full_name: repository }
} });
const pr = () => ({ number: 2, merged: true, merge_commit_sha: sourceSha,
  base: { ref: 'main', repo: { full_name: repository } },
  head: { ref: 'feature/example', repo: { full_name: repository } },
  user: { login: 'Nikolas2610', type: 'User' }
});

test('only successful main push CI associated with an actual merged PR can publish automatically', () => {
  assert.equal(typeof release.releaseContext, 'function');
  assert.deepEqual(release.releaseContext(event(), { ...context, eventName: 'workflow_run' }, pr()), {
    automatic: true, sourceSha, pullNumber: 2
  });
  for (const patch of [{ event: 'pull_request' }, { conclusion: 'failure' }, { head_branch: 'feature/example' },
    { head_sha: 'c'.repeat(40) }, { head_repository: { full_name: 'fork/repo' } }]) {
    const data = event(); Object.assign(data.workflow_run, patch);
    assert.throws(() => release.releaseContext(data, { ...context, eventName: 'workflow_run' }, pr()));
  }
  assert.throws(() => release.releaseContext(event(), { ...context, eventName: 'workflow_run' }, { ...pr(), merged: false }));
  assert.throws(() => release.releaseContext(event(), { ...context, eventName: 'workflow_run' }, { ...pr(), merge_commit_sha: 'c'.repeat(40) }));
  assert.throws(() => release.releaseContext(event(), { ...context, eventName: 'pull_request_target' }, pr()));
});

test('manual publishing is restricted to main and the expected repository', () => {
  assert.deepEqual(release.releaseContext(event(), { ...context, eventName: 'workflow_dispatch', ref: 'refs/heads/main' }), {
    automatic: false, sourceSha
  });
  assert.throws(() => release.releaseContext(event(), { ...context, eventName: 'workflow_dispatch', ref: 'refs/heads/feature/test' }));
  assert.throws(() => release.releaseContext({ repository: { full_name: 'other/repo' } }, { ...context, eventName: 'workflow_dispatch', ref: 'refs/heads/main' }));
});

test('reruns require the exact persisted source, run, identity and valid stable version', () => {
  assert.deepEqual(release.validatePlan(plan(), context), plan());
  for (const patch of [{ sourceSha: 'c'.repeat(40) }, { runId: '124' }, { repository: 'other/repo' },
    { extensionId: 'other.extension' }, { schemaVersion: 2 }, { vsixSha256: 'invalid' }, { version: '0.1.1-beta' }]) {
    assert.throws(() => release.validatePlan({ ...plan(), ...patch }, context));
  }
});

test('an existing Marketplace version must contain this exact release marker', () => {
  const manifest = { name: 'branch-lens', publisher: 'Nikolas2610', version: '0.1.1', branchLensRelease: release.releaseMarker(plan()) };
  assert.equal(release.matchesPublishedRelease(plan(), manifest), true);
  for (const patch of [{ branchLensRelease: undefined }, { version: '0.1.2' }, { publisher: 'other' },
    { branchLensRelease: { ...release.releaseMarker(plan()), runId: '124' } }]) {
    assert.equal(release.matchesPublishedRelease(plan(), { ...manifest, ...patch }), false);
  }
});

test('registry access rejects network, HTTP and malformed JSON failures', async () => {
  const fail = async () => { throw new Error('offline'); };
  await assert.rejects(() => release.requestJson('https://example.test', { fetchImpl: fail }), /request failed/i);
  await assert.rejects(() => release.requestJson('https://example.test', { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(() => release.requestJson('https://example.test', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('invalid'); } }) }), /JSON/i);
});

test('manifest lookup requests explicit gallery asset metadata and rejects unexpected identities or hosts', () => {
  const data = { results: [{ extensions: [{ publisher: { publisherName: 'Nikolas2610' }, extensionName: 'branch-lens',
    versions: [{ version: '0.1.0', assetUri: 'https://nikolas2610.gallery.vsassets.io/public/assets' }] }] }] };
  assert.equal(release.manifestAssetUrl(data, context.extensionId, '0.1.0'),
    'https://nikolas2610.gallery.vsassets.io/public/assets/Microsoft.VisualStudio.Code.Manifest');
  assert.throws(() => release.manifestAssetUrl(data, context.extensionId, '0.1.1'));
  assert.throws(() => release.manifestAssetUrl(data, 'other.extension', '0.1.0'));
  data.results[0].extensions[0].versions[0].assetUri = 'https://untrusted.example.test/assets';
  assert.throws(() => release.manifestAssetUrl(data, context.extensionId, '0.1.0'));
});

test('version synchronization never downgrades a newer main manifest', () => {
  assert.equal(release.needsVersionSync('0.2.0', '0.1.1'), false);
  assert.equal(release.needsVersionSync('0.1.1', '0.1.1'), false);
  assert.equal(release.needsVersionSync('0.1.0', '0.1.1'), true);
});

test('late CI and repeated CI for an already released source cannot publish older application code', () => {
  const published = { branchLensRelease: { repository, sourceSha: 'c'.repeat(40), runId: '122' } };
  assert.equal(release.sourceAlreadyReleased(plan(), published, () => true), true);
  assert.equal(release.sourceAlreadyReleased(plan(), published, () => false), false);
  assert.equal(release.sourceAlreadyReleased(plan(), { branchLensRelease: release.releaseMarker(plan()) }, () => false), true);
  assert.equal(release.sourceAlreadyReleased(plan(), {}, () => true), false);
  assert.equal(release.sourceAlreadyReleased(plan(), { branchLensRelease: { ...published.branchLensRelease, repository: 'other/repo' } }, () => true), false);
});

test('only an authenticated bot PR with exactly the two version files can suppress publication', () => {
  const pkg = { name: 'branch-lens', version: '0.1.0', publisher: 'Nikolas2610' };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } };
  const bumpedPkg = { ...pkg, version: '0.1.1' };
  const bumpedLock = { ...lock, version: '0.1.1', packages: { '': { ...lock.packages[''], version: '0.1.1' } } };
  const botPr = { ...pr(), head: { ...pr().head, ref: 'codex/marketplace-version-sync' }, user: { login: 'github-actions[bot]', type: 'Bot' } };
  const change = { files: ['package.json', 'package-lock.json'], beforeManifest: pkg, beforeLock: lock, afterManifest: bumpedPkg, afterLock: bumpedLock };
  assert.equal(release.isSyncMerge(botPr, repository, change), true);
  assert.equal(release.isSyncMerge(pr(), repository, change), false);
  assert.equal(release.isSyncMerge(botPr, repository, { ...change, files: [...change.files, 'src/extension.ts'] }), false);
  assert.equal(release.isSyncMerge(botPr, repository, { ...change, afterManifest: { ...bumpedPkg, description: 'application change' } }), false);
  assert.equal(release.isSyncMerge(botPr, repository, { ...change, mergeFiles: [], afterManifest: pkg, afterLock: lock }), true);
  assert.equal(release.isSyncMerge(botPr, repository, { ...change, mergeFiles: [...change.files, 'src/extension.ts'] }), false);
});

test('retained and orphan synchronization branches require verified bot ownership and complete version-only content', () => {
  const pkg = { name: 'branch-lens', version: '0.1.0', publisher: 'Nikolas2610' };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': { name: pkg.name, version: pkg.version } } };
  const bump = require('./release-core.cjs').withVersion(pkg, lock, '0.1.1');
  const change = { files: ['package.json', 'package-lock.json'], beforeManifest: pkg, beforeLock: lock,
    afterManifest: bump.manifest, afterLock: bump.lockfile, sha: 'd'.repeat(40), parentOnMain: true,
    authorEmail: '41898282+github-actions[bot]@users.noreply.github.com',
    message: 'chore: synchronize Marketplace version 0.1.1' };
  const historical = { ...pr(), head: { ref: 'codex/marketplace-version-sync', sha: change.sha, repo: { full_name: repository } },
    user: { login: 'github-actions[bot]', type: 'Bot' } };
  assert.equal(release.canReuseSyncBranch(change, historical, plan()), true);
  assert.equal(release.canReuseSyncBranch(change, undefined, plan()), true);
  assert.equal(release.canReuseSyncBranch({ ...change, parentOnMain: false }, undefined, plan()), false);
  assert.equal(release.canReuseSyncBranch({ ...change, authorEmail: 'user@example.test' }, undefined, plan()), false);
  assert.equal(release.canReuseSyncBranch({ ...change, afterManifest: { ...bump.manifest, scripts: { postinstall: 'unrelated' } } }, historical, plan()), false);
  assert.equal(release.canReuseSyncBranch({ ...change, files: [...change.files, 'README.md'] }, historical, plan()), false);
});
