import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { diffLines } from 'diff';

export interface Branch { name: string; remote: boolean; current: boolean }
export interface Snapshot { exists: boolean; text: string; binary: boolean; reason?: string; mode?: string }
export interface ChangedFile { status: 'A' | 'M' | 'D' | 'R'; oldPath: string; newPath: string; additions: number | null; deletions: number | null }
export interface ComparisonSession { id: string; root: string; leftRef: string; rightRef: string; leftSha: string; rightSha: string; leftTipSha: string; includeUpstream: boolean; files: ChangedFile[]; rightWorkingTree?: boolean }
export interface Worktree { path: string; branch: string; head: string }

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/** Git paths always use slash separators, even on Windows. Never normalize traversal away. */
export function safeRelativePath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Expected a safe repository-relative file path.');
  }
  return value;
}

function runGit(root: string, args: readonly string[], acceptedExitCodes: readonly number[] = [0]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['--literal-pathspecs', '-C', root, ...args], {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
      // Reading a promisor object must never silently start a fetch or hydrate a partial clone.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
    }, (error, stdout, stderr) => {
      if (error && !(typeof error.code === 'number' && acceptedExitCodes.includes(error.code))) reject(new Error(`Git ${args[0]} failed: ${stderr.toString('utf8').trim() || error.message}`));
      else resolve(stdout);
    });
  });
}

function textSnapshot(content: Buffer, mode: string): Snapshot {
  const unsupported = (reason: string): Snapshot => ({ exists: true, text: '', binary: true, mode, reason });
  if (content.length > MAX_SNAPSHOT_BYTES) return unsupported('File exceeds the 2 MiB text size limit.');
  if (content.includes(0)) return unsupported('Binary files are unsupported.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content); }
  catch { return unsupported('Files with invalid UTF-8 encoding are unsupported.'); }
  if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/.test(text)) return unsupported('Git LFS pointer files are unsupported.');
  const outsideCRLF = text.replace(/\r\n/g, '');
  if (outsideCRLF.includes('\r')) return unsupported('Standalone carriage return line endings are unsupported.');
  if (text.includes('\r\n') && outsideCRLF.includes('\n')) return unsupported('Mixed LF and CRLF line endings are unsupported.');
  return { exists: true, text, binary: false, mode };
}

function textStatistics(file: ChangedFile, left: Snapshot, right: Snapshot): void {
  if (left.binary || right.binary) { file.additions = null; file.deletions = null; return; }
  file.additions = 0;
  file.deletions = 0;
  for (const part of diffLines(left.text, right.text)) {
    if (part.added) file.additions += part.count ?? 0;
    if (part.removed) file.deletions += part.count ?? 0;
  }
}

function validateRef(ref: string): void {
  if (!ref || ref.includes('\0') || ref.startsWith('-')) throw new Error('Invalid Git reference. Choose a branch or commit.');
}

function changedFiles(raw: string): ChangedFile[] {
  const fields = raw.split('\0');
  const result: ChangedFile[] = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const rawStatus = fields[i++];
    const oldPath = fields[i++];
    const newPath = rawStatus.startsWith('R') ? fields[i++] : oldPath;
    if (!oldPath || !newPath) throw new Error('Git returned an incomplete file change.');
    const status = rawStatus[0] === 'T' ? 'M' : rawStatus[0];
    if (status !== 'A' && status !== 'M' && status !== 'D' && status !== 'R') {
      throw new Error(`Unsupported Git change status: ${rawStatus}`);
    }
    result.push({ status, oldPath, newPath, additions: null, deletions: null });
  }
  return result;
}

function addStatistics(files: ChangedFile[], raw: string): void {
  const records = raw.split('\0');
  const byPaths = new Map(files.map((file) => [`${file.oldPath}\0${file.newPath}`, file]));
  for (let i = 0; i < records.length && records[i];) {
    const record = records[i++];
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error('Git returned incomplete line statistics.');
    const added = record.slice(0, firstTab);
    const removed = record.slice(firstTab + 1, secondTab);
    const filename = record.slice(secondTab + 1);
    const oldPath = filename || records[i++];
    const newPath = filename || records[i++];
    const file = byPaths.get(`${oldPath}\0${newPath}`);
    if (!file) throw new Error('Git returned line statistics for an unknown file.');
    file.additions = added === '-' ? null : Number(added);
    file.deletions = removed === '-' ? null : Number(removed);
  }
}

export class GitRepository {
  readonly root: string;
  private readonly snapshots = new Map<string, Promise<Snapshot>>();

  constructor(root: string) { this.root = path.resolve(root); }

  async branches(): Promise<Branch[]> {
    const output = await runGit(this.root, ['for-each-ref', '--format=%(refname:short)%00%(HEAD)%00%(refname)%00%(symref)', 'refs/heads', 'refs/remotes']);
    return output.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const [name, head, ref, symbolic] = line.split('\0');
      if (symbolic) return [];
      return [{ name, current: head === '*', remote: ref.startsWith('refs/remotes/') }];
    });
  }

  async currentBranch(): Promise<string> {
    try { return (await runGit(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString('utf8').trim(); }
    catch { return `detached:${(await runGit(this.root, ['rev-parse', '--short', 'HEAD'])).toString('utf8').trim()}`; }
  }

  private async resolveCommit(ref: string): Promise<string> {
    validateRef(ref);
    try {
      const sha = (await runGit(this.root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString('utf8').trim();
      if (!OBJECT_ID.test(sha)) throw new Error('Not a commit object.');
      return sha;
    } catch (error) {
      throw new Error(`Cannot resolve Git reference ${JSON.stringify(ref)} to a commit: ${(error as Error).message}`);
    }
  }

  async compare(leftRef: string, rightRef: string, includeUpstream: boolean): Promise<ComparisonSession> {
    // Resolve branch names once. Both discovery and stats use this exact pair of immutable objects.
    const [leftTipSha, rightSha] = await Promise.all([this.resolveCommit(leftRef), this.resolveCommit(rightRef)]);
    let leftSha = leftTipSha;
    if (!includeUpstream) {
      try {
        leftSha = (await runGit(this.root, ['merge-base', leftTipSha, rightSha])).toString('utf8').trim();
        if (!OBJECT_ID.test(leftSha)) throw new Error('No common ancestor.');
      } catch (error) {
        throw new Error(`These references have no usable merge base (they may have unrelated histories). Enable Include upstream to compare their tips. ${(error as Error).message}`);
      }
    }
    const commonArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--ignore-submodules=none', '--no-relative'];
    const [names, stats] = await Promise.all([
      runGit(this.root, [...commonArgs, '--name-status', '-z', leftSha, rightSha, '--']),
      runGit(this.root, [...commonArgs, '--numstat', '-z', leftSha, rightSha, '--']),
    ]);
    const files = changedFiles(names.toString('utf8'));
    addStatistics(files, stats.toString('utf8'));
    return { id: randomUUID(), root: this.root, leftRef, rightRef, leftSha, rightSha, leftTipSha, includeUpstream, files };
  }

  async compareWorking(leftRef: string, includeUpstream: boolean, buffers: ReadonlyMap<string, string> = new Map()): Promise<ComparisonSession> {
    for (const filename of buffers.keys()) this.validateWorkingPath(filename);
    // Only the left endpoint is immutable. Disk contents are read lazily when a file opens.
    const [leftTipSha, rightSha] = await Promise.all([this.resolveCommit(leftRef), this.resolveCommit('HEAD')]);
    let rightRef: string;
    try { rightRef = (await runGit(this.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).toString('utf8').trim(); }
    catch { rightRef = `detached:${(await runGit(this.root, ['rev-parse', '--short', rightSha])).toString('utf8').trim()}`; }
    let leftSha = leftTipSha;
    if (!includeUpstream) {
      try {
        leftSha = (await runGit(this.root, ['merge-base', leftTipSha, rightSha])).toString('utf8').trim();
        if (!OBJECT_ID.test(leftSha)) throw new Error('No common ancestor.');
      } catch (error) {
        throw new Error(`These references have no usable merge base (they may have unrelated histories). Enable Include upstream to compare their tips. ${(error as Error).message}`);
      }
    }
    const commonArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '--ignore-submodules=none', '--no-relative'];
    const [names, stats, others] = await Promise.all([
      runGit(this.root, [...commonArgs, '--name-status', '-z', leftSha, '--']),
      runGit(this.root, [...commonArgs, '--numstat', '-z', leftSha, '--']),
      runGit(this.root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const files = changedFiles(names.toString('utf8'));
    addStatistics(files, stats.toString('utf8'));
    for (const filename of others.toString('utf8').split('\0').filter(Boolean)) {
      safeRelativePath(filename);
      if (buffers.has(filename)) continue;
      const existing = files.find(file => file.newPath === filename);
      if (existing) {
        // An index deletion can leave an untracked replacement at the same path.
        const [left, right] = await Promise.all([this.readFile(leftSha, filename), this.readWorkingFile(filename)]);
        if (!left.binary && !right.binary && left.exists === right.exists && left.text === right.text) files.splice(files.indexOf(existing), 1);
        else { existing.status = left.exists ? 'M' : 'A'; textStatistics(existing, left, right); }
        continue;
      }
      // Ask Git for counts without eagerly retaining untracked file contents in the extension.
      const raw = (await runGit(this.root, ['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--no-index', '--', '/dev/null', filename], [0, 1])).toString('utf8');
      const [added, removed] = raw.split('\t');
      files.push({ status: 'A', oldPath: filename, newPath: filename,
        additions: added === '-' ? null : Number(added || 0), deletions: removed === '-' ? null : Number(removed || 0) });
    }
    for (const [filename, text] of buffers) {
      let file = files.find(candidate => candidate.newPath === filename);
      const left = await this.readFile(leftSha, file?.oldPath ?? filename);
      const right = textSnapshot(Buffer.from(text, 'utf8'), left.mode === '100755' ? '100755' : '100644');
      if (!left.binary && !right.binary && left.exists && left.text === text && file?.status !== 'R') {
        if (file) files.splice(files.indexOf(file), 1);
        continue;
      }
      if (!file) {
        file = { status: left.exists ? 'M' : 'A', oldPath: filename, newPath: filename, additions: null, deletions: null };
        files.push(file);
      } else if (file.status !== 'R') file.status = left.exists ? 'M' : 'A';
      textStatistics(file, left, right);
    }
    const [currentSha, currentRef] = await Promise.all([this.resolveCommit('HEAD'), this.currentBranch()]);
    if (currentSha !== rightSha || currentRef !== rightRef) {
      throw new Error('The checkout branch or HEAD changed while discovering working files. Refresh the comparison to retry with the current checkout.');
    }
    return { id: randomUUID(), root: this.root, leftRef, rightRef, leftSha, rightSha, leftTipSha, includeUpstream, files, rightWorkingTree: true };
  }

  private validateWorkingPath(filename: string): void {
    safeRelativePath(filename);
    if (filename.includes(':') || filename.split('/').some(part => part.toLowerCase() === '.git' || /[. ]$/.test(part))) {
      throw new Error('Unsafe working-tree path or Git metadata path.');
    }
  }

  async readWorkingFile(filename: string): Promise<Snapshot> {
    this.validateWorkingPath(filename);
    const root = await realpath(this.root);
    let absolute = root;
    const components = filename.split('/');
    const unsupported = (reason: string, mode?: string): Snapshot => ({ exists: true, text: '', binary: true, mode, reason });
    const ancestors = components.map((_, index) => components.slice(0, index + 1).join('/'));
    const entries = (await runGit(this.root, ['ls-files', '--stage', '-z', '--', ...ancestors])).toString('utf8').split('\0');
    if (entries.some(entry => entry.startsWith('160000 ') && ancestors.includes(entry.slice(entry.indexOf('\t') + 1)))) {
      return unsupported('Submodules are unsupported.', '160000');
    }
    try {
      for (let i = 0; i < components.length; i++) {
        absolute = path.join(absolute, components[i]);
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) {
          if (i === components.length - 1) return unsupported('Symbolic links are unsupported.', '120000');
          throw new Error('Refusing symbolic-link ancestor in working-tree path.');
        }
        const resolved = await realpath(absolute);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path escapes the working tree.');
        if (i < components.length - 1 && !info.isDirectory()) throw new Error('Working-tree path parent is not a directory.');
        if (i === components.length - 1) {
          if (!info.isFile()) return unsupported('Only regular files are supported.');
          const mode = info.mode & 0o111 ? '100755' : '100644';
          if (info.size > MAX_SNAPSHOT_BYTES) return unsupported('File exceeds the 2 MiB text size limit.', mode);
          const handle = await open(absolute, 'r');
          try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new Error('Working file changed during snapshot read.');
            if (opened.size > MAX_SNAPSHOT_BYTES) return unsupported('File exceeds the 2 MiB text size limit.', mode);
            return textSnapshot(await handle.readFile(), mode);
          } finally { await handle.close(); }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, text: '', binary: false };
      throw error;
    }
    throw new Error('Expected a working-tree file path.');
  }

  async readFile(sha: string, filename: string): Promise<Snapshot> {
    safeRelativePath(filename);
    if (!OBJECT_ID.test(sha)) throw new Error('Snapshots require a resolved immutable Git commit SHA.');
    const key = `${sha}\0${filename}`;
    let pending = this.snapshots.get(key);
    if (!pending) {
      pending = this.loadSnapshot(sha, filename).then((snapshot) => Object.freeze(snapshot));
      this.snapshots.set(key, pending);
      // Failed reads are retryable; immutable successful objects remain cached.
      void pending.catch(() => { if (this.snapshots.get(key) === pending) this.snapshots.delete(key); });
    }
    return pending;
  }

  private async loadSnapshot(sha: string, filename: string): Promise<Snapshot> {
    const raw = (await runGit(this.root, ['ls-tree', '-z', '--full-tree', sha, '--', filename])).toString('utf8');
    if (!raw) return { exists: false, text: '', binary: false };
    const record = raw.slice(0, raw.indexOf('\0'));
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]*)$/.exec(record);
    if (!match || match[4] !== filename) throw new Error('Git returned an unexpected tree entry.');
    const [, mode, type, oid] = match;
    const unsupported = (reason: string): Snapshot => ({ exists: true, text: '', binary: true, mode, reason });
    if (mode === '120000') return unsupported('Symbolic links are unsupported.');
    if (mode === '160000') return unsupported('Submodules are unsupported.');
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) return unsupported(`Unsupported Git entry mode: ${mode}.`);
    const size = Number((await runGit(this.root, ['cat-file', '-s', oid])).toString('utf8').trim());
    if (!Number.isFinite(size) || size > MAX_SNAPSHOT_BYTES) return unsupported('File exceeds the 2 MiB text size limit.');
    const content = await runGit(this.root, ['cat-file', 'blob', oid]);
    return textSnapshot(content, mode);
  }

  async worktrees(): Promise<Worktree[]> {
    const raw = (await runGit(this.root, ['worktree', 'list', '--porcelain', '-z'])).toString('utf8');
    const result: Worktree[] = [];
    let current: Worktree | undefined;
    for (const field of raw.split('\0')) {
      if (field.startsWith('worktree ')) {
        if (current) result.push(current);
        current = { path: field.slice(9), branch: '', head: '' };
      } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5);
      else if (current && field.startsWith('branch ')) current.branch = field.slice(7).replace(/^refs\/heads\//, '');
    }
    if (current) result.push(current);
    return result;
  }

  async createWorktree(branch: string, destination: string, newBranch?: string): Promise<void> {
    validateRef(branch);
    if (!destination || destination.includes('\0')) throw new Error('A worktree destination path is required.');
    // Validate before mutation, and use -- to keep paths/ref names out of Git's option parser.
    await this.resolveCommit(branch);
    if (newBranch !== undefined) {
      validateRef(newBranch);
      await runGit(this.root, ['check-ref-format', '--branch', newBranch]);
    }
    await runGit(this.root, ['worktree', 'add', ...(newBranch ? ['-b', newBranch] : []), '--', path.resolve(destination), branch]);
  }

  static async discover(paths: string[]): Promise<GitRepository[]> {
    const repositories = new Map<string, GitRepository>();
    const visited = new Set<string>();
    const ignored = new Set(['.git', 'node_modules', 'vendor', 'dist', 'out', '.next', '.cache']);
    const queue: { directory: string; depth: number }[] = [];
    for (const candidate of paths.slice(0, 100)) {
      try {
        const info = await stat(candidate);
        queue.push({ directory: info.isDirectory() ? candidate : path.dirname(candidate), depth: 0 });
      } catch { /* Workspace folders can disappear while discovery is in progress. */ }
    }
    // Bounded breadth-first discovery finds nested repositories without following directory symlinks.
    let examined = 0;
    while (queue.length && examined < 250) {
      const entry = queue.shift()!;
      let directory: string;
      try { directory = await realpath(entry.directory); } catch { continue; }
      const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
      if (visited.has(key)) continue;
      visited.add(key);
      examined++;
      try {
        const found = (await runGit(directory, ['rev-parse', '--show-toplevel'])).toString('utf8').replace(/\r?\n$/, '');
        const root = await realpath(found);
        repositories.set(process.platform === 'win32' ? root.toLowerCase() : root, new GitRepository(root));
      } catch { /* A directory outside a repository may contain nested repositories. */ }
      if (entry.depth >= 4) continue;
      try {
        for (const child of await readdir(directory, { withFileTypes: true })) {
          if (child.isDirectory() && !child.isSymbolicLink() && !ignored.has(child.name)) {
            queue.push({ directory: path.join(directory, child.name), depth: entry.depth + 1 });
          }
        }
      } catch { /* Unreadable directories do not prevent other repositories being discovered. */ }
    }
    return [...repositories.values()];
  }
}
