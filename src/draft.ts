import { diffArrays } from 'diff';

export type Side = 'left' | 'right';
export interface DraftContent { exists: boolean; text: string; path: string; mode?: string }
export interface Hunk { leftStart: number; leftCount: number; rightStart: number; rightCount: number }
type Snapshot = { left: DraftContent; right: DraftContent };

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY = 50;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const opposite = (side: Side): Side => side === 'left' ? 'right' : 'left';
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const copy = (content: DraftContent): DraftContent => ({ ...content });
const snapshot = (value: Snapshot): Snapshot => ({ left: copy(value.left), right: copy(value.right) });
const same = (a: DraftContent, b: DraftContent): boolean => a.exists === b.exists && a.text === b.text && a.path === b.path && a.mode === b.mode;
const bytes = (value: Snapshot): number => value.left.text.length * 2 + value.right.text.length * 2;

function validate(content: DraftContent): DraftContent {
  if (!content || typeof content.exists !== 'boolean' || typeof content.text !== 'string' || typeof content.path !== 'string') {
    throw new Error('Invalid draft content.');
  }
  if (!content.path || content.path.includes('\0') || /^(?:[/\\]|[A-Za-z]:)/.test(content.path) || content.path.split(/[/\\]/).includes('..')) {
    throw new Error('Draft paths must be safe repository-relative paths.');
  }
  if (Buffer.byteLength(content.text, 'utf8') > MAX_BYTES) throw new Error('Draft exceeds the 2 MB text limit.');
  if (content.mode !== undefined && !/^(?:100644|100755|120000)$/.test(content.mode)) throw new Error('Unsupported draft file mode.');
  if (!content.exists && content.text !== '') throw new Error('A missing file cannot contain text.');
  return copy(content);
}

/** Exact line tokens retain their original terminators, including an unterminated final line. */
function calculateHunks(left: string[], right: string[]): Hunk[] {
  const changes = diffArrays(left, right, { maxEditLength: 5000, timeout: 250 });
  if (!changes) {
    // Retain useful boundary context even for a comparison that exhausts the diff budget.
    let start = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    let leftEnd = left.length, rightEnd = right.length;
    while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; }
    return leftEnd === start && rightEnd === start ? [] : [{ leftStart: start, leftCount: leftEnd - start, rightStart: start, rightCount: rightEnd - start }];
  }
  const result: Hunk[] = [];
  let leftOffset = 0, rightOffset = 0;
  let pending: Hunk | undefined;
  for (const change of changes) {
    const count = change.value.length;
    if (!change.added && !change.removed) {
      if (pending) { result.push(pending); pending = undefined; }
      leftOffset += count;
      rightOffset += count;
    } else {
      pending ??= { leftStart: leftOffset, leftCount: 0, rightStart: rightOffset, rightCount: 0 };
      if (change.removed) { pending.leftCount += count; leftOffset += count; }
      else { pending.rightCount += count; rightOffset += count; }
    }
  }
  if (pending) result.push(pending);
  return result;
}

/** Git's C-style quoted paths use byte escapes for non-ASCII names. */
function quotePath(path: string): string {
  if (/^[\x21-\x7e]+$/.test(path) && !/["\\]/.test(path)) return path;
  return '"' + [...Buffer.from(path, 'utf8')].map(byte => {
    if (byte === 34) return '\\"';
    if (byte === 92) return '\\\\';
    return byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '\\' + byte.toString(8).padStart(3, '0');
  }).join('') + '"';
}

function patchLines(text: string, prefix: string): string {
  return lines(text).map(line => prefix + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n')).join('');
}

export class DraftPair {
  readonly original: Snapshot;
  private value: Snapshot;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private revision = 0;
  private cachedHunks?: { version: number; hunks: Hunk[] };

  constructor(left: DraftContent, right: DraftContent) {
    this.original = Object.freeze({ left: Object.freeze(validate(left)), right: Object.freeze(validate(right)) });
    this.value = snapshot(this.original);
  }

  get current(): Snapshot { return snapshot(this.value); }
  get version(): number { return this.revision; }

  hunks(): Hunk[] {
    if (this.cachedHunks?.version !== this.version) {
      const hunks = calculateHunks(lines(this.value.left.text), lines(this.value.right.text));
      if (!hunks.length && this.value.left.exists !== this.value.right.exists) {
        hunks.push({ leftStart: 0, leftCount: 0, rightStart: 0, rightCount: 0 });
      }
      this.cachedHunks = { version: this.version, hunks };
    }
    return this.cachedHunks.hunks.map(hunk => ({ ...hunk }));
  }

  dirty(side?: Side): boolean {
    return side ? !same(this.original[side], this.value[side]) : this.dirty('left') || this.dirty('right');
  }

  transferHunk(from: Side, hunkIndex: number, expectedVersion: number): void {
    this.checkVersion(expectedVersion);
    if (!Number.isInteger(hunkIndex)) throw new Error('Invalid hunk selection.');
    const hunk = this.hunks()[hunkIndex];
    if (!hunk) throw new Error('The selected hunk no longer exists.');
    const to = opposite(from);
    const source = this.value[from], target = this.value[to];
    if (source.exists !== target.exists) {
      // An existence difference always describes the whole file, even when it is empty.
      this.setContent(to, { ...source, path: target.path }, expectedVersion);
      return;
    }
    const sourceLines = lines(source.text), targetLines = lines(target.text);
    const sourceStart = from === 'left' ? hunk.leftStart : hunk.rightStart;
    const sourceCount = from === 'left' ? hunk.leftCount : hunk.rightCount;
    const targetStart = to === 'left' ? hunk.leftStart : hunk.rightStart;
    const targetCount = to === 'left' ? hunk.leftCount : hunk.rightCount;
    const text = [...targetLines.slice(0, targetStart), ...sourceLines.slice(sourceStart, sourceStart + sourceCount), ...targetLines.slice(targetStart + targetCount)].join('');
    this.setText(to, text, expectedVersion);
  }

  transferLine(from: Side, line: number, expectedVersion: number): void {
    this.checkVersion(expectedVersion);
    const sourceLines = lines(this.value[from].text);
    if (!Number.isInteger(line) || line < 0 || line >= sourceLines.length) throw new Error('No source line is selected. Use the whole hunk to transfer a deletion.');
    const hunk = this.hunks().find(candidate => {
      const start = from === 'left' ? candidate.leftStart : candidate.rightStart;
      const count = from === 'left' ? candidate.leftCount : candidate.rightCount;
      return line >= start && line < start + count;
    });
    if (!hunk) throw new Error('The selected line is unchanged. Select a changed line or a whole hunk.');
    const sourceStart = from === 'left' ? hunk.leftStart : hunk.rightStart;
    const sourceCount = from === 'left' ? hunk.leftCount : hunk.rightCount;
    const targetStart = from === 'left' ? hunk.rightStart : hunk.leftStart;
    const targetCount = from === 'left' ? hunk.rightCount : hunk.leftCount;
    if (targetCount !== 0 && sourceCount !== targetCount) throw new Error('This line mapping is ambiguous. Transfer the whole hunk.');
    const to = opposite(from), target = this.value[to];
    const targetLines = lines(target.text);
    const index = targetStart + (targetCount === 0 ? 0 : line - sourceStart);
    const text = [...targetLines.slice(0, index), sourceLines[line], ...targetLines.slice(index + (targetCount === 0 ? 0 : 1))].join('');
    this.setContent(to, { ...target, exists: true, text }, expectedVersion);
  }

  setText(side: Side, text: string, expectedVersion: number): void {
    this.setContent(side, { ...this.value[side], exists: true, text }, expectedVersion);
  }

  setContent(side: Side, content: DraftContent, expectedVersion = this.version): void {
    this.checkVersion(expectedVersion);
    const next = validate(content);
    if (same(this.value[side], next)) return;
    this.undoStack.push(snapshot(this.value));
    this.trimHistory(this.undoStack);
    this.redoStack = [];
    this.value = { ...this.value, [side]: next };
    this.revision++;
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(snapshot(this.value));
    this.value = previous;
    this.revision++;
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(snapshot(this.value));
    this.value = next;
    this.revision++;
  }

  reset(side: Side): void { this.setContent(side, this.original[side]); }

  patch(side: Side): string {
    if (!this.dirty(side)) return '';
    const before = this.original[side], after = this.value[side];
    if (!before.exists && !after.exists) return '';
    const oldPath = before.exists ? before.path : after.path;
    const newPath = after.exists ? after.path : before.path;
    let result = `diff --git ${quotePath('a/' + oldPath)} ${quotePath('b/' + newPath)}\n`;
    const beforeMode = before.mode ?? '100644', afterMode = after.mode ?? '100644';
    if (!before.exists) result += `new file mode ${afterMode}\n`;
    else if (!after.exists) result += `deleted file mode ${beforeMode}\n`;
    else {
      if (beforeMode !== afterMode) result += `old mode ${beforeMode}\nnew mode ${afterMode}\n`;
      if (oldPath !== newPath) result += `${before.text === after.text ? 'similarity index 100%\n' : ''}rename from ${quotePath(oldPath)}\nrename to ${quotePath(newPath)}\n`;
    }
    if (before.text !== after.text) {
      const oldLines = lines(before.text).length, newLines = lines(after.text).length;
      result += `--- ${before.exists ? quotePath('a/' + oldPath) : '/dev/null'}\n+++ ${after.exists ? quotePath('b/' + newPath) : '/dev/null'}\n`;
      result += `@@ -${oldLines ? 1 : 0},${oldLines} +${newLines ? 1 : 0},${newLines} @@\n`;
      result += patchLines(before.text, '-') + patchLines(after.text, '+');
    }
    return result;
  }

  serialize(): string {
    return JSON.stringify({ schema: 1, original: this.original, current: this.value, version: this.version, undo: this.undoStack, redo: this.redoStack });
  }

  static restore(serialized: string): DraftPair {
    const data = JSON.parse(serialized) as { schema: number; original: Snapshot; current: Snapshot; version: number; undo: Snapshot[]; redo: Snapshot[] };
    if (data.schema !== 1 || !Number.isSafeInteger(data.version) || data.version < 0 || !Array.isArray(data.undo) || !Array.isArray(data.redo)) throw new Error('Invalid saved draft.');
    const pair = new DraftPair(data.original.left, data.original.right);
    const validated = (value: Snapshot): Snapshot => ({ left: validate(value.left), right: validate(value.right) });
    pair.value = validated(data.current);
    pair.undoStack = data.undo.slice(-MAX_HISTORY).map(validated);
    pair.redoStack = data.redo.slice(-MAX_HISTORY).map(validated);
    pair.trimHistory(pair.undoStack);
    pair.trimHistory(pair.redoStack);
    pair.revision = data.version;
    return pair;
  }

  private checkVersion(expectedVersion: number): void {
    if (expectedVersion !== this.version) throw new Error('The draft version is stale. Select the line or hunk again.');
  }

  private trimHistory(history: Snapshot[]): void {
    let total = history.reduce((sum, value) => sum + bytes(value), 0);
    while (history.length > MAX_HISTORY || (history.length > 1 && total > MAX_HISTORY_BYTES)) total -= bytes(history.shift()!);
  }
}
