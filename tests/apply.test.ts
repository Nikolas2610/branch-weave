import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ApplyConflict, buildApplyPlan, safeApplyPath, type ApplyContent } from '../src/applyPlan';

const exec = promisify(execFile);
const content = (text = '', filePath = 'file.txt', exists = true, mode = '100644'): ApplyContent => ({ text, path: filePath, exists, mode });

async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branchlens-apply-'));
  t.after(async () => {
    assert.ok(path.dirname(root) === os.tmpdir());
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return root;
}

test('an edit plan is read-only and retains the complete draft text', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const plan = await buildApplyPlan(root, content('old\n'), content('new\n'));
  assert.equal(plan.kind, 'edit');
  assert.equal(plan.text, 'new\n');
  assert.equal(await fs.readFile(plan.source, 'utf8'), 'old\n');
});

test('uniform draft line endings have an explicit EOL plan for edits and creation', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  const crlf = await buildApplyPlan(root, content('old\n'), content('first\r\nsecond\r\n'));
  assert.equal(crlf.eol, 'CRLF');
  assert.equal(crlf.text, 'first\r\nsecond\r\n');
  await fs.writeFile(path.join(root, 'file.txt'), 'old\r\n');
  const lf = await buildApplyPlan(root, content('old\r\n'), content('first\nsecond\n'));
  assert.equal(lf.eol, 'LF');
  assert.equal(lf.text, 'first\nsecond\n');
  const create = await buildApplyPlan(root, content('', 'new.txt', false), content('new\r\n', 'new.txt'));
  assert.equal(create.kind, 'create');
  assert.equal(create.eol, 'CRLF');
  const noLines = await buildApplyPlan(root, content('old\r\n'), content('unterminated'));
  assert.equal(noLines.eol, undefined);
});

test('mixed and standalone-CR draft endings refuse application with patch guidance', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'baseline\n');
  for (const text of ['first\r\nsecond\n', 'first\nsecond\r\n', 'first\rsecond\r']) {
    await assert.rejects(buildApplyPlan(root, content('baseline\n'), content(text)), /Export the draft as a patch/);
  }
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'baseline\n');
});

test('a BOM stripped by the editor is a baseline conflict, preventing data loss', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), '\ufeffbaseline\r\n');
  await assert.rejects(buildApplyPlan(root, content('\ufeffbaseline\r\n'), content('\ufeffdraft\r\n'), {
    readBuffer: () => ({ text: 'baseline\r\n', isDirty: false }),
  }), ApplyConflict);
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), '\ufeffbaseline\r\n');
});

test('missing and empty files produce explicit create and delete operations', async t => {
  const root = await fixture(t);
  assert.equal((await buildApplyPlan(root, content('', 'file.txt', false), content(''))).kind, 'create');
  await fs.writeFile(path.join(root, 'file.txt'), '');
  assert.equal((await buildApplyPlan(root, content(''), content('', 'file.txt', false))).kind, 'delete');
  await assert.rejects(buildApplyPlan(root, content('', 'file.txt', false), content('new')), ApplyConflict);
  await fs.unlink(path.join(root, 'file.txt'));
  await assert.rejects(buildApplyPlan(root, content(''), content('new')), ApplyConflict);
});

test('unchanged and absent drafts produce no operation', async t => {
  const root = await fixture(t);
  assert.equal((await buildApplyPlan(root, content('', 'file.txt', false), content('', 'file.txt', false))).kind, 'none');
  await fs.writeFile(path.join(root, 'file.txt'), 'same');
  assert.equal((await buildApplyPlan(root, content('same'), content('same'))).kind, 'none');
});

test('baseline disk conflicts retain current content for reconciliation', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'working edit');
  await assert.rejects(buildApplyPlan(root, content('baseline'), content('draft')), error => {
    assert.ok(error instanceof ApplyConflict);
    assert.equal(error.actual.text, 'working edit');
    assert.equal(error.draft.text, 'draft');
    return true;
  });
});

test('unsaved buffers conflict even when the saved working file matches', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'baseline');
  await assert.rejects(buildApplyPlan(root, content('baseline'), content('draft'), {
    readBuffer: () => ({ text: 'unsaved edit', isDirty: true }),
  }), error => {
    assert.ok(error instanceof ApplyConflict);
    assert.equal(error.actual.text, 'unsaved edit');
    return true;
  });
});

test('an unsaved new buffer prevents creation and disk drift is never masked by a buffer', async t => {
  const root = await fixture(t);
  await assert.rejects(buildApplyPlan(root, content('', 'file.txt', false), content('draft'), {
    readBuffer: () => ({ text: '', isDirty: true }),
  }), ApplyConflict);
  await fs.writeFile(path.join(root, 'file.txt'), 'changed on disk');
  await assert.rejects(buildApplyPlan(root, content('baseline'), content('draft'), {
    readBuffer: () => ({ text: 'baseline', isDirty: false }),
  }), ApplyConflict);
});

test('rename is explicit and an existing or unsaved destination is never overwritten', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'baseline');
  const draft = content('draft', 'renamed.txt');
  assert.equal((await buildApplyPlan(root, content('baseline'), draft)).kind, 'rename');
  await fs.writeFile(path.join(root, 'renamed.txt'), '');
  await assert.rejects(buildApplyPlan(root, content('baseline'), draft), ApplyConflict);
  await fs.unlink(path.join(root, 'renamed.txt'));
  await assert.rejects(buildApplyPlan(root, content('baseline'), draft, {
    readBuffer: absolutePath => path.basename(absolutePath) === 'renamed.txt' ? { text: 'unsaved destination', isDirty: true } : undefined,
  }), ApplyConflict);
});

test('path traversal, Git metadata, Windows drive paths and alternate streams are refused', async t => {
  const root = await fixture(t);
  for (const unsafe of ['../escape', 'a/../../escape', '/absolute', 'C:/absolute', '\\\\server\\share', 'folder\\file', '.git/config', 'folder/.GIT/config', '.git./config', '.git /config', 'a:stream', 'a//b', './file']) {
    await assert.rejects(safeApplyPath(root, unsafe), /Unsafe|escapes/);
  }
  assert.equal(await safeApplyPath(root, 'new/nested/file.txt'), path.join(root, 'new', 'nested', 'file.txt'));
});

test('binary and invalid UTF-8 working files are refused without lossy decoding', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), Buffer.from([0x61, 0, 0x62]));
  await assert.rejects(buildApplyPlan(root, content('a\0b'), content('draft')), /binary or non-UTF-8/);
  await fs.writeFile(path.join(root, 'file.txt'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(buildApplyPlan(root, content('\ufffd\ufffd'), content('draft')), /binary or non-UTF-8/);
});

test('symlink ancestors and symlink leaves cannot redirect application', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Host does not permit creating directory symlinks'); return; }
    throw error;
  }
  await assert.rejects(safeApplyPath(root, 'escape/outside.txt'), /symbolic-link/);
  await assert.rejects(safeApplyPath(root, 'escape/new.txt'), /symbolic-link/);
  try { await fs.symlink(path.join(outside, 'outside.txt'), path.join(root, 'link.txt')); }
  catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
    throw error;
  }
  await assert.rejects(safeApplyPath(root, 'link.txt'), /symbolic-link/);
});

test('non-regular files and unsupported permission changes are refused', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'directory'));
  await assert.rejects(buildApplyPlan(root, content('', 'directory'), content('draft', 'directory')), /regular file/);
  await fs.writeFile(path.join(root, 'file.txt'), 'baseline');
  await assert.rejects(buildApplyPlan(root, content('baseline'), content('draft', 'file.txt', true, '100755')), /file-mode change/);
  await assert.rejects(buildApplyPlan(root, content('baseline', 'file.txt', true, '120000'), content('draft')), /only regular text files/);
  await assert.rejects(buildApplyPlan(root, content('', 'new.txt', false), content('draft', 'new.txt', true, '100755')), /executable file/);
});

test('executable baseline edits retain their mode on platforms exposing executable bits', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'baseline', { mode: 0o755 });
  assert.equal((await buildApplyPlan(root, content('baseline', 'file.txt', true, '100755'), content('draft', 'file.txt', true, '100755'))).kind, 'edit');
  await fs.chmod(path.join(root, 'file.txt'), 0o644);
  await assert.rejects(buildApplyPlan(root, content('baseline', 'file.txt', true, '100755'), content('draft', 'file.txt', true, '100755')), ApplyConflict);
});

test('real Git worktrees preflight independently and preserve both branches', async t => {
  const root = await fixture(t);
  const repository = path.join(root, 'repo');
  const other = path.join(root, 'topic-tree');
  await fs.mkdir(repository);
  const git = (args: string[], cwd = repository) => exec('git', args, { cwd });
  await git(['init', '-b', 'development']);
  await git(['config', 'user.name', 'BranchLens test']);
  await git(['config', 'user.email', 'branchlens@example.invalid']);
  await git(['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repository, 'file.txt'), 'baseline\n');
  await git(['add', 'file.txt']);
  await git(['commit', '-m', 'fixture']);
  await git(['worktree', 'add', '-b', 'topic', other]);
  const plan = await buildApplyPlan(other, content('baseline\n'), content('draft\n'));
  assert.equal(plan.source, path.join(await fs.realpath(other), 'file.txt'));
  assert.equal(plan.kind, 'edit');
  await fs.writeFile(path.join(other, 'file.txt'), 'local topic edit\n');
  await assert.rejects(buildApplyPlan(other, content('baseline\n'), content('draft\n')), ApplyConflict);
  assert.equal((await buildApplyPlan(repository, content('baseline\n'), content('draft\n'))).kind, 'edit');
  assert.equal((await git(['branch', '--show-current'])).stdout.trim(), 'development');
  assert.equal((await git(['branch', '--show-current'], other)).stdout.trim(), 'topic');
  assert.equal(await fs.readFile(path.join(repository, 'file.txt'), 'utf8'), 'baseline\n');
});
