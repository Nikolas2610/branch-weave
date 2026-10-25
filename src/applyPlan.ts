import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** An absent file and an existing, empty file are intentionally different. */
export interface ApplyContent {
  exists: boolean;
  text: string;
  path: string;
  mode?: string;
}

export interface BufferContent {
  text: string;
  isDirty: boolean;
}

export interface ApplyPlanOptions {
  /** Includes dirty documents, even when the file has not yet been saved. */
  readBuffer?: (absolutePath: string) => BufferContent | undefined;
}

export interface ApplyOperation {
  kind: 'create' | 'edit' | 'delete' | 'rename' | 'none';
  source: string;
  destination: string;
  text: string;
  /** VS Code normalizes inserted newlines unless the edit explicitly sets EOL. */
  eol?: 'LF' | 'CRLF';
}

export class ApplyConflict extends Error {
  constructor(
    message: string,
    readonly filePath: string,
    readonly actual: ApplyContent,
    readonly draft: ApplyContent,
  ) {
    super(message);
    this.name = 'ApplyConflict';
  }
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Check existing ancestors as well as the leaf: lexical containment alone is unsafe. */
export async function safeApplyPath(root: string, relativePath: string): Promise<string> {
  if (!relativePath || [...relativePath].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || relativePath.includes('\\') ||
      path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath) ||
      relativePath.split('/').some(part => part === '..' || part === '.' || part === '') ||
      relativePath.split('/').some(part => part.toLowerCase() === '.git' || /[. ]$/.test(part)) ||
      relativePath.includes(':')) {
    throw new Error(`Unsafe working-tree path: ${relativePath}`);
  }
  const absoluteRoot = await fs.realpath(root);
  const target = path.resolve(absoluteRoot, relativePath);
  if (!contained(absoluteRoot, target) || target === absoluteRoot) {
    throw new Error(`Path escapes the working tree: ${relativePath}`);
  }
  let current = absoluteRoot;
  for (const component of relativePath.split('/')) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic-link path: ${relativePath}`);
      const resolved = await fs.realpath(current);
      if (!contained(absoluteRoot, resolved)) throw new Error(`Path escapes the working tree: ${relativePath}`);
      if (path.relative(absoluteRoot, resolved).split(path.sep).some(part => part.toLowerCase() === '.git')) {
        throw new Error(`Refusing Git metadata path: ${relativePath}`);
      }
      if (current !== target && !stat.isDirectory()) throw new Error(`Parent is not a directory: ${relativePath}`);
      if (current === target && !stat.isFile()) throw new Error(`Target is not a regular file: ${relativePath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function checkMode(content: ApplyContent): void {
  if (content.exists && content.mode && !['100644', '100755'].includes(content.mode)) {
    throw new Error(`Cannot apply file mode ${content.mode}; only regular text files are supported.`);
  }
}

function draftEndOfLine(draft: ApplyContent): ApplyOperation['eol'] {
  if (!draft.exists) return undefined;
  const withoutCrLf = draft.text.replace(/\r\n/g, '');
  const hasCrLf = draft.text.includes('\r\n');
  const hasLf = withoutCrLf.includes('\n');
  if ((hasCrLf && hasLf) || withoutCrLf.includes('\r')) {
    throw new Error('Mixed or standalone-CR line endings cannot be applied exactly through VS Code. Export the draft as a patch to preserve its line endings. Nothing was applied.');
  }
  return hasCrLf ? 'CRLF' : hasLf ? 'LF' : undefined;
}

async function diskContent(absolutePath: string, relativePath: string): Promise<ApplyContent> {
  try {
    const stat = await fs.lstat(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-regular file: ${relativePath}`);
    const bytes = await fs.readFile(absolutePath);
    const text = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error(`Refusing binary or non-UTF-8 working file: ${relativePath}`);
    }
    return {
      exists: true, text, path: relativePath,
      mode: stat.mode & 0o111 ? '100755' : '100644',
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '', path: relativePath };
    throw error;
  }
}

/**
 * Read-only preflight. The adapter re-runs this immediately before WorkspaceEdit.
 * Changes are never saved, stashed, checked out, or committed by this layer.
 */
export async function buildApplyPlan(
  root: string, original: ApplyContent, draft: ApplyContent, options: ApplyPlanOptions = {},
): Promise<ApplyOperation> {
  checkMode(original);
  checkMode(draft);
  const eol = draftEndOfLine(draft);
  if (original.exists && draft.exists && (original.mode ?? '100644') !== (draft.mode ?? '100644')) {
    throw new Error('Applying a file-mode change is unsupported; preserve the original mode.');
  }
  if (!original.exists && draft.exists && draft.mode === '100755') {
    throw new Error('Creating an executable file requires an explicit permission change outside BranchLens.');
  }
  const source = await safeApplyPath(root, original.path);
  const destination = await safeApplyPath(root, draft.path);
  // Case-only renames are ambiguous on case-insensitive filesystems. Refuse rather
  // than silently treating an existing destination as safe to overwrite.
  if (source !== destination && process.platform === 'win32' && source.toLowerCase() === destination.toLowerCase()) {
    throw new Error('Case-only renames require an explicit filesystem rename outside BranchLens.');
  }
  const actual = await diskContent(source, original.path);
  const buffer = options.readBuffer?.(source);
  const current = buffer ? { ...actual, exists: true, text: buffer.text } : actual;
  const modeMismatch = process.platform !== 'win32' && original.exists && original.mode && original.mode !== actual.mode;
  if (actual.exists !== original.exists || (original.exists && actual.text !== original.text) || modeMismatch ||
      (buffer && (!original.exists || buffer.text !== original.text))) {
    throw new ApplyConflict(`Working content differs from the comparison baseline: ${original.path}`, source, current, draft);
  }
  if (draft.exists && source !== destination) {
    const targetContent = await diskContent(destination, draft.path);
    const targetBuffer = options.readBuffer?.(destination);
    if (targetContent.exists || targetBuffer) {
      throw new ApplyConflict(`Rename destination already exists: ${draft.path}`, destination,
        targetBuffer ? { ...targetContent, exists: true, text: targetBuffer.text } : targetContent, draft);
    }
  }
  let kind: ApplyOperation['kind'];
  if (!original.exists && !draft.exists) kind = 'none';
  else if (!original.exists) kind = 'create';
  else if (!draft.exists) kind = 'delete';
  else if (source !== destination) kind = 'rename';
  else kind = original.text === draft.text ? 'none' : 'edit';
  return { kind, source, destination, text: draft.text, eol };
}
