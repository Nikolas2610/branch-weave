const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const cli = path.resolve(__dirname, 'release.cjs');
const repository = 'Nikolas2610/branch-lens';
const syncBranch = 'codex/marketplace-version-sync';
const canonicalOrigin = `https://github.com/${repository}`;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function command(cwd, executable, args, env = process.env) {
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${executable} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-lens-release-test-'));
  const temporaryParent = fs.realpathSync(os.tmpdir());
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved).toLowerCase(), temporaryParent.toLowerCase());
    assert.match(path.basename(resolved), /^branch-lens-release-test-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const runtimeTemp = path.join(root, 'runtime-temp');
  fs.mkdirSync(runtimeTemp);
  const manifest = { name: 'branch-lens', publisher: 'Nikolas2610', version: '0.1.0', private: false };
  const lockfile = { name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { name: manifest.name, version: manifest.version }, 'node_modules/example': { version: '2.0.0' } } };
  return { root, runtimeTemp, manifest, lockfile };
}

function installFakeVsce(cwd, currentVersion = '0.1.0') {
  const directory = path.join(cwd, 'node_modules/@vscode/vsce');
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(cwd, 'gallery.json'), { extensionName: 'branch-lens', publisher: { publisherName: 'Nikolas2610' },
    versions: [{ version: currentVersion }] });
  fs.writeFileSync(path.join(directory, 'vsce'), `
    const fs = require('node:fs');
    if (process.env.FAIL_FAKE_VSCE === '1') throw new Error('A rerun must not requery or rebuild.');
    fs.appendFileSync('vsce-calls.txt', process.argv[2] + '\\n');
    if (process.argv[2] === 'show') console.log(fs.readFileSync('gallery.json', 'utf8'));
    else if (process.argv[2] === 'package') fs.writeFileSync(process.argv[process.argv.indexOf('--out') + 1], fs.readFileSync('package.json'));
    else throw new Error('No real publication is allowed in this fixture.');
  `);
}

function initializeDocuments(f, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  writeJson(path.join(cwd, 'package.json'), f.manifest);
  writeJson(path.join(cwd, 'package-lock.json'), f.lockfile);
  installFakeVsce(cwd);
}

function releaseEnv(f, cwd, sourceSha = 'a'.repeat(40), runId = '101') {
  return { ...process.env, SOURCE_SHA: sourceSha, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId,
    GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main',
    MARKETPLACE_PUBLISHER: 'Nikolas2610', RELEASE_VERSION: 'auto', GH_TOKEN: 'fixture-token-not-a-credential',
    GITHUB_OUTPUT: path.join(cwd, 'actions-output.txt'), GITHUB_STEP_SUMMARY: path.join(cwd, 'summary.txt'),
    TEMP: f.runtimeTemp, TMP: f.runtimeTemp, TMPDIR: f.runtimeTemp };
}

function invoke(cwd, env, subcommand, preload) {
  return spawnSync(process.execPath, [...(preload ? ['--require', preload] : []), cli, subcommand], {
    cwd, env, encoding: 'utf8', timeout: 30000,
  });
}

function success(result) {
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
}

test('prepare CLI increments equal versions in both files and records the exact stamped package', t => {
  const f = fixture(t);
  const cwd = path.join(f.root, 'checkout');
  initializeDocuments(f, cwd);
  success(invoke(cwd, releaseEnv(f, cwd), 'prepare'));
  const manifest = json(path.join(cwd, 'package.json'));
  const lockfile = json(path.join(cwd, 'package-lock.json'));
  const plan = json(path.join(cwd, 'output/release/plan.json'));
  const vsix = fs.readFileSync(path.join(cwd, 'output/release/branch-lens.vsix'));
  assert.equal(manifest.version, '0.1.1');
  assert.equal(lockfile.version, '0.1.1');
  assert.equal(lockfile.packages[''].version, '0.1.1');
  assert.equal(lockfile.packages['node_modules/example'].version, '2.0.0');
  assert.deepEqual(manifest.branchLensRelease, { repository, sourceSha: 'a'.repeat(40), runId: '101' });
  assert.deepEqual(JSON.parse(vsix.toString()), manifest);
  assert.equal(plan.manifestVersion, '0.1.0');
  assert.equal(plan.version, '0.1.1');
  assert.equal(plan.vsixSha256, crypto.createHash('sha256').update(vsix).digest('hex'));
});

test('prepare rerun reuses its original artifact despite a newer registry without rebuilding', t => {
  const f = fixture(t);
  const cwd = path.join(f.root, 'checkout');
  initializeDocuments(f, cwd);
  const env = releaseEnv(f, cwd);
  success(invoke(cwd, env, 'prepare'));
  const planFile = path.join(cwd, 'output/release/plan.json');
  const vsixFile = path.join(cwd, 'output/release/branch-lens.vsix');
  const originalPlan = fs.readFileSync(planFile);
  const originalVsix = fs.readFileSync(vsixFile);
  // Reruns start with a clean source checkout and restore the persisted artifact.
  writeJson(path.join(cwd, 'package.json'), f.manifest);
  writeJson(path.join(cwd, 'package-lock.json'), f.lockfile);
  writeJson(path.join(cwd, 'gallery.json'), { versions: [{ version: '99.0.0' }] });
  success(invoke(cwd, { ...env, GITHUB_RUN_ATTEMPT: '2', FAIL_FAKE_VSCE: '1' }, 'prepare'));
  assert.deepEqual(fs.readFileSync(planFile), originalPlan);
  assert.deepEqual(fs.readFileSync(vsixFile), originalVsix);
  assert.equal(fs.readFileSync(path.join(cwd, 'vsce-calls.txt'), 'utf8'), 'show\npackage\n');
});

test('prepare rerun refuses a changed package artifact', t => {
  const f = fixture(t);
  const cwd = path.join(f.root, 'checkout');
  initializeDocuments(f, cwd);
  const env = releaseEnv(f, cwd);
  success(invoke(cwd, env, 'prepare'));
  fs.appendFileSync(path.join(cwd, 'output/release/branch-lens.vsix'), '\ntampered');
  const retry = invoke(cwd, { ...env, GITHUB_RUN_ATTEMPT: '2' }, 'prepare');
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /VSIX does not match the persisted release plan/);
});

test('automatic prepare fails closed when the extension has no published stable version or registry access fails', t => {
  const f = fixture(t);
  for (const [name, response] of [
    ['missing', { extensionName: 'branch-lens', publisher: { publisherName: 'Nikolas2610' }, versions: [] }],
    ['malformed', { extensionName: 'branch-lens', publisher: { publisherName: 'Nikolas2610' }, versions: [{ version: 'invalid' }] }],
    ['wrong-identity', { extensionName: 'another-extension', publisher: { publisherName: 'Nikolas2610' }, versions: [{ version: '0.1.0' }] }],
    ['unavailable', null],
  ]) {
    const cwd = path.join(f.root, name);
    initializeDocuments(f, cwd);
    writeJson(path.join(cwd, 'gallery.json'), response);
    const env = releaseEnv(f, cwd);
    if (name === 'unavailable') env.FAIL_FAKE_VSCE = '1';
    const result = invoke(cwd, env, 'prepare');
    assert.notEqual(result.status, 0, `${name} must not infer a first release version`);
    assert.deepEqual(json(path.join(cwd, 'package.json')), f.manifest);
    assert.deepEqual(json(path.join(cwd, 'package-lock.json')), f.lockfile);
    assert.equal(fs.existsSync(path.join(cwd, 'output/release/plan.json')), false);
  }
});

test('manual bootstrap prepares exactly the manifest version without a registry query', t => {
  const f = fixture(t);
  const cwd = path.join(f.root, 'bootstrap');
  initializeDocuments(f, cwd);
  fs.rmSync(path.join(cwd, 'gallery.json'));
  success(invoke(cwd, { ...releaseEnv(f, cwd), GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_VERSION: '0.1.0' }, 'prepare'));
  assert.equal(json(path.join(cwd, 'output/release/plan.json')).version, '0.1.0');
  assert.equal(fs.readFileSync(path.join(cwd, 'vsce-calls.txt'), 'utf8'), 'package\n');
});

test('real VSCE packaging runs the repository prepublish hook and includes the freshly built extension', async t => {
  const f = fixture(t);
  const cwd = path.join(f.root, 'real-package');
  initializeDocuments(f, cwd);
  const projectManifest = json(path.join(__dirname, '../package.json'));
  const manifest = { ...f.manifest, displayName: 'BranchLens fixture', description: 'Release packaging fixture',
    engines: { vscode: '^1.95.0' }, main: './dist/extension.js', activationEvents: ['onStartupFinished'], license: 'MIT',
    repository: { type: 'git', url: `https://github.com/${repository}.git` },
    scripts: { 'vscode:prepublish': projectManifest.scripts['vscode:prepublish'], build: 'node scripts/build.cjs' } };
  writeJson(path.join(cwd, 'package.json'), manifest);
  fs.mkdirSync(path.join(cwd, 'scripts'));
  fs.writeFileSync(path.join(cwd, 'scripts/build.cjs'), `
    const fs = require('node:fs');
    fs.mkdirSync('dist', { recursive: true });
    fs.writeFileSync('dist/extension.js', 'exports.activate = () => "built-during-package";');
  `);
  fs.writeFileSync(path.join(cwd, 'README.md'), '# BranchLens fixture\n');
  fs.writeFileSync(path.join(cwd, 'LICENSE'), 'MIT\n');
  fs.writeFileSync(path.join(cwd, '.vscodeignore'), 'node_modules/**\nscripts/**\noutput/**\n*.txt\ngallery.json\npackage-lock.json\n');
  const realVsce = require.resolve('@vscode/vsce/vsce');
  fs.writeFileSync(path.join(cwd, 'node_modules/@vscode/vsce/vsce'), `
    const fs = require('node:fs');
    if (process.argv[2] === 'show') console.log(fs.readFileSync('gallery.json', 'utf8'));
    else if (process.argv[2] === 'package') require(${JSON.stringify(realVsce)});
    else throw new Error('Real publication is forbidden in this test.');
  `);
  success(invoke(cwd, releaseEnv(f, cwd), 'prepare'));
  const { readZip } = require('@vscode/vsce/out/zip');
  const archive = await readZip(path.join(cwd, 'output/release/branch-lens.vsix'), () => true);
  assert.equal(archive.get('extension/dist/extension.js')?.toString(), 'exports.activate = () => "built-during-package";');
  const packaged = JSON.parse(archive.get('extension/package.json').toString());
  assert.equal(packaged.version, '0.1.1');
  assert.deepEqual(packaged.branchLensRelease, { repository, sourceSha: 'a'.repeat(40), runId: '101' });
});

function git(cwd, ...args) {
  return command(cwd, 'git', args);
}

function gitFixture(t) {
  const f = fixture(t);
  const seed = path.join(f.root, 'seed');
  initializeDocuments(f, seed);
  git(seed, 'init', '--initial-branch=fixture-build');
  fs.writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\noutput/\ngallery.json\n*-calls.txt\nactions-output.txt\nsummary.txt\n');
  git(seed, 'add', '--', 'package.json', 'package-lock.json', '.gitignore');
  git(seed, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-m', 'fixture source');
  const sourceSha = git(seed, 'rev-parse', 'HEAD');
  const bare = path.join(f.root, 'remote.git');
  git(f.root, 'init', '--bare', bare);
  git(f.root, '--git-dir', bare, 'fetch', seed, 'refs/heads/fixture-build:refs/heads/fixture-import');
  // Main is simulated only with local plumbing: no test ever pushes an integration ref.
  git(f.root, '--git-dir', bare, 'update-ref', 'refs/heads/main', sourceSha);
  git(f.root, '--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  const stateFile = path.join(f.root, 'github-state.json');
  writeJson(stateFile, { open: [], closed: [], nextNumber: 1, failCreateOnce: false, requests: [] });
  const preload = path.join(f.root, 'fixture-transport.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const child = require('node:child_process');
    const originalSpawn = child.spawnSync;
    const bare = process.env.FIXTURE_BARE;
    const stateFile = process.env.FIXTURE_STATE;
    const branch = ${JSON.stringify(syncBranch)};
    const repository = ${JSON.stringify(repository)};
    child.spawnSync = (program, args, options) => {
      if (program === 'git' && ['fetch', 'ls-remote', 'push'].includes(args[0])) {
        if (!args.includes('origin')) throw new Error('External fixture Git transport denied.');
        if (args[0] === 'push' && !args.includes('HEAD:refs/heads/' + branch)) throw new Error('Protected or unexpected fixture push denied.');
        args = args.map(argument => argument === 'origin' ? bare : argument);
      }
      return originalSpawn(program, args, options);
    };
    const head = () => {
      const result = originalSpawn('git', ['--git-dir', bare, 'rev-parse', 'refs/heads/' + branch], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error('Fixture branch is missing.');
      return result.stdout.trim();
    };
    global.fetch = async (url, options = {}) => {
      const target = new URL(url);
      const prefix = '/repos/' + repository + '/';
      if (target.origin !== 'https://api.github.com' || !target.pathname.startsWith(prefix)) throw new Error('External fixture network request denied.');
      const endpoint = target.pathname.slice(prefix.length);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : {};
      state.requests.push({ endpoint, method });
      let result;
      let status = 200;
      if (method === 'GET' && endpoint === 'pulls') {
        result = target.searchParams.get('state') === 'closed' ? state.closed : state.open.map(pr => ({ ...pr, head: { ...pr.head, sha: head() } }));
      } else if (method === 'POST' && endpoint === 'pulls') {
        if (state.failCreateOnce) { state.failCreateOnce = false; result = { message: 'Fixture PR creation failed after push.' }; status = 503; }
        else {
          result = { number: state.nextNumber++, state: 'open', merged: false, user: { login: 'github-actions[bot]', type: 'Bot' },
            base: { ref: 'main', repo: { full_name: repository } },
            head: { ref: branch, sha: head(), repo: { full_name: repository } },
            html_url: 'https://github.com/' + repository + '/pull/' + (state.nextNumber - 1), ...body };
          // The real REST response has structured head/base rather than the request strings.
          result.head = { ref: branch, sha: head(), repo: { full_name: repository } };
          result.base = { ref: 'main', repo: { full_name: repository } };
          state.open.push(result);
        }
      } else if (method === 'PATCH' && /^pulls\\/\\d+$/.test(endpoint)) {
        const number = Number(endpoint.split('/')[1]);
        const prior = state.open.find(pr => pr.number === number);
        if (!prior) throw new Error('Unknown fixture PR.');
        result = { ...prior, ...body, head: { ...prior.head, sha: head() } };
        if (body.state === 'closed') { state.open = state.open.filter(pr => pr.number !== number); state.closed.push(result); }
        else state.open = state.open.map(pr => pr.number === number ? result : pr);
      } else throw new Error('Unexpected GitHub fixture endpoint: ' + method + ' ' + endpoint);
      fs.writeFileSync(stateFile, JSON.stringify(state));
      return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } });
    };
  `);
  return { ...f, seed, bare, stateFile, preload, sourceSha };
}

function clone(f, name, currentVersion = '0.1.0', runId = '101') {
  const cwd = path.join(f.root, name);
  git(f.root, 'clone', '--no-local', f.bare, cwd);
  git(cwd, 'remote', 'set-url', 'origin', canonicalOrigin);
  const sourceSha = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'checkout', '--detach', sourceSha);
  installFakeVsce(cwd, currentVersion);
  const env = { ...releaseEnv(f, cwd, sourceSha, runId), FIXTURE_BARE: f.bare, FIXTURE_STATE: f.stateFile };
  return { cwd, env, sourceSha };
}

function remoteSha(f, ref = syncBranch) {
  return git(f.root, '--git-dir', f.bare, 'rev-parse', `refs/heads/${ref}`);
}

test('sync CLI creates a version-only PR and reuses a retained merged branch for the next release', t => {
  const f = gitFixture(t);
  const first = clone(f, 'first');
  success(invoke(first.cwd, first.env, 'prepare'));
  success(invoke(first.cwd, first.env, 'sync', f.preload));
  const firstSyncSha = remoteSha(f);
  assert.equal(remoteSha(f, 'main'), f.sourceSha, 'sync must never push to main');
  const state = json(f.stateFile);
  assert.equal(state.open.length, 1);
  assert.equal(state.open[0].user.login, 'github-actions[bot]');
  assert.deepEqual(git(f.root, '--git-dir', f.bare, 'diff', '--name-only', f.sourceSha, firstSyncSha).split('\n'), ['package-lock.json', 'package.json']);
  assert.equal(JSON.parse(git(f.root, '--git-dir', f.bare, 'show', `${firstSyncSha}:package.json`)).branchLensRelease, undefined);
  // Simulate merging through local fixture plumbing; retain the remote sync branch.
  git(f.root, '--git-dir', f.bare, 'update-ref', 'refs/heads/main', firstSyncSha, f.sourceSha);
  writeJson(f.stateFile, { ...state, open: [], closed: [{ ...state.open[0], state: 'closed', merged: true }] });
  const application = clone(f, 'application', '0.1.1');
  git(application.cwd, 'switch', '-c', 'fixture-application');
  fs.writeFileSync(path.join(application.cwd, 'application.txt'), 'new application code\n');
  git(application.cwd, 'add', '--', 'application.txt');
  git(application.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-m', 'application change');
  const nextSource = git(application.cwd, 'rev-parse', 'HEAD');
  git(f.root, '--git-dir', f.bare, 'fetch', application.cwd, 'refs/heads/fixture-application:refs/heads/fixture-import');
  git(f.root, '--git-dir', f.bare, 'update-ref', 'refs/heads/main', nextSource, firstSyncSha);
  const second = clone(f, 'second', '0.1.1', '102');
  success(invoke(second.cwd, second.env, 'prepare'));
  success(invoke(second.cwd, second.env, 'sync', f.preload));
  const secondSyncSha = remoteSha(f);
  assert.notEqual(secondSyncSha, firstSyncSha);
  assert.equal(remoteSha(f, 'main'), nextSource, 'the next sync must also leave main unchanged');
  assert.equal(JSON.parse(git(f.root, '--git-dir', f.bare, 'show', `${secondSyncSha}:package.json`)).version, '0.1.2');
  assert.equal(json(f.stateFile).open.length, 1);
});

test('sync CLI recovers in a fresh checkout after branch push succeeded but PR creation failed', t => {
  const f = gitFixture(t);
  const initialState = json(f.stateFile);
  writeJson(f.stateFile, { ...initialState, failCreateOnce: true });
  const first = clone(f, 'failed-attempt');
  success(invoke(first.cwd, first.env, 'prepare'));
  const failed = invoke(first.cwd, first.env, 'sync', f.preload);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /HTTP 503/);
  assert.equal(json(f.stateFile).open.length, 0);
  assert.match(remoteSha(f), /^[a-f0-9]{40}$/);
  const retry = clone(f, 'retry');
  fs.mkdirSync(path.join(retry.cwd, 'output/release'), { recursive: true });
  for (const name of ['plan.json', 'branch-lens.vsix']) {
    fs.copyFileSync(path.join(first.cwd, 'output/release', name), path.join(retry.cwd, 'output/release', name));
  }
  success(invoke(retry.cwd, { ...retry.env, GITHUB_RUN_ATTEMPT: '2' }, 'sync', f.preload));
  assert.equal(json(f.stateFile).open.length, 1);
  assert.equal(remoteSha(f, 'main'), f.sourceSha);
});

test('old release recovery preserves a newer pending synchronization PR', t => {
  const f = gitFixture(t);
  const first = clone(f, 'first');
  success(invoke(first.cwd, first.env, 'prepare'));
  success(invoke(first.cwd, first.env, 'sync', f.preload));
  const firstSyncSha = remoteSha(f);
  const firstState = json(f.stateFile);
  git(f.root, '--git-dir', f.bare, 'update-ref', 'refs/heads/main', firstSyncSha, f.sourceSha);
  writeJson(f.stateFile, { ...firstState, open: [], closed: [{ ...firstState.open[0], state: 'closed', merged: true }] });

  const application = clone(f, 'application', '0.1.1');
  git(application.cwd, 'switch', '-c', 'fixture-application');
  fs.writeFileSync(path.join(application.cwd, 'application.txt'), 'second application release\n');
  git(application.cwd, 'add', '--', 'application.txt');
  git(application.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@users.noreply.github.com', 'commit', '-m', 'second application change');
  const nextSource = git(application.cwd, 'rev-parse', 'HEAD');
  git(f.root, '--git-dir', f.bare, 'fetch', application.cwd, 'refs/heads/fixture-application:refs/heads/fixture-import');
  git(f.root, '--git-dir', f.bare, 'update-ref', 'refs/heads/main', nextSource, firstSyncSha);

  const second = clone(f, 'second', '0.1.1', '102');
  success(invoke(second.cwd, second.env, 'prepare'));
  success(invoke(second.cwd, second.env, 'sync', f.preload));
  const pending = json(f.stateFile).open[0];
  assert.match(pending.title, /0\.1\.2/);
  const pendingHead = remoteSha(f);

  // Model rerunning the older publication after .1 is already in main, while .2
  // is still waiting for its synchronization PR to merge.
  const recovery = clone(f, 'old-recovery');
  git(recovery.cwd, 'checkout', '--detach', first.sourceSha);
  fs.mkdirSync(path.join(recovery.cwd, 'output/release'), { recursive: true });
  for (const name of ['plan.json', 'branch-lens.vsix']) {
    fs.copyFileSync(path.join(first.cwd, 'output/release', name), path.join(recovery.cwd, 'output/release', name));
  }
  const recoveryEnv = { ...recovery.env, SOURCE_SHA: first.sourceSha, GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '2' };
  success(invoke(recovery.cwd, recoveryEnv, 'sync', f.preload));
  const remaining = json(f.stateFile).open;
  assert.equal(remaining.length, 1, 'recovering .1 must not close the pending .2 synchronization PR');
  assert.equal(remaining[0].number, pending.number);
  assert.match(remaining[0].title, /0\.1\.2/);
  assert.equal(remoteSha(f), pendingHead, 'older recovery must not replace the newer version branch');
  assert.equal(remoteSha(f, 'main'), nextSource);
});
