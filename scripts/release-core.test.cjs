const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseVersion,
  compareVersions,
  selectReleaseVersion,
  withVersion,
  isVersionOnlyChange,
  isTrustedSyncPr,
} = require('./release-core.cjs');

function documents(version = '0.1.0') {
  const manifest = { name: 'branch-lens', version, publisher: 'Nikolas2610', scripts: { test: 'node --test' } };
  const lockfile = {
    name: manifest.name, version, lockfileVersion: 3, requires: true,
    packages: { '': { name: manifest.name, version, license: 'MIT' }, 'node_modules/example': { version: '2.0.0' } },
  };
  return { manifest, lockfile };
}

function gallery(...versions) {
  return {
    extensionName: 'branch-lens', publisher: { publisherName: 'Nikolas2610' },
    versions: versions.map((version) => typeof version === 'string' ? { version } : version),
  };
}

function syncPr() {
  return {
    merged: true, user: { login: 'github-actions[bot]', type: 'Bot' },
    base: { ref: 'main', repo: { full_name: 'Nikolas2610/branch-lens' } },
    head: { ref: 'codex/marketplace-version-sync', repo: { full_name: 'Nikolas2610/branch-lens' } },
  };
}

test('parseVersion accepts canonical stable versions and rejects ambiguous or unsafe values', () => {
  assert.deepEqual(parseVersion('1.10.0'), [1, 10, 0]);
  assert.deepEqual(parseVersion('0.0.0'), [0, 0, 0]);
  for (const value of ['01.2.3', '1.02.3', '1.2.03', 'v1.2.3', '1.2', '1.2.3-beta', '1.2.3+build', ' 1.2.3', '1.2.3\n', '', null, 123, '9007199254740992.0.0']) {
    assert.throws(() => parseVersion(value), /version/i, String(value));
  }
});

test('compareVersions compares numeric components instead of text ordering', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
});

test('selectReleaseVersion preserves a deliberately newer manifest version', () => {
  assert.equal(selectReleaseVersion('2.0.0', gallery('1.10.0', '1.9.9')), '2.0.0');
});

test('selectReleaseVersion increments an equal or stale manifest from the numeric latest published version', () => {
  assert.equal(selectReleaseVersion('1.10.0', gallery('1.9.9', '1.10.0')), '1.10.1');
  assert.equal(selectReleaseVersion('0.1.0', gallery('0.1.2', '0.1.1')), '0.1.3');
  assert.equal(selectReleaseVersion('0.1.9', gallery('0.1.9', '0.1.9')), '0.1.10');
});

test('selectReleaseVersion ignores Marketplace prerelease channels', () => {
  assert.equal(selectReleaseVersion('0.1.0', gallery('0.1.0', {
    version: '2.0.0', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }],
  })), '0.1.1');
  assert.equal(selectReleaseVersion('0.1.0', gallery({
    version: '1.0.0', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: true }],
  }, '0.1.0')), '0.1.1');
});

test('selectReleaseVersion fails closed on malformed metadata or a missing stable release', () => {
  for (const data of [null, {}, { versions: [] }, gallery(), gallery('broken'), gallery({}),
    gallery({ version: '0.1.0', properties: 'not-an-array' }),
    gallery({ version: '0.1.0', properties: [null] }),
    gallery({ version: '0.1.0', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'unknown' }] }),
    gallery({ version: '0.1.0', properties: [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }] }),
    { ...gallery('0.1.0'), extensionName: '' }, { ...gallery('0.1.0'), publisher: null },
  ]) {
    assert.throws(() => selectReleaseVersion('0.1.0', data), /version|marketplace|gallery|stable|publisher|extension/i);
  }
  assert.throws(() => selectReleaseVersion('1.0.0-beta', gallery('0.1.0')), /version/i);
  assert.throws(() => selectReleaseVersion('0.0.0', gallery('0.0.9007199254740991')), /version|patch/i);
});

test('withVersion immutably updates all three version fields and keeps dependency versions', () => {
  const before = documents();
  const snapshot = structuredClone(before);
  const after = withVersion(before.manifest, before.lockfile, '0.1.1');
  assert.equal(after.manifest.version, '0.1.1');
  assert.equal(after.lockfile.version, '0.1.1');
  assert.equal(after.lockfile.packages[''].version, '0.1.1');
  assert.equal(after.lockfile.packages['node_modules/example'].version, '2.0.0');
  assert.deepEqual(before, snapshot);
  assert.notEqual(after.manifest, before.manifest);
  assert.notEqual(after.lockfile.packages[''], before.lockfile.packages['']);
});

test('withVersion rejects inconsistent identities, versions or unsupported lockfiles', () => {
  const { manifest, lockfile } = documents();
  const mutations = [
    (lock) => { lock.lockfileVersion = 2; },
    (lock) => { lock.name = 'another-extension'; },
    (lock) => { lock.packages[''].name = 'another-extension'; },
    (lock) => { lock.version = '0.0.9'; },
    (lock) => { lock.packages[''].version = '0.0.9'; },
    (lock) => { delete lock.packages['']; },
    (lock) => { delete lock.version; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(lockfile);
    mutate(changed);
    assert.throws(() => withVersion(manifest, changed, '0.1.1'), /lock|version|name|identity/i);
  }
  assert.throws(() => withVersion(manifest, lockfile, '0.1.1-preview'), /version/i);
});

test('isVersionOnlyChange recognizes only synchronized upward version changes', () => {
  const before = documents();
  const after = withVersion(before.manifest, before.lockfile, '0.1.1');
  assert.equal(isVersionOnlyChange(before.manifest, before.lockfile, after.manifest, after.lockfile), true);
  assert.equal(isVersionOnlyChange(after.manifest, after.lockfile, before.manifest, before.lockfile), false);
  assert.equal(isVersionOnlyChange(before.manifest, before.lockfile, before.manifest, before.lockfile), false);
});

test('isVersionOnlyChange rejects hidden script, dependency and release marker changes', () => {
  const before = documents();
  for (const mutate of [
    (after) => { after.manifest.scripts.test = 'curl example.invalid'; },
    (after) => { after.lockfile.packages['node_modules/example'].version = '3.0.0'; },
    (after) => { after.manifest.branchLensRelease = { sourceSha: 'different' }; },
    (after) => { after.lockfile.packages[''].version = '0.1.2'; },
    (after) => { after.manifest.publisher = 'AnotherPublisher'; },
  ]) {
    const after = withVersion(before.manifest, before.lockfile, '0.1.1');
    mutate(after);
    assert.equal(isVersionOnlyChange(before.manifest, before.lockfile, after.manifest, after.lockfile), false);
  }
  assert.equal(isVersionOnlyChange(null, null, {}, {}), false);
});

test('isVersionOnlyChange treats JSON property ordering as immaterial', () => {
  const before = documents();
  const after = withVersion(before.manifest, before.lockfile, '0.1.1');
  const reordered = Object.fromEntries(Object.entries(after.manifest).reverse());
  assert.equal(isVersionOnlyChange(before.manifest, before.lockfile, reordered, after.lockfile), true);
});

test('isTrustedSyncPr requires authenticated bot origin, same repository and merged main PR', () => {
  assert.equal(isTrustedSyncPr(syncPr(), 'Nikolas2610/branch-lens'), true);
  const mutations = [
    (pr) => { pr.merged = false; },
    (pr) => { delete pr.merged; },
    (pr) => { pr.user.login = 'human'; },
    (pr) => { pr.user.type = 'User'; },
    (pr) => { pr.head.ref = 'codex/marketplace-version-sync-lookalike'; },
    (pr) => { pr.head.repo.full_name = 'attacker/branch-lens'; },
    (pr) => { pr.head.repo = null; },
    (pr) => { pr.base.ref = 'development'; },
    (pr) => { pr.base.repo.full_name = 'attacker/branch-lens'; },
  ];
  for (const mutate of mutations) {
    const pr = syncPr();
    mutate(pr);
    assert.equal(isTrustedSyncPr(pr, 'Nikolas2610/branch-lens'), false);
  }
  assert.equal(isTrustedSyncPr(null, 'Nikolas2610/branch-lens'), false);
  assert.equal(isTrustedSyncPr(syncPr(), ''), false);
});
