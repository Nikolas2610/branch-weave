import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DraftPair, type DraftContent } from '../src/draft';

const file = (text: string, path = 'sample.txt', exists = true): DraftContent => ({ exists, text, path });

test('hunk transfers copy unequal replacements in both directions and keep the source', () => {
  const pair = new DraftPair(file('start\none\ntwo\nend\n'), file('start\nthree\nend\n'));
  assert.deepEqual(pair.hunks(), [{ leftStart: 1, leftCount: 2, rightStart: 1, rightCount: 1 }]);
  pair.transferHunk('left', 0, pair.version);
  assert.equal(pair.current.right.text, 'start\none\ntwo\nend\n');
  assert.equal(pair.current.left.text, 'start\none\ntwo\nend\n');
  pair.undo();
  pair.transferHunk('right', 0, pair.version);
  assert.equal(pair.current.left.text, 'start\nthree\nend\n');
});

test('line transfers map equal replacements and reject ambiguous unequal replacements', () => {
  const pair = new DraftPair(file('a\nb\nc\nz\n'), file('a\nx\ny\nz\n'));
  pair.transferLine('right', 2, pair.version);
  assert.equal(pair.current.left.text, 'a\nb\ny\nz\n');
  const unequal = new DraftPair(file('a\nb\nc\nz\n'), file('a\nx\nz\n'));
  assert.throws(() => unequal.transferLine('left', 1, unequal.version), /ambiguous|whole hunk/i);
  assert.equal(unequal.dirty(), false);
});

test('single inserted lines copy at the insertion boundary and deletion requires a hunk', () => {
  const pair = new DraftPair(file('one\ntwo\ntail\n'), file('tail\n'));
  pair.transferLine('left', 1, pair.version);
  assert.equal(pair.current.right.text, 'two\ntail\n');
  const deletion = new DraftPair(file('a\n'), file('a\nextra\n'));
  assert.throws(() => deletion.transferLine('left', 1, deletion.version), /line|hunk/i);
  deletion.transferHunk('left', 0, deletion.version);
  assert.equal(deletion.current.right.text, 'a\n');
});

test('start, end, CRLF, LF, and missing final newline survive transfers exactly', () => {
  for (const [left, right] of [
    ['first\r\nlast', 'last'], ['first\nlast\n', 'first\n'],
    ['same\r\n', 'same\n'], ['same', 'same\n'], ['', 'x'],
  ]) {
    const pair = new DraftPair(file(left), file(right));
    while (pair.hunks().length) pair.transferHunk('left', 0, pair.version);
    assert.equal(pair.current.right.text, left);
  }
});

test('empty and missing files remain distinct and whole-file transfers copy existence', () => {
  const pair = new DraftPair(file('', 'target.txt', false), file('', 'source.txt'));
  assert.equal(pair.hunks().length, 1);
  pair.transferHunk('right', 0, pair.version);
  assert.deepEqual(pair.current.left, file('', 'target.txt'));
  pair.undo();
  pair.transferHunk('left', 0, pair.version);
  assert.deepEqual(pair.current.right, file('', 'source.txt', false));
  const created = new DraftPair(file('', 'sample.txt', false), file('new\n'));
  created.transferHunk('right', 0, created.version);
  assert.equal(created.current.left.exists, true);
  created.undo();
  created.transferHunk('left', 0, created.version);
  assert.equal(created.current.right.exists, false);
});

test('undo, redo, edits, reset and serialization preserve dirty state and invalidate stale commands', () => {
  const pair = new DraftPair(file('before'), file('other'));
  const initialVersion = pair.version;
  pair.setText('left', 'after', initialVersion);
  assert.equal(pair.dirty('left'), true);
  assert.equal(pair.dirty('right'), false);
  assert.throws(() => pair.setText('left', 'stale', initialVersion), /stale|version/i);
  pair.undo();
  assert.equal(pair.dirty(), false);
  assert.ok(pair.version > initialVersion + 1);
  pair.redo();
  assert.equal(pair.current.left.text, 'after');
  const restored = DraftPair.restore(pair.serialize());
  assert.equal(restored.current.left.text, 'after');
  assert.equal(restored.original.left.text, 'before');
  restored.reset('left');
  assert.equal(restored.dirty(), false);
  restored.undo();
  assert.equal(restored.current.left.text, 'after');
});

test('draft snapshots do not alias caller-owned content and no-op edits do not create undo entries', () => {
  const source = file('before');
  const pair = new DraftPair(source, file('right'));
  source.text = 'mutated';
  assert.equal(pair.original.left.text, 'before');
  pair.setText('left', 'after', pair.version);
  pair.setText('left', 'after', pair.version);
  pair.undo();
  assert.equal(pair.current.left.text, 'before');
});

test('patch paths quote Git filenames containing tabs and newlines without injecting headers', () => {
  const pair = new DraftPair(file('before\n', 'odd\tname\n.txt'), file('other\n'));
  pair.setText('left', 'after\n', pair.version);
  assert.equal(pair.patch('left').split('\n')[0], 'diff --git "a/odd\\011name\\012.txt" "b/odd\\011name\\012.txt"');
  assert.throws(() => new DraftPair(file('', '../outside.txt'), file('')), /path/i);
});

test('patches apply with git for edits, creation, deletion, empty files, and renames', () => {
  const examples: [DraftContent, DraftContent][] = [
    [file('before\r\nlast'), file('after\r\nlast\r\n')],
    [file('', 'new.txt', false), file('new\n', 'new.txt')],
    [file('old', 'old.txt'), file('', 'old.txt', false)],
    [file('', 'empty.txt', false), file('', 'empty.txt')],
    [file('', 'empty.txt'), file('', 'empty.txt', false)],
    [file('same\n', 'old name.txt'), file('same\n', 'new name.txt')],
    [file('before\n', 'old.txt'), file('after\n', 'new.txt')],
    [file('before\n', 'Καλημέρα.txt'), file('after\n', 'Καλημέρα.txt')],
  ];
  for (const [before, after] of examples) {
    const root = mkdtempSync(join(tmpdir(), 'branchlens-patch-'));
    try {
      if (before.exists) writeFileSync(join(root, before.path), before.text);
      const pair = new DraftPair(before, file('irrelevant'));
      pair.setContent('left', after, pair.version);
      const patch = pair.patch('left');
      assert.match(patch, /^diff --git /);
      execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'], { cwd: root, input: patch });
      if (after.exists) assert.equal(readFileSync(join(root, after.path), 'utf8'), after.text);
      else assert.throws(() => readFileSync(join(root, before.path)));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  assert.equal(new DraftPair(file('same'), file('same')).patch('left'), '');
});
