import * as fs from 'node:fs/promises';
import { safeApplyPath, type ApplyOperation, type BufferContent } from './applyPlan';
import type { DraftContent } from './draft';

export class LiveConflict extends Error {
  constructor(message: string, readonly filePath: string, readonly actual: DraftContent, readonly draft: DraftContent) {
    super(message);
    this.name = 'LiveConflict';
  }
}

export interface LivePlanOptions {
  expectedBranch: string;
  currentBranch: () => Promise<string>;
  readBuffer?: (absolutePath: string) => BufferContent | undefined;
}

export function normalizedWorkingBranch(branch: string): string {
  return branch.startsWith('detached:') ? 'HEAD' : branch;
}

export async function verifyLiveBranch(expected: string, currentBranch: () => Promise<string>): Promise<void> {
  const actual = await currentBranch();
  // compareWorking freezes a detached label with its SHA; preserve that identity.
  const matches = expected.startsWith('detached:') ? actual === expected : normalizedWorkingBranch(actual) === expected;
  if (!matches) {
    throw new Error(`The checkout changed branches. Expected ${expected}; nothing was applied. Refresh the comparison.`);
  }
}

async function readDisk(absolute: string, relative: string): Promise<DraftContent> {
  try {
    const info = await fs.lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Refusing non-regular working file: ${relative}`);
    if (info.size > 2 * 1024 * 1024) throw new Error('Working file exceeds the 2 MiB text limit.');
    const bytes = await fs.readFile(absolute), text = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`Refusing binary or non-UTF-8 working file: ${relative}`);
    return { exists: true, path: relative, text, mode: info.mode & 0o111 ? '100755' : '100644' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '', path: relative };
    throw error;
  }
}

function checkContent(content: DraftContent): void {
  if (!content.exists && content.text) throw new Error('A missing working file cannot contain text.');
  if (content.exists && content.mode && !['100644', '100755'].includes(content.mode)) throw new Error('Only regular text file modes are supported.');
  if (content.text.includes('\0') || Buffer.byteLength(content.text, 'utf8') > 2 * 1024 * 1024) throw new Error('Only text files up to 2 MiB are supported.');
  const withoutCrLf = content.text.replace(/\r\n/g, '');
  if (withoutCrLf.includes('\r') || (content.text.includes('\r\n') && withoutCrLf.includes('\n'))) {
    throw new Error('Mixed or standalone-CR line endings cannot be represented exactly through VS Code. Export a patch instead.');
  }
}

/** Read-only plan. A live editor buffer is the baseline, even when its disk file differs. */
export async function buildLivePlan(root: string, before: DraftContent, after: DraftContent, options: LivePlanOptions): Promise<ApplyOperation> {
  checkContent(before); checkContent(after);
  if (before.exists && after.exists && (before.mode ?? '100644') !== (after.mode ?? '100644')) throw new Error('Changing a file mode through the editor is unsupported.');
  if (!before.exists && after.exists && after.mode === '100755') throw new Error('Creating an executable file mode through the editor is unsupported.');
  await verifyLiveBranch(options.expectedBranch, options.currentBranch);
  const source = await safeApplyPath(root, before.path), destination = await safeApplyPath(root, after.path);
  if (source !== destination && process.platform === 'win32' && source.toLowerCase() === destination.toLowerCase()) throw new Error('Case-only renames require an explicit filesystem rename.');
  const disk = await readDisk(source, before.path);
  const targetDisk = after.exists && source !== destination ? await readDisk(destination, after.path) : undefined;
  await verifyLiveBranch(options.expectedBranch, options.currentBranch);
  const buffer = options.readBuffer?.(source);
  const actual = buffer ? { ...disk, exists: true, text: buffer.text } : disk;
  const modeMismatch = process.platform !== 'win32' && disk.exists && before.exists && before.mode && disk.mode !== before.mode;
  // VS Code omits an encoding BOM from getText(). Refuse rather than silently losing it.
  const strippedBom = buffer && disk.text.startsWith('\ufeff') && !buffer.text.startsWith('\ufeff');
  if (actual.exists !== before.exists || actual.text !== before.text || actual.path !== before.path || modeMismatch || strippedBom) {
    throw new LiveConflict(`Working content changed: ${before.path}`, source, actual, after);
  }
  if (targetDisk) {
    const targetBuffer = options.readBuffer?.(destination);
    if (targetDisk.exists || targetBuffer) throw new LiveConflict(`Destination already exists: ${after.path}`, destination,
      targetBuffer ? { ...targetDisk, exists: true, text: targetBuffer.text } : targetDisk, after);
  }
  const kind: ApplyOperation['kind'] = !before.exists && !after.exists ? 'none' : !before.exists ? 'create' : !after.exists ? 'delete' :
    source !== destination ? 'rename' : before.text !== after.text ? 'edit' : 'none';
  if ((kind === 'delete' || kind === 'rename') && !disk.exists) throw new Error('Save the new source document before renaming or deleting it.');
  const eol = after.text.includes('\r\n') ? 'CRLF' : after.text.includes('\n') ? 'LF' : undefined;
  return { kind, source, destination, text: after.text, eol };
}
