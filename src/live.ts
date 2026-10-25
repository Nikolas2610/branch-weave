import * as path from 'node:path';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { GitRepository, ComparisonSession } from './git';
import type { DraftContent } from './draft';
import { safeApplyPath } from './applyPlan';
import { buildLivePlan, LiveConflict, verifyLiveBranch } from './livePlan';
export { LiveConflict } from './livePlan';

const key = (absolute: string): string => process.platform === 'win32' ? path.resolve(absolute).toLowerCase() : path.resolve(absolute);
const documentAt = (absolute: string): vscode.TextDocument | undefined => vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && key(doc.uri.fsPath) === key(absolute));
const readBuffer = (absolute: string) => { const doc = documentAt(absolute); return doc ? { text: doc.getText(), isDirty: doc.isDirty } : undefined; };

/** All actual file documents participate, including dirty documents in other editor groups. */
export function workingBufferContents(root: string): ReadonlyMap<string, string> {
  const buffers = new Map<string, string>();
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== 'file') continue;
    const relative = path.relative(root, document.uri.fsPath).split(path.sep).join('/');
    if (!relative || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\\') ||
        relative.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git' || /[. ]$/.test(part)) ||
        [...relative].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) continue;
    let absolute = path.resolve(root), unsafe = false;
    for (const component of relative.split('/')) {
      absolute = path.join(absolute, component);
      try { if (fs.lstatSync(absolute).isSymbolicLink()) { unsafe = true; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; unsafe = true; break; }
    }
    if (!unsafe) buffers.set(relative, document.getText());
  }
  return buffers;
}

function checkSession(repository: GitRepository, session: ComparisonSession): void {
  if (!session.rightWorkingTree || key(repository.root) !== key(session.root)) throw new Error('The right side is not this repository’s live working tree. Refresh the comparison.');
}

/** Workspace edits preserve native editor undo and never save the updated document. */
export async function writeWorkingFile(repository: GitRepository, session: ComparisonSession, before: DraftContent, after: DraftContent): Promise<void> {
  checkSession(repository, session);
  const options = { expectedBranch: session.rightRef, currentBranch: () => repository.currentBranch(), readBuffer };
  let plan = await buildLivePlan(repository.root, before, after, options);
  if (plan.kind === 'none') return;
  let document: vscode.TextDocument | undefined;
  if (before.exists) document = await vscode.workspace.openTextDocument(vscode.Uri.file(plan.source));
  const versions = new Map(vscode.workspace.textDocuments.map(doc => [doc.uri.toString(), doc.version]));
  plan = await buildLivePlan(repository.root, before, after, options);
  // No asynchronous work follows this guard before applyEdit is dispatched.
  if ((document && (document.isClosed || documentAt(plan.source) !== document)) ||
      vscode.workspace.textDocuments.some(doc => versions.get(doc.uri.toString()) !== doc.version)) {
    const current = documentAt(plan.source);
    throw new LiveConflict('An editor changed during the live edit. Refresh the comparison.', plan.source,
      { ...before, text: current?.getText() ?? before.text }, after);
  }
  const edit = new vscode.WorkspaceEdit();
  const source = vscode.Uri.file(plan.source), destination = vscode.Uri.file(plan.destination);
  const endings = plan.eol ? [vscode.TextEdit.setEndOfLine(plan.eol === 'CRLF' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)] : [];
  if (plan.kind === 'create') {
    edit.createFile(destination, { overwrite: false, ignoreIfExists: false });
    edit.set(destination, [vscode.TextEdit.insert(new vscode.Position(0, 0), plan.text), ...endings]);
  } else if (plan.kind === 'delete') edit.deleteFile(source, { recursive: false, ignoreIfNotExists: false });
  else if (plan.kind === 'edit' || plan.kind === 'rename') {
    if (!document) throw new Error('The working document is unavailable. Nothing was applied.');
    edit.set(source, [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), plan.text), ...endings]);
    if (plan.kind === 'rename') edit.renameFile(source, destination, { overwrite: false, ignoreIfExists: false });
  }
  if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the complete live edit. Inspect the working file and refresh.');
}

/** Uses the document’s normal VS Code save path, including its usual disk-conflict handling. */
export async function saveWorkingFile(repository: GitRepository, session: ComparisonSession, relative: string): Promise<boolean> {
  checkSession(repository, session);
  await verifyLiveBranch(session.rightRef, () => repository.currentBranch());
  const absolute = await safeApplyPath(repository.root, relative);
  const document = documentAt(absolute) ?? await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
  await safeApplyPath(repository.root, relative);
  await verifyLiveBranch(session.rightRef, () => repository.currentBranch());
  return document.save();
}
