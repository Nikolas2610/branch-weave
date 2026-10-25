import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { GitRepository, safeRelativePath } from '../src/git';

async function git(root: string, args: string[], input?: Buffer | string, environment?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...environment } }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${args.join(' ')}: ${stderr || error.message}`));
      else resolve(stdout.replace(/\r?\n$/, ''));
    });
    child.stdin?.end(input);
  });
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'branchlens-git-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'BranchLens Test']);
  await git(root, ['config', 'user.email', 'branchlens@example.invalid']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await writeFile(path.join(root, 'shared.txt'), 'base\n');
  await commit(root, 'base');
  return root;
}

async function commit(root: string, message: string): Promise<string> {
  await git(root, ['add', '--all']);
  await git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

async function objectCommit(root: string, entries: { name: string; content?: string | Buffer; mode?: string; oid?: string }[], parent?: string): Promise<string> {
  const records: string[] = [];
  for (const entry of entries) {
    const mode = entry.mode ?? '100644';
    const oid = entry.oid ?? await git(root, ['hash-object', '-w', '--stdin'], entry.content ?? '');
    records.push(`${mode} ${mode === '160000' ? 'commit' : 'blob'} ${oid}\t${entry.name}\0`);
  }
  const tree = await git(root, ['mktree', '-z'], records.join(''));
  return git(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'object fixture']);
}

test('uses merge base by default, direct tips for upstream, and immutable resolved endpoints', async (t) => {
  const root = await fixture(t);
  const base = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['checkout', '-b', 'feature']);
  await writeFile(path.join(root, 'feature.txt'), 'feature\n');
  const feature = await commit(root, 'feature');
  await git(root, ['checkout', 'main']);
  await writeFile(path.join(root, 'main.txt'), 'upstream\n');
  const main = await commit(root, 'upstream');
  const repo = new GitRepository(root);
  const isolated = await repo.compare('main', 'feature', false);
  assert.equal(isolated.leftSha, base);
  assert.equal(isolated.leftTipSha, main);
  assert.equal(isolated.rightSha, feature);
  assert.deepEqual(isolated.files.map((f) => [f.status, f.newPath]), [['A', 'feature.txt']]);
  const direct = await repo.compare('main', 'feature', true);
  assert.equal(direct.leftSha, main);
  assert.deepEqual(direct.files.map((f) => [f.status, f.newPath]), [['A', 'feature.txt'], ['D', 'main.txt']]);
  const swapped = await repo.compare('feature', 'main', true);
  assert.deepEqual(swapped.files.map((f) => [f.status, f.newPath]), [['D', 'feature.txt'], ['A', 'main.txt']]);
  await writeFile(path.join(root, 'shared.txt'), 'later\n');
  await commit(root, 'later');
  assert.equal((await repo.readFile(direct.leftSha, 'shared.txt')).text, 'base\n');
  assert.equal(direct.leftSha, main);
  assert.notEqual(isolated.id, direct.id);
});

test('pairs rename statistics and handles add/delete/empty/binary and unusual Git paths', async (t) => {
  const root = await fixture(t);
  const left = await objectCommit(root, [
    { name: 'delete.txt', content: 'one\ntwo\n' },
    { name: 'old name.txt', content: 'rename me\nunchanged\n' },
    { name: 'modify.txt', content: 'before\n' },
  ]);
  const right = await objectCommit(root, [
    { name: 'νέο space.txt', content: 'rename me\nunchanged\n' },
    { name: 'modify.txt', content: 'after\nextra\n' },
    { name: 'empty.txt', content: '' },
    { name: 'odd\tname\n.txt', content: 'odd\n' },
    { name: 'binary.bin', content: Buffer.from([0, 1, 2]) },
  ], left);
  const comparison = await new GitRepository(root).compare(left, right, true);
  const rename = comparison.files.find((f) => f.status === 'R');
  assert.deepEqual(rename, { status: 'R', oldPath: 'old name.txt', newPath: 'νέο space.txt', additions: 0, deletions: 0 });
  const byName = new Map(comparison.files.map((f) => [f.newPath, f]));
  assert.equal(byName.get('delete.txt')?.deletions, 2);
  assert.equal(byName.get('modify.txt')?.additions, 2);
  assert.equal(byName.get('modify.txt')?.deletions, 1);
  assert.equal(byName.get('empty.txt')?.additions, 0);
  assert.equal(byName.get('odd\tname\n.txt')?.additions, 1);
  assert.equal(byName.get('binary.bin')?.additions, null);
  assert.equal(byName.get('binary.bin')?.deletions, null);
  assert.equal((await new GitRepository(root).readFile(right, 'odd\tname\n.txt')).text, 'odd\n');
});

test('distinguishes absent from empty, preserves text bytes, and caches immutable snapshots', async (t) => {
  const root = await fixture(t);
  const sha = await objectCommit(root, [
    { name: 'empty.txt', content: '' },
    { name: 'crlf.txt', content: 'one\r\ntwo\r\n' },
    { name: 'no-newline.txt', content: 'one\ntwo' },
    { name: ':(glob)*.txt', content: 'literal magic\n' },
  ]);
  const repo = new GitRepository(root);
  const empty = await repo.readFile(sha, 'empty.txt');
  assert.equal(empty.exists, true);
  assert.equal(empty.text, '');
  assert.equal(empty.binary, false);
  assert.equal((await repo.readFile(sha, 'absent.txt')).exists, false);
  assert.equal((await repo.readFile(sha, 'crlf.txt')).text, 'one\r\ntwo\r\n');
  assert.equal((await repo.readFile(sha, 'no-newline.txt')).text, 'one\ntwo');
  assert.equal((await repo.readFile(sha, ':(glob)*.txt')).text, 'literal magic\n');
  const repeated = await Promise.all([repo.readFile(sha, 'empty.txt'), repo.readFile(sha, 'empty.txt')]);
  assert.strictEqual(repeated[0], empty);
  assert.strictEqual(repeated[1], empty);
  assert.equal(Object.isFrozen(empty), true);
});

test('declines mixed LF/CRLF and standalone CR before editor normalization can alter them', async (t) => {
  const root = await fixture(t);
  const sha = await objectCommit(root, [
    { name: 'mixed.txt', content: 'one\r\ntwo\nthree\r\n' },
    { name: 'carriage-return.txt', content: 'one\rtwo\r' },
    { name: 'trailing-return.txt', content: 'one\ntwo\r' },
    { name: 'lf.txt', content: 'one\ntwo\n' },
    { name: 'crlf.txt', content: 'one\r\ntwo\r\n' },
  ]);
  const repo = new GitRepository(root);
  for (const filename of ['mixed.txt', 'carriage-return.txt', 'trailing-return.txt']) {
    const snapshot = await repo.readFile(sha, filename);
    assert.equal(snapshot.exists, true, filename);
    assert.equal(snapshot.binary, true, filename);
    assert.match(snapshot.reason ?? '', /line endings|carriage return/i, filename);
    assert.equal(snapshot.text, '', filename);
  }
  assert.equal((await repo.readFile(sha, 'lf.txt')).text, 'one\ntwo\n');
  assert.equal((await repo.readFile(sha, 'crlf.txt')).text, 'one\r\ntwo\r\n');
});

test('missing promisor blobs never cause snapshots or comparisons to fetch, even from a local remote', async (t) => {
  const source = await fixture(t);
  const left = await git(source, ['rev-parse', 'HEAD']);
  const leftBlob = await git(source, ['rev-parse', `${left}:shared.txt`]);
  await writeFile(path.join(source, 'shared.txt'), 'later\n');
  const right = await commit(source, 'later');
  const rightBlob = await git(source, ['rev-parse', `${right}:shared.txt`]);
  await git(source, ['config', 'uploadpack.allowFilter', 'true']);

  for (const operation of ['snapshot', 'comparison', 'working comparison'] as const) {
    await t.test(operation, async () => {
      const clone = path.join(source, `partial-${operation}`);
      await git(source, ['clone', '--no-checkout', '--filter=blob:none', '--single-branch', pathToFileURL(source).href, clone]);
      // The local file:// server supports filters, so commits/trees exist and both blobs do not.
      await assert.rejects(git(clone, ['cat-file', '-e', leftBlob], undefined, { GIT_NO_LAZY_FETCH: '1' }));
      await assert.rejects(git(clone, ['cat-file', '-e', rightBlob], undefined, { GIT_NO_LAZY_FETCH: '1' }));
      const repository = new GitRepository(clone);
      if (operation === 'snapshot') await assert.rejects(repository.readFile(right, 'shared.txt'), /Git.*failed|missing|unavailable|object/i);
      else if (operation === 'comparison') await assert.rejects(repository.compare(left, right, true), /Git.*failed|missing|unavailable|object/i);
      else await assert.rejects(repository.compareWorking(left, true), /Git.*failed|missing|unavailable|object/i);
      // No object hydration took place. The available remote makes this fail if lazy fetching returns.
      await assert.rejects(git(clone, ['cat-file', '-e', leftBlob], undefined, { GIT_NO_LAZY_FETCH: '1' }));
      await assert.rejects(git(clone, ['cat-file', '-e', rightBlob], undefined, { GIT_NO_LAZY_FETCH: '1' }));
    });
  }
});

test('explicitly declines binary, invalid UTF-8, LFS, symlink, submodule, and oversized objects', async (t) => {
  const root = await fixture(t);
  const base = await git(root, ['rev-parse', 'HEAD']);
  const sha = await objectCommit(root, [
    { name: 'binary', content: Buffer.from([0, 255]) },
    { name: 'invalid', content: Buffer.from([0xc3, 0x28]) },
    { name: 'lfs', content: `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 123\n` },
    { name: 'link', mode: '120000', content: '../outside' },
    { name: 'module', mode: '160000', oid: base },
    { name: 'large', content: 'a'.repeat(2 * 1024 * 1024 + 1) },
    { name: 'executable', mode: '100755', content: '#!/bin/sh\necho hello\n' },
  ]);
  const repo = new GitRepository(root);
  for (const [filename, reason] of [['binary', /binary/i], ['invalid', /UTF-?8/i], ['lfs', /LFS/i], ['link', /symbolic link|symlink/i], ['module', /submodule/i], ['large', /2\s*Mi?B|size|large/i]] as const) {
    const snapshot = await repo.readFile(sha, filename);
    assert.equal(snapshot.exists, true, filename);
    assert.match(snapshot.reason ?? '', reason, filename);
    assert.equal(snapshot.text, '', filename);
  }
  const executable = await repo.readFile(sha, 'executable');
  assert.equal(executable.mode, '100755');
  assert.equal(executable.binary, false);
  assert.equal(executable.text, '#!/bin/sh\necho hello\n');
});

test('reports unrelated histories and invalid refs without treating them as an empty comparison', async (t) => {
  const root = await fixture(t);
  const unrelated = await objectCommit(root, [{ name: 'other.txt', content: 'other\n' }]);
  const repo = new GitRepository(root);
  await assert.rejects(repo.compare('main', unrelated, false), /unrelated|common ancestor|merge base/i);
  await assert.rejects(repo.compare('main', '--help', true), /reference|revision|resolve|commit/i);
  assert.equal((await repo.compare('main', unrelated, true)).files.length, 2);
  assert.equal((await repo.compare('main', 'main', false)).files.length, 0);
});

test('lists local and remote branches and safely discovers opened and nested repositories', async (t) => {
  const root = await fixture(t);
  await git(root, ['branch', 'feature/with-space-like-name']);
  await git(root, ['update-ref', 'refs/remotes/origin/topic', 'HEAD']);
  const repo = new GitRepository(root);
  assert.equal(await repo.currentBranch(), 'main');
  const branches = await repo.branches();
  assert.ok(branches.some((b) => b.name === 'main' && b.current && !b.remote));
  assert.ok(branches.some((b) => b.name === 'origin/topic' && b.remote && !b.current));
  const nested = path.join(root, 'packages', 'nested');
  await mkdir(nested, { recursive: true });
  await git(nested, ['init', '--initial-branch=main']);
  const discovered = await GitRepository.discover([root, path.join(root, 'shared.txt'), nested]);
  assert.deepEqual(new Set(discovered.map((r) => path.resolve(r.root).toLowerCase())), new Set([root, nested].map((p) => path.resolve(p).toLowerCase())));
});

test('only creates a worktree on explicit request and discovers the opened worktree', async (t) => {
  const root = await fixture(t);
  const destination = path.join(root, 'linked checkout');
  const repo = new GitRepository(root);
  assert.equal((await repo.worktrees()).length, 1);
  await repo.createWorktree('main', destination, 'draft-testing');
  const worktrees = await repo.worktrees();
  assert.equal(worktrees.length, 2);
  const linked = worktrees.find((w) => path.resolve(w.path).toLowerCase() === path.resolve(destination).toLowerCase());
  assert.equal(linked?.branch, 'draft-testing');
  assert.match(linked?.head ?? '', /^[0-9a-f]{40,64}$/);
  assert.equal(await new GitRepository(destination).currentBranch(), 'draft-testing');
  const discovered = await GitRepository.discover([destination]);
  assert.ok(discovered.some((r) => path.resolve(r.root).toLowerCase() === path.resolve(destination).toLowerCase()));
  assert.equal(await repo.currentBranch(), 'main');
});

test('rejects traversal and absolute paths before accessing Git objects', async (t) => {
  const root = await fixture(t);
  const repo = new GitRepository(root);
  const sha = await git(root, ['rev-parse', 'HEAD']);
  for (const filename of ['', '../secret', 'a/../../secret', '/secret', 'C:/secret', 'a\\..\\secret', 'a\0b']) {
    assert.throws(() => safeRelativePath(filename), /path/i);
    await assert.rejects(repo.readFile(sha, filename), /path/i);
  }
  assert.equal(safeRelativePath('folder/ελληνικά with space.txt'), 'folder/ελληνικά with space.txt');
});

test('working comparisons use the checked-out branch with merge-base and direct-reference modes', async (t) => {
  const root = await fixture(t);
  const base = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['checkout', '-b', 'feature']);
  await writeFile(path.join(root, 'feature.txt'), 'feature\n');
  const feature = await commit(root, 'feature');
  await git(root, ['checkout', 'main']);
  await writeFile(path.join(root, 'upstream.txt'), 'upstream\n');
  const main = await commit(root, 'upstream');
  await git(root, ['checkout', 'feature']);
  await writeFile(path.join(root, 'shared.txt'), 'live\n');
  const repo = new GitRepository(root);
  const isolated = await repo.compareWorking('main', false);
  assert.equal(isolated.leftSha, base);
  assert.equal(isolated.leftTipSha, main);
  assert.equal(isolated.rightSha, feature);
  assert.equal(isolated.rightRef, 'feature');
  assert.equal(isolated.rightWorkingTree, true);
  assert.deepEqual(isolated.files.map(f => [f.status, f.newPath]), [['A', 'feature.txt'], ['M', 'shared.txt']]);
  const direct = await repo.compareWorking('main', true);
  assert.equal(direct.leftSha, main);
  assert.ok(direct.files.some(f => f.status === 'D' && f.newPath === 'upstream.txt'));
  await git(root, ['checkout', '--', 'shared.txt']);
  await git(root, ['checkout', 'main']);
  assert.equal((await repo.compareWorking('main', false)).rightRef, 'main');
  await git(root, ['checkout', '--detach', feature]);
  await git(root, ['config', 'core.abbrev', '12']);
  const detached = await repo.compareWorking('main', false);
  assert.match(detached.rightRef, /^detached:/);
  assert.equal(detached.rightRef, await repo.currentBranch());
  assert.equal(detached.rightSha, feature);
});

test('working discovery rejects checkout ref or HEAD changes instead of mixing comparison identities', async (t) => {
  for (const change of ['ref', 'HEAD'] as const) {
    await t.test(change, async () => {
      const root = await fixture(t);
      await git(root, ['branch', 'other']);
      const changedHead = await objectCommit(root, [{ name: 'shared.txt', content: 'different commit\n' }], await git(root, ['rev-parse', 'HEAD']));
      class ConcurrentCheckoutRepository extends GitRepository {
        override async readFile(sha: string, filename: string) {
          // Move real repository identity during the awaited buffer-baseline read.
          if (change === 'ref') await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/other']);
          else await git(root, ['update-ref', 'HEAD', changedHead]);
          return super.readFile(sha, filename);
        }
      }
      await assert.rejects(
        new ConcurrentCheckoutRepository(root).compareWorking('main', false, new Map([['shared.txt', 'unsaved\n']])),
        /checkout|branch|HEAD.*changed/i,
      );
    });
  }
});

test('working comparisons include staged, unstaged, untracked, deleted, and renamed disk files', async (t) => {
  const root = await fixture(t);
  for (const name of ['staged.txt', 'unstaged.txt', 'delete.txt', 'old name.txt']) await writeFile(path.join(root, name), `${name}\nunchanged\n`);
  await writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await commit(root, 'tracked files');
  await writeFile(path.join(root, 'staged.txt'), 'stage\n');
  await git(root, ['add', 'staged.txt']);
  await writeFile(path.join(root, 'staged.txt'), 'stage\nlatest\n');
  await writeFile(path.join(root, 'unstaged.txt'), 'unstaged\n');
  await rm(path.join(root, 'delete.txt'));
  await rename(path.join(root, 'old name.txt'), path.join(root, 'renamed space.txt'));
  await git(root, ['add', '-A', '--', 'old name.txt', 'renamed space.txt']);
  await writeFile(path.join(root, 'new.txt'), 'new\n');
  await git(root, ['add', 'new.txt']);
  await writeFile(path.join(root, 'untracked space.txt'), 'untracked\nsecond\n');
  await writeFile(path.join(root, 'empty.txt'), '');
  await writeFile(path.join(root, 'ignored.txt'), 'ignored\n');
  const repo = new GitRepository(root);
  const result = await repo.compareWorking('main', false);
  const files = new Map(result.files.map(f => [f.newPath, f]));
  assert.equal(files.size, 7);
  assert.deepEqual(files.get('staged.txt'), { status: 'M', oldPath: 'staged.txt', newPath: 'staged.txt', additions: 2, deletions: 2 });
  assert.equal(files.get('unstaged.txt')?.status, 'M');
  assert.equal(files.get('delete.txt')?.status, 'D');
  assert.equal(files.get('new.txt')?.status, 'A');
  assert.deepEqual(files.get('renamed space.txt'), { status: 'R', oldPath: 'old name.txt', newPath: 'renamed space.txt', additions: 0, deletions: 0 });
  assert.equal(files.get('untracked space.txt')?.additions, 2);
  assert.equal(files.get('empty.txt')?.additions, 0);
  assert.equal((await repo.readWorkingFile('staged.txt')).text, 'stage\nlatest\n');
  assert.equal((await repo.readWorkingFile('delete.txt')).exists, false);
  assert.equal((await repo.readWorkingFile('empty.txt')).exists, true);
});

test('unsaved buffers discover changes on clean disk and can restore the left baseline', async (t) => {
  const root = await fixture(t);
  const repo = new GitRepository(root);
  const unsaved = await repo.compareWorking('main', false, new Map([
    ['shared.txt', 'unsaved\nextra\n'], ['new unsaved.txt', ''],
  ]));
  assert.deepEqual(unsaved.files, [
    { status: 'M', oldPath: 'shared.txt', newPath: 'shared.txt', additions: 2, deletions: 1 },
    { status: 'A', oldPath: 'new unsaved.txt', newPath: 'new unsaved.txt', additions: 0, deletions: 0 },
  ]);
  assert.equal((await repo.readWorkingFile('shared.txt')).text, 'base\n');
  await writeFile(path.join(root, 'shared.txt'), 'disk\n');
  assert.deepEqual((await repo.compareWorking('main', false, new Map([['shared.txt', 'base\n']]))).files, []);
  await assert.rejects(repo.compareWorking('main', false, new Map([['../outside', 'bad']])) , /path/i);
});

test('working snapshot reads preserve exact supported text and refuse unsupported or escaping files', async (t) => {
  const root = await fixture(t);
  const repo = new GitRepository(root);
  for (const [name, text] of [['lf', 'one\ntwo\n'], ['crlf', 'one\r\ntwo\r\n'], ['no-newline', 'one'], ['empty', '']] as const) {
    await writeFile(path.join(root, name), text);
    assert.equal((await repo.readWorkingFile(name)).text, text);
  }
  for (const [name, bytes, reason] of [
    ['binary', Buffer.from([0, 255]), /binary/i],
    ['invalid', Buffer.from([0xc3, 0x28]), /UTF-?8/i],
    ['mixed', 'one\r\ntwo\n', /line endings/i],
    ['cr', 'one\rtwo', /carriage return/i],
    ['lfs', 'version https://git-lfs.github.com/spec/v1\n', /LFS/i],
    ['large', 'x'.repeat(2 * 1024 * 1024 + 1), /size|2\s*MiB/i],
  ] as const) {
    await writeFile(path.join(root, name), bytes);
    const snapshot = await repo.readWorkingFile(name);
    assert.equal(snapshot.binary, true, name);
    assert.equal(snapshot.text, '', name);
    assert.match(snapshot.reason ?? '', reason, name);
  }
  await mkdir(path.join(root, 'module'));
  await git(root, ['update-index', '--add', '--cacheinfo', `160000,${await git(root, ['rev-parse', 'HEAD'])},module`]);
  assert.match((await repo.readWorkingFile('module')).reason ?? '', /submodule/i);
  await writeFile(path.join(root, 'module', 'nested.txt'), 'nested checkout content\n');
  assert.match((await repo.readWorkingFile('module/nested.txt')).reason ?? '', /submodule/i);
  for (const filename of ['../secret', 'C:/secret', 'a/../../secret', '.git/config']) await assert.rejects(repo.readWorkingFile(filename), /path|metadata/i);
  const outside = await mkdtemp(path.join(tmpdir(), 'branchlens-outside-'));
  t.after(async () => { await rm(outside, { recursive: true, force: true }); });
  await writeFile(path.join(outside, 'secret'), 'secret');
  try { await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
  await assert.rejects(repo.readWorkingFile('linked/secret'), /symbolic|symlink/i);
});
