import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
const fixture = process.env.BRANCHLENS_HOST_FIXTURE!;
const resultPath = process.env.BRANCHLENS_HOST_RESULT!;
const results: { name: string; status: string; detail?: string }[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const panelTab = () =>
  tabs().find(
    (t) =>
      t.input instanceof vscode.TabInputWebview &&
      t.input.viewType === "mainThreadWebview-branchlens.diff",
  );
const anyPanel = () =>
  panelTab() ||
  tabs().find(
    (t) =>
      t.input instanceof vscode.TabInputWebview &&
      t.label.startsWith("BranchWeave"),
  );
async function execute(command: string, ...args: unknown[]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      vscode.commands.executeCommand(command, ...args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Command timed out: " + command)),
          20000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(
  test: () => boolean | Promise<boolean>,
  description: string,
  timeout = 15000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await test()) return;
    await delay(100);
  }
  throw Error("Timed out: " + description);
}
async function check(name: string, test: () => Promise<void>) {
  try {
    await test();
    results.push({ name, status: "passed" });
    console.log("PASS " + name);
  } catch (error) {
    results.push({ name, status: "failed", detail: String(error) });
    throw error;
  } finally {
    await writeFile(
      resultPath,
      JSON.stringify(
        { vscodeVersion: vscode.version, fixture, results },
        null,
        2,
      ),
    );
  }
}
function git(...args: string[]) {
  return execFileSync("git", ["-C", fixture, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}
async function workingText(filename: string) {
  return vscode.workspace.openTextDocument(
    vscode.Uri.file(path.join(fixture, filename)),
  );
}
async function transfer(
  action: string,
  expected: string,
  document: vscode.TextDocument,
  value?: string,
) {
  await execute("branchlens." + action, value);
  await waitFor(
    () => document.getText() === expected,
    action + " changes the actual working buffer",
  );
  assert.equal(
    anyPanel()?.isDirty,
    false,
    "Comparison panel must never become an unsaved file",
  );
}
export async function run() {
  const startedAt = new Date().toISOString();
  const beforeHead = git("rev-parse", "HEAD");
  const aDisk = await readFile(path.join(fixture, "a.txt"), "utf8");
  const bDisk = await readFile(path.join(fixture, "b.txt"), "utf8");
  let a: vscode.TextDocument;
  let b: vscode.TextDocument;
  try {
    await check(
      "activate extension and register contributed commands",
      async () => {
        const extension = vscode.extensions.getExtension(
          "Nikolas2610.branch-lens",
        );
        assert.ok(extension);
        await extension.activate();
        assert.equal(vscode.workspace.isTrusted, true);
        const commands = await vscode.commands.getCommands(true);
        for (const c of extension.packageJSON.contributes.commands)
          assert.ok(commands.includes(c.command));
        assert.equal(
          extension.packageJSON.contributes.customEditors,
          undefined,
        );
      },
    );
    await check(
      "include unsaved buffers and a new untracked file before comparison",
      async () => {
        a = await workingText("a.txt");
        const edit = new vscode.WorkspaceEdit();
        edit.insert(
          a.uri,
          a.positionAt(a.getText().length),
          "unsaved local line\n",
        );
        assert.equal(await vscode.workspace.applyEdit(edit), true);
        assert.equal(a.isDirty, true);
        await writeFile(
          path.join(fixture, "new-local.txt"),
          "new current-branch file\n",
        );
        assert.equal(
          await readFile(path.join(fixture, "a.txt"), "utf8"),
          aDisk,
        );
      },
    );
    await check(
      "open a reusable panel without a session document or save dot",
      async () => {
        await execute("workbench.view.extension.branchlens");
        await execute("branchlens.compare.focus");
        await execute("branchlens.files.focus");
        await execute("branchlens.compare");
        await waitFor(() => !!anyPanel(), "BranchWeave panel");
        assert.ok(anyPanel()!.input instanceof vscode.TabInputWebview);
        assert.equal(anyPanel()!.isDirty, false);
        assert.equal(
          tabs().some((t) => t.input instanceof vscode.TabInputCustom),
          false,
        );
      },
    );
    await delay(1800);
    await check(
      "line transfer updates the current unsaved buffer and preserves its other local lines",
      async () => {
        await execute("branchlens.focusLeft");
        await transfer(
          "transferLine",
          "base a\nunchanged\nunsaved local line\n",
          a!,
          "left",
        );
        assert.equal(a!.isDirty, true);
        assert.equal(
          await readFile(path.join(fixture, "a.txt"), "utf8"),
          aDisk,
        );
        await transfer("undo", aDisk + "unsaved local line\n", a!);
        await transfer("redo", "base a\nunchanged\nunsaved local line\n", a!);
        await transfer("undo", aDisk + "unsaved local line\n", a!);
      },
    );
    await check(
      "section transfer and undo target the second real working file",
      async () => {
        b = await workingText("b.txt");
        await execute("branchlens.open", 1);
        await delay(200);
        await transfer("transferHunk", "base b\n", b, "left");
        assert.equal(b.isDirty, true);
        assert.equal(
          await readFile(path.join(fixture, "b.txt"), "utf8"),
          bDisk,
        );
        // Git refresh can remove a resolved file from the changed-file tree;
        // the open working view must stay pinned so Undo still targets b.txt.
        await delay(1600);
        await transfer("undo", bDisk, b);
      },
    );
    await check(
      "automatic discovery keeps running after right-side edits",
      async () => {
        await execute("branchlens.open", 0);
        await delay(200);
        await transfer(
          "transferLine",
          "base a\nunchanged\nunsaved local line\n",
          a!,
          "left",
        );
        await writeFile(
          path.join(fixture, "late-current.txt"),
          "late current file\n",
        );
        await delay(2200);
        await execute("branchlens.open", 2);
        await delay(250);
        await execute("branchlens.save");
        await waitFor(
          () =>
            vscode.workspace.textDocuments.some(
              (d) => path.resolve(d.uri.fsPath).toLowerCase() === path.join(fixture, "late-current.txt").toLowerCase(),
            ),
          "new late file discovered after an edit",
        );
        await execute("branchlens.open", 0);
        await delay(200);
        await transfer("undo", aDisk + "unsaved local line\n", a!);
      },
    );
    await check(
      "new untracked file is part of the selectable working comparison",
      async () => {
        await execute("branchlens.open", 3);
        await delay(200);
        await execute("branchlens.save");
        const local = await workingText("new-local.txt");
        assert.equal(local.getText(), "new current-branch file\n");
        assert.equal(local.isUntitled, false);
        assert.equal(anyPanel()!.isDirty, false);
      },
    );
    await check(
      "closing and reopening comparison does not prompt to save a session or discard working edits",
      async () => {
        await execute("branchlens.open", 0);
        assert.equal(a!.isDirty, true);
        const old = anyPanel()!;
        assert.equal(await vscode.window.tabGroups.close(old), true);
        await waitFor(() => !anyPanel(), "panel close");
        assert.equal(a!.getText(), aDisk + "unsaved local line\n");
        assert.equal(a!.isDirty, true);
        await execute("branchlens.open", 0);
        await waitFor(() => !!anyPanel(), "panel reopened");
        assert.equal(anyPanel()!.isDirty, false);
      },
    );
    await delay(300);
    await check(
      "Save writes the current real file, never a comparison-session file",
      async () => {
        await execute("branchlens.save");
        await waitFor(() => !a!.isDirty, "real working file saved");
        assert.equal(
          await readFile(path.join(fixture, "a.txt"), "utf8"),
          aDisk + "unsaved local line\n",
        );
        assert.equal(anyPanel()!.isDirty, false);
        assert.equal(
          tabs().some((t) => t.input instanceof vscode.TabInputCustom),
          false,
        );
      },
    );
    await check(
      "comparison options and presentation commands preserve current checkout",
      async () => {
        await execute("branchlens.upstream", true);
        await execute("branchlens.upstream", false);
        await execute("branchlens.highlight", false);
        await execute("branchlens.highlight", true);
        await execute("branchlens.flat", true);
        await execute("branchlens.flat", false);
        await execute("branchlens.refresh");
        assert.equal(git("branch", "--show-current"), "feature/host-smoke");
        assert.equal(git("rev-parse", "HEAD"), beforeHead);
        assert.equal(
          await readFile(path.join(fixture, "a.txt"), "utf8"),
          aDisk + "unsaved local line\n",
        );
        assert.equal(anyPanel()!.isDirty, false);
      },
    );
    // Save only disposable fixture buffers so closing the isolated host never waits on prompts.
    for (const doc of vscode.workspace.textDocuments)
      if (
        doc.uri.scheme === "file" &&
        doc.uri.fsPath.startsWith(fixture) &&
        doc.isDirty
      )
        await doc.save();
    await vscode.window.tabGroups.close(tabs());
  } finally {
    await writeFile(
      resultPath,
      JSON.stringify(
        {
          startedAt,
          finishedAt: new Date().toISOString(),
          vscodeVersion: vscode.version,
          fixture,
          results,
          scope:
            "Public VS Code APIs and actual rendered webview commands; selected reference vs current live working files. No private DOM or injected messages.",
          unverified: [
            "Native reference/worktree/file-operation confirmation dialogs and disk-conflict save prompts require separate interactive checks.",
          ],
        },
        null,
        2,
      ),
    );
  }
}
