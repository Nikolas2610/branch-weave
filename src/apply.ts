import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';
import { GitRepository, ComparisonSession, Worktree } from './git';
import { DraftPair, Side } from './draft';
import { ApplyConflict, ApplyContent, buildApplyPlan } from './applyPlan';

interface Target { root: string; branch: string }
interface TargetChoice extends vscode.QuickPickItem { target?: Target; create?: boolean }

const previews = new Map<string, string>();
let previewProvider: vscode.Disposable | undefined;

export async function showConflict(conflict: ApplyConflict): Promise<void> {
  if (!previewProvider) {
    previewProvider = vscode.workspace.registerTextDocumentContentProvider('branchlens-reconcile', {
      provideTextDocumentContent: uri => previews.get(uri.toString()) ?? '',
    });
  }
  const key = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const name = path.basename(conflict.filePath);
  const working = vscode.Uri.from({ scheme: 'branchlens-reconcile', path: `/${key}/working/${name}` });
  const draft = vscode.Uri.from({ scheme: 'branchlens-reconcile', path: `/${key}/draft/${name}` });
  previews.set(working.toString(), conflict.actual.text);
  previews.set(draft.toString(), conflict.draft.text);
  // Keep recent reconciliation tabs usable without retaining every preview forever.
  while (previews.size > 100) previews.delete(previews.keys().next().value!);
  await vscode.commands.executeCommand('vscode.diff', working, draft,
    `Reconcile working ${conflict.actual.exists ? 'file' : '(missing)'} ↔ draft ${conflict.draft.exists ? 'file' : '(missing)'}: ${name}`, { preview: true });
  await vscode.window.showWarningMessage(`${conflict.message}. Nothing was applied. Compare the working content with the draft, then refresh the comparison before applying.`);
}

async function chooseTarget(repository: GitRepository, session: ComparisonSession, side: Side): Promise<Target | undefined> {
  const ref = side === 'left' ? session.leftRef : session.rightRef;
  const sha = side === 'left' ? session.leftSha : session.rightSha;
  const mergeBase = side === 'left' && !session.includeUpstream;
  const [branches, worktrees] = await Promise.all([repository.branches(), repository.worktrees()]);
  const branch = branches.find(candidate => candidate.name === ref || `refs/heads/${candidate.name}` === ref ||
    (candidate.remote && `refs/remotes/${candidate.name}` === ref));
  const writableBranch = !mergeBase && branch && !branch.remote ? branch.name : undefined;
  const candidates = writableBranch ? worktrees.filter(tree => tree.branch === writableBranch) : worktrees.filter(tree => !!tree.branch);
  const choices: TargetChoice[] = candidates.map((tree: Worktree) => ({
    label: `$(git-branch) ${tree.branch}`,
    description: tree.path,
    detail: writableBranch ? 'Apply to this checked-out local branch' : `Explicitly use this local checkout for the ${mergeBase ? 'merge-base' : ref} draft; its content must match the baseline`,
    target: { root: tree.path, branch: tree.branch },
  }));
  choices.push({ label: '$(new-folder) Create a new worktree…', detail: writableBranch && candidates.length === 0
    ? `Check out ${writableBranch} in a new directory` : 'Choose a directory and create a local branch explicitly', create: true });
  const selected = await vscode.window.showQuickPick(choices, {
    title: mergeBase ? 'A merge-base snapshot has no writable branch. Choose an explicit target.' :
      branch?.remote ? `Choose a local checkout for remote branch ${ref}` : `Apply ${ref} draft to a local checkout`,
    placeHolder: 'BranchWeave never switches your current checkout or stashes changes',
    ignoreFocusOut: true,
  });
  if (!selected) return undefined;
  if (selected.target) return selected.target;
  let newBranch: string | undefined;
  if (!writableBranch || candidates.length > 0) {
    newBranch = await vscode.window.showInputBox({
      title: 'Name the new local branch', prompt: `Create a local branch from ${mergeBase ? 'the merge-base snapshot' : ref}`,
      ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : 'A new local branch name is required',
    });
    if (!newBranch) return undefined;
    newBranch = newBranch.trim();
    if (branches.some(candidate => !candidate.remote && candidate.name === newBranch)) {
      throw new Error(`Local branch ${newBranch} already exists. Choose its worktree instead.`);
    }
  }
  const folder = await vscode.window.showSaveDialog({
    title: 'Choose a directory for the new Git worktree', saveLabel: 'Create worktree',
    defaultUri: vscode.Uri.file(path.join(path.dirname(repository.root), `branchlens-${(newBranch ?? writableBranch ?? 'draft').replace(/[^a-zA-Z0-9_-]/g, '-')}`)),
  });
  if (!folder) return undefined;
  // Explicit dialogs above authorize this new checkout; existing checkouts are untouched.
  await repository.createWorktree(newBranch ? sha : writableBranch ?? sha, folder.fsPath, newBranch);
  return { root: folder.fsPath, branch: newBranch ?? writableBranch! };
}

function bufferAt(absolutePath: string): { text: string; isDirty: boolean } | undefined {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.scheme === 'file' && normalize(candidate.uri.fsPath) === normalize(absolutePath));
  return document ? { text: document.getText(), isDirty: document.isDirty } : undefined;
}

async function verifyCheckout(repository: GitRepository, target: Target): Promise<void> {
  const checkout = new GitRepository(target.root);
  if (await checkout.currentBranch() !== target.branch) {
    throw new Error(`The target checkout changed branches. Expected ${target.branch}; nothing was applied.`);
  }
  const targetRoot = await fs.realpath(target.root);
  const worktrees = await repository.worktrees();
  const verified = await Promise.all(worktrees.filter(tree => tree.branch === target.branch).map(async tree => {
    try { return await fs.realpath(tree.path) === targetRoot; } catch { return false; }
  }));
  if (!verified.some(Boolean)) throw new Error('The intended Git worktree could not be verified. Nothing was applied.');
}

/** Only called after the user presses the explicit Apply button. Save is separate. */
export async function applyDraft(repository: GitRepository, session: ComparisonSession, pair: DraftPair, side: Side): Promise<void> {
  try {
    const original: ApplyContent = { ...pair.original[side] };
    const draft: ApplyContent = { ...pair.current[side] };
    const target = await chooseTarget(repository, session, side);
    if (!target) return;
    await verifyCheckout(repository, target);
    let plan = await buildApplyPlan(target.root, original, draft, { readBuffer: bufferAt });
    if (plan.kind === 'none') {
      await vscode.window.showInformationMessage('The draft already matches this working file. Nothing to apply.');
      return;
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Apply ${side} draft to ${target.branch}?`,
      { modal: true, detail: `${target.root}\n${plan.kind === 'rename' ? `${original.path} → ${draft.path}` : draft.exists ? draft.path : original.path}\n\n${plan.kind === 'edit' ? 'Text changes remain unsaved and support editor undo.' : 'File creation, deletion or renaming affects this worktree immediately. Text changes remain unsaved and support editor undo.'}\nBranchWeave does not save, stash, switch branches, or commit.` },
      'Apply draft',
    );
    if (confirmation !== 'Apply draft') return;
    let document: vscode.TextDocument | undefined;
    if (original.exists && draft.exists) document = await vscode.workspace.openTextDocument(vscode.Uri.file(plan.source));
    // Recheck after dialogs/document loading: dirty buffers and checkout may have changed.
    await verifyCheckout(repository, target);
    const bufferVersions = new Map(vscode.workspace.textDocuments.map(open => [open.uri.toString(), open.version]));
    plan = await buildApplyPlan(target.root, original, draft, { readBuffer: bufferAt });
    if (vscode.workspace.textDocuments.some(open => bufferVersions.get(open.uri.toString()) !== open.version)) {
      throw new Error('An editor buffer changed during apply preflight. Nothing was applied; retry after reviewing it.');
    }
    const edit = new vscode.WorkspaceEdit();
    const sourceUri = vscode.Uri.file(plan.source);
    const destinationUri = vscode.Uri.file(plan.destination);
    const eolEdits = plan.eol ? [vscode.TextEdit.setEndOfLine(plan.eol === 'CRLF' ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF)] : [];
    if (plan.kind === 'create') {
      edit.createFile(destinationUri, { overwrite: false, ignoreIfExists: false });
      edit.set(destinationUri, [vscode.TextEdit.insert(new vscode.Position(0, 0), plan.text), ...eolEdits]);
    } else if (plan.kind === 'delete') {
      edit.deleteFile(sourceUri, { recursive: false, ignoreIfNotExists: false });
    } else if (plan.kind === 'edit' || plan.kind === 'rename') {
      if (!document) throw new Error('The source document is unavailable. Nothing was applied.');
      edit.set(sourceUri, [vscode.TextEdit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), plan.text), ...eolEdits]);
      if (plan.kind === 'rename') edit.renameFile(sourceUri, destinationUri, { overwrite: false, ignoreIfExists: false });
    }
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the complete workspace edit. Inspect the working tree before retrying.');
    if (draft.exists) await vscode.window.showTextDocument(destinationUri, { preview: false });
    await vscode.window.showInformationMessage('Draft applied to the working tree. Text edits are unsaved; use Save when ready. No commit was created.');
  } catch (error) {
    if (error instanceof ApplyConflict) await showConflict(error);
    else await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }
}
