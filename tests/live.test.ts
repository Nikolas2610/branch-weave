import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { buildLivePlan, LiveConflict } from '../src/livePlan';
import type { DraftContent } from '../src/draft';

const content = (text = '', name = 'file.txt', exists = true, mode = '100644'): DraftContent => ({ text, path: name, exists, mode });
const branch = { expectedBranch: 'topic', currentBranch: async () => 'topic' };
async function fixture(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branchlens-live-'));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return root;
}

test('live editing accepts the current unsaved buffer as its baseline without saving', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'disk');
  const plan = await buildLivePlan(root, content('unsaved'), content('updated\r\n'), {
    ...branch, readBuffer: () => ({ text: 'unsaved', isDirty: true }),
  });
  assert.equal(plan.kind, 'edit');
  assert.equal(plan.eol, 'CRLF');
  assert.equal(plan.text, 'updated\r\n');
  assert.equal(await fs.readFile(path.join(root, 'file.txt'), 'utf8'), 'disk');
});

test('an externally changed buffer or disk is retained in a reconciliation conflict', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'external');
  for (const readBuffer of [undefined, () => ({ text: 'outside buffer', isDirty: true })]) {
    await assert.rejects(buildLivePlan(root, content('baseline'), content('proposal'), { ...branch, readBuffer }), error => {
      assert.ok(error instanceof LiveConflict);
      assert.equal(error.actual.text, readBuffer ? 'outside buffer' : 'external');
      assert.equal(error.draft.text, 'proposal');
      return true;
    });
  }
});

test('branch identity is verified on every plan including detached HEAD', async t => {
  const root = await fixture(t);
  await assert.rejects(buildLivePlan(root, content('', 'file.txt', false), content('new'), { ...branch, currentBranch: async () => 'other' }), /checkout changed/);
  assert.equal((await buildLivePlan(root, content('', 'file.txt', false), content('new'), {
    expectedBranch: 'HEAD', currentBranch: async () => 'detached:abc123',
  })).kind, 'create');
  assert.equal((await buildLivePlan(root, content('', 'file.txt', false), content('new'), {
    expectedBranch: 'detached:abc123', currentBranch: async () => 'detached:abc123',
  })).kind, 'create');
  await assert.rejects(buildLivePlan(root, content('', 'file.txt', false), content('new'), {
    expectedBranch: 'detached:abc123', currentBranch: async () => 'detached:def456',
  }), /checkout changed/);
  let checks = 0;
  await assert.rejects(buildLivePlan(root, content('', 'file.txt', false), content('new'), {
    expectedBranch: 'topic', currentBranch: async () => ++checks === 1 ? 'topic' : 'other',
  }), /checkout changed/);
});

test('create, delete, rename and no-op retain exact existence and path semantics', async t => {
  const root = await fixture(t);
  assert.equal((await buildLivePlan(root, content('', 'new.txt', false), content('', 'new.txt'), branch)).kind, 'create');
  await fs.writeFile(path.join(root, 'file.txt'), 'old');
  assert.equal((await buildLivePlan(root, content('old'), content('', 'file.txt', false), branch)).kind, 'delete');
  assert.equal((await buildLivePlan(root, content('old'), content('old', 'renamed.txt'), branch)).kind, 'rename');
  assert.equal((await buildLivePlan(root, content('old'), content('old'), branch)).kind, 'none');
  await assert.rejects(buildLivePlan(root, content('', 'file.txt', false), content('replacement'), branch), LiveConflict);
});

test('rename destinations and unsaved new documents cannot be overwritten', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old');
  const after = content('draft', 'new.txt');
  await fs.writeFile(path.join(root, 'new.txt'), 'destination');
  await assert.rejects(buildLivePlan(root, content('old'), after, branch), LiveConflict);
  await fs.unlink(path.join(root, 'new.txt'));
  await assert.rejects(buildLivePlan(root, content('old'), after, { ...branch,
    readBuffer: absolute => path.basename(absolute) === 'new.txt' ? { text: '', isDirty: true } : undefined,
  }), LiveConflict);
  await assert.rejects(buildLivePlan(root, content('', 'new.txt', false), after, { ...branch,
    readBuffer: () => ({ text: '', isDirty: true }),
  }), LiveConflict);
});

test('mixed endings, unsupported modes, and editor-stripped BOM are refused', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\n');
  for (const text of ['a\r\nb\n', 'a\rb']) await assert.rejects(buildLivePlan(root, content('old\n'), content(text), branch), /line endings/);
  await assert.rejects(buildLivePlan(root, content('old\n'), content('next', 'file.txt', true, '100755'), branch), /mode/);
  await assert.rejects(buildLivePlan(root, content('old\n', 'file.txt', true, '120000'), content('next'), branch), /regular/);
  await fs.writeFile(path.join(root, 'file.txt'), '\ufeffold\n');
  await assert.rejects(buildLivePlan(root, content('old\n'), content('next'), { ...branch,
    readBuffer: () => ({ text: 'old\n', isDirty: false }),
  }), LiveConflict);
});

test('unsafe paths and symbolic-link ancestors cannot redirect live editing', async t => {
  const root = await fixture(t);
  for (const name of ['../outside', '.git/config', 'a/.GIT/config', 'a:stream', 'a//b', 'a\\b', '/absolute']) {
    await assert.rejects(buildLivePlan(root, content('', name, false), content('new', name), branch), /Unsafe|escapes/);
  }
  const outside = await fixture(t);
  try { await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Symlinks unavailable'); return; } throw error; }
  await assert.rejects(buildLivePlan(root, content('', 'escape/new.txt', false), content('new', 'escape/new.txt'), branch), /symbolic-link/);
});

test('uniform LF and unterminated text retain exact newline representation', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'file.txt'), 'old\r\n');
  const lf = await buildLivePlan(root, content('old\r\n'), content('a\nb\n'), branch);
  assert.equal(lf.eol, 'LF'); assert.equal(lf.text, 'a\nb\n');
  const none = await buildLivePlan(root, content('old\r\n'), content('unterminated'), branch);
  assert.equal(none.eol, undefined); assert.equal(none.text, 'unterminated');
});
