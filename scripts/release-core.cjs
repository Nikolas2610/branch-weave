const { isDeepStrictEqual } = require('node:util');

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVersion(value) {
  const match = typeof value === 'string'
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
    : null;
  if (!match || match[0] !== value) {
    throw new Error(`Expected a stable semantic version, received ${JSON.stringify(value)}.`);
  }
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error('Version components must be safe integers.');
  }
  return parts;
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function isPrerelease(entry) {
  if (entry.properties === undefined) return false;
  if (!Array.isArray(entry.properties) || !entry.properties.every((property) =>
    isRecord(property) && typeof property.key === 'string' &&
    (typeof property.value === 'string' || typeof property.value === 'boolean'))) {
    throw new Error('Marketplace version properties are malformed.');
  }
  const flags = entry.properties.filter((property) => property.key === 'Microsoft.VisualStudio.Code.PreRelease');
  if (flags.some((flag) => !['true', 'false', true, false].includes(flag.value))) {
    throw new Error('Marketplace prerelease version flag is malformed.');
  }
  return flags.some((flag) => flag.value === 'true' || flag.value === true);
}

function selectReleaseVersion(manifestVersion, gallery) {
  parseVersion(manifestVersion);
  if (!isRecord(gallery) || typeof gallery.extensionName !== 'string' || !gallery.extensionName.trim() ||
      !isRecord(gallery.publisher) || typeof gallery.publisher.publisherName !== 'string' ||
      !gallery.publisher.publisherName.trim() || !Array.isArray(gallery.versions) || !gallery.versions.length) {
    throw new Error('Marketplace extension metadata has no valid versions or publisher identity.');
  }

  let latest;
  for (const entry of gallery.versions) {
    if (!isRecord(entry)) throw new Error('Marketplace version entry is malformed.');
    parseVersion(entry.version);
    if (isPrerelease(entry)) continue;
    if (!latest || compareVersions(entry.version, latest) > 0) latest = entry.version;
  }
  if (!latest) throw new Error('Marketplace has no stable published version.');
  if (compareVersions(manifestVersion, latest) > 0) return manifestVersion;
  const parts = parseVersion(latest);
  if (!Number.isSafeInteger(parts[2] + 1)) throw new Error('Patch version exceeds the safe integer range.');
  parts[2] += 1;
  return parts.join('.');
}

function validateDocuments(manifest, lockfile) {
  if (!isRecord(manifest) || typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error('The package manifest needs a valid name and version.');
  }
  parseVersion(manifest.version);
  if (!isRecord(lockfile) || lockfile.lockfileVersion !== 3 || !isRecord(lockfile.packages) ||
      !isRecord(lockfile.packages[''])) {
    throw new Error('Expected a v3 lockfile containing its root package.');
  }
  if (lockfile.name !== manifest.name || lockfile.packages[''].name !== manifest.name) {
    throw new Error('Manifest and lockfile package identities do not match.');
  }
  if (lockfile.version !== manifest.version || lockfile.packages[''].version !== manifest.version) {
    throw new Error('Manifest and both lockfile versions must already be synchronized.');
  }
}

function withVersion(manifest, lockfile, version) {
  validateDocuments(manifest, lockfile);
  parseVersion(version);
  const nextManifest = structuredClone(manifest);
  const nextLockfile = structuredClone(lockfile);
  nextManifest.version = version;
  nextLockfile.version = version;
  nextLockfile.packages[''].version = version;
  return { manifest: nextManifest, lockfile: nextLockfile };
}

function isVersionOnlyChange(beforeManifest, beforeLock, afterManifest, afterLock) {
  try {
    validateDocuments(beforeManifest, beforeLock);
    validateDocuments(afterManifest, afterLock);
    if (compareVersions(afterManifest.version, beforeManifest.version) <= 0) return false;
    const expected = withVersion(beforeManifest, beforeLock, afterManifest.version);
    return isDeepStrictEqual(expected.manifest, afterManifest) && isDeepStrictEqual(expected.lockfile, afterLock);
  } catch {
    return false;
  }
}

function isTrustedSyncPr(pr, repository) {
  return typeof repository === 'string' && /^[^/\s]+\/[^/\s]+$/.test(repository) &&
    isRecord(pr) && pr.merged === true &&
    pr.user?.login === 'github-actions[bot]' && pr.user?.type === 'Bot' &&
    pr.base?.ref === 'main' && pr.base?.repo?.full_name === repository &&
    pr.head?.ref === 'codex/marketplace-version-sync' && pr.head?.repo?.full_name === repository;
}

module.exports = {
  parseVersion,
  compareVersions,
  selectReleaseVersion,
  withVersion,
  isVersionOnlyChange,
  isTrustedSyncPr,
};
