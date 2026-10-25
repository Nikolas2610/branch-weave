import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { TestContext } from "node:test";
import { applyStagingHunk, readStagingState } from "../src/staging";

function git(
  root: string,
  args: string[],
  input?: string | Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", root, ...args],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`${args.join(" ")}: ${stderr || error.message}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(input);
  });
}

async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "branchweave-staging-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--initial-branch=feature/staging-test"]);
  await git(root, ["config", "user.name", "Staging Test"]);
  await git(root, ["config", "user.email", "staging@example.invalid"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(root, "file.txt"), "one\nanchor\ntwo\n");
  await writeFile(path.join(root, "other.txt"), "other\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fixture"]);
  return root;
}

test("stages and unstages one exact section without touching worktree or unrelated staged entries", async (t) => {
  const root = await fixture(t);
  const filename = path.join(root, "file.txt");
  const working = "ONE\nanchor\nTWO\n";
  await writeFile(filename, working);
  await writeFile(path.join(root, "other.txt"), "staged other\n");
  await git(root, ["add", "other.txt"]);
  const unrelated = await git(root, ["ls-files", "--stage", "--", "other.txt"]);
  const beforeStat = await stat(filename);
  const initial = await readStagingState(root, "file.txt");
  assert.equal(initial.error, undefined);
  assert.equal(initial.unstaged.length, 2);
  const staged = await applyStagingHunk(
    root,
    "file.txt",
    "stage",
    1,
    initial.token,
  );
  assert.equal(await git(root, ["show", ":file.txt"]), "one\nanchor\nTWO\n");
  assert.equal(staged.staged.length, 1);
  assert.equal(staged.unstaged.length, 1);
  await applyStagingHunk(root, "file.txt", "unstage", 0, staged.token);
  assert.equal(await git(root, ["show", ":file.txt"]), "one\nanchor\ntwo\n");
  assert.equal(await readFile(filename, "utf8"), working);
  assert.equal((await stat(filename)).mtimeMs, beforeStat.mtimeMs);
  assert.equal(
    await git(root, ["ls-files", "--stage", "--", "other.txt"]),
    unrelated,
  );
});

test("stages current unsaved buffer text and binds selections to that buffer", async (t) => {
  const root = await fixture(t);
  const buffer = { exists: true, text: "BUFFER\nanchor\ntwo\n" };
  const view = await readStagingState(root, "file.txt", buffer);
  assert.equal(view.bufferUnsaved, true);
  await assert.rejects(
    applyStagingHunk(root, "file.txt", "stage", 0, view.token, {
      ...buffer,
      text: "changed\n",
    }),
    /stale|changed/i,
  );
  await applyStagingHunk(root, "file.txt", "stage", 0, view.token, buffer);
  assert.equal(await git(root, ["show", ":file.txt"]), buffer.text);
  assert.equal(
    await readFile(path.join(root, "file.txt"), "utf8"),
    "one\nanchor\ntwo\n",
  );
});

test("equivalent buffer objects share a semantic token regardless of property order or extra fields", async (t) => {
  const root = await fixture(t);
  const buffer = {
    exists: true,
    text: "BUFFER\nanchor\ntwo\n",
    mode: "100644",
  };
  const extended = {
    mode: buffer.mode,
    path: "ignored-extra-path.txt",
    text: buffer.text,
    exists: true,
    unrelated: "ignored",
  };
  const view = await readStagingState(root, "file.txt", buffer);
  const equivalent = await readStagingState(root, "file.txt", extended);
  assert.equal(view.error, undefined);
  assert.equal(equivalent.error, undefined);
  assert.equal(equivalent.token, view.token);
  const staged = await applyStagingHunk(
    root,
    "file.txt",
    "stage",
    0,
    view.token,
    extended,
  );
  assert.equal(staged.error, undefined);
  assert.equal(await git(root, ["show", ":file.txt"]), buffer.text);
  assert.equal(await git(root, ["ls-files", "--", extended.path]), "");
  assert.equal(
    await readFile(path.join(root, "file.txt"), "utf8"),
    "one\nanchor\ntwo\n",
  );
});

test("rejects external disk edits or deletions beneath the same unsaved buffer without changing the index", async (t) => {
  const root = await fixture(t);
  const filename = path.join(root, "file.txt");
  const buffer = { exists: true, text: "BUFFER\nanchor\ntwo\n" };
  for (const operation of ["edit", "delete"] as const) {
    await writeFile(filename, "one\nanchor\ntwo\n");
    const before = await readFile(path.join(root, ".git", "index"));
    const view = await readStagingState(root, "file.txt", buffer);
    assert.equal(view.error, undefined);
    assert.match(view.token, /^[a-f0-9]{64}$/);
    if (operation === "edit") await writeFile(filename, "EXTERNAL\n");
    else await unlink(filename);
    const updated = await readStagingState(root, "file.txt", buffer);
    assert.equal(updated.error, undefined);
    assert.notEqual(
      updated.token,
      view.token,
      `Saved file ${operation} must change the buffer-backed selection token.`,
    );
    await assert.rejects(
      applyStagingHunk(root, "file.txt", "stage", 0, view.token, buffer),
      /stale|changed/i,
    );
    assert.deepEqual(await readFile(path.join(root, ".git", "index")), before);
    if (operation === "edit")
      assert.equal(await readFile(filename, "utf8"), "EXTERNAL\n");
    else await assert.rejects(readFile(filename), { code: "ENOENT" });
  }
});

test("a final live-buffer guard can cancel publication without changing files or leaving index locks", async (t) => {
  const root = await fixture(t);
  const working = { exists: true, text: "BUFFER\nanchor\ntwo\n" };
  const view = await readStagingState(root, "file.txt", working);
  const before = await readFile(path.join(root, ".git", "index"));
  let checks = 0;
  await assert.rejects(
    applyStagingHunk(
      root,
      "file.txt",
      "stage",
      0,
      view.token,
      working,
      async () => {
        checks++;
        assert.deepEqual(
          await readFile(path.join(root, ".git", "index")),
          before,
        );
        throw new Error("The actual live buffer changed before publication.");
      },
    ),
    /actual live buffer changed/i,
  );
  assert.equal(checks, 1);
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), before);
  assert.equal(
    await readFile(path.join(root, "file.txt"), "utf8"),
    "one\nanchor\ntwo\n",
  );
  assert.deepEqual(
    (await readdir(path.join(root, ".git"))).filter(
      (name) => name === "index.lock" || name.startsWith("index.branchweave-"),
    ),
    [],
  );
});

test("rejects changes to unrelated index entries, HEAD, symbolic branch and path", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "file.txt"), "changed\n");
  let view = await readStagingState(root, "file.txt");
  await writeFile(path.join(root, "other.txt"), "other changed\n");
  await git(root, ["add", "other.txt"]);
  await assert.rejects(
    applyStagingHunk(root, "file.txt", "stage", 0, view.token),
    /stale|changed/i,
  );
  view = await readStagingState(root, "file.txt");
  await git(root, ["commit", "-m", "advance HEAD"]);
  await assert.rejects(
    applyStagingHunk(root, "file.txt", "stage", 0, view.token),
    /stale|changed/i,
  );
  view = await readStagingState(root, "file.txt");
  await git(root, ["checkout", "-b", "feature/other"]);
  await assert.rejects(
    applyStagingHunk(root, "file.txt", "stage", 0, view.token),
    /stale|changed/i,
  );
  view = await readStagingState(root, "file.txt");
  await assert.rejects(
    applyStagingHunk(root, "other.txt", "stage", 0, view.token),
    /stale|changed/i,
  );
});

test("refuses existing index locks and leaves their bytes and the index intact", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "file.txt"), "change\n");
  const view = await readStagingState(root, "file.txt");
  const index = await readFile(path.join(root, ".git", "index"));
  await writeFile(path.join(root, ".git", "index.lock"), "external lock");
  await assert.rejects(
    applyStagingHunk(root, "file.txt", "stage", 0, view.token),
    /lock/i,
  );
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), index);
  assert.equal(
    await readFile(path.join(root, ".git", "index.lock"), "utf8"),
    "external lock",
  );
});

test("supports additions, deletions and empty files without recreating removed working files", async (t) => {
  const root = await fixture(t);
  for (const [filename, text] of [
    ["new.txt", "new without newline"],
    ["empty.txt", ""],
  ] as const) {
    await writeFile(path.join(root, filename), text);
    const view = await readStagingState(root, filename);
    assert.equal(view.unstaged.length, 1);
    const staged = await applyStagingHunk(
      root,
      filename,
      "stage",
      0,
      view.token,
    );
    assert.equal(await git(root, ["show", `:${filename}`]), text);
    await applyStagingHunk(root, filename, "unstage", 0, staged.token);
    assert.equal(await git(root, ["ls-files", "--", filename]), "");
    assert.equal(await readFile(path.join(root, filename), "utf8"), text);
  }
  await unlink(path.join(root, "file.txt"));
  const view = await readStagingState(root, "file.txt");
  const staged = await applyStagingHunk(
    root,
    "file.txt",
    "stage",
    0,
    view.token,
  );
  assert.equal(await git(root, ["ls-files", "--", "file.txt"]), "");
  await applyStagingHunk(root, "file.txt", "unstage", 0, staged.token);
  assert.equal(await git(root, ["show", ":file.txt"]), "one\nanchor\ntwo\n");
  await assert.rejects(readFile(path.join(root, "file.txt")), {
    code: "ENOENT",
  });
});

test("preserves exact CRLF and unterminated lines, and existing executable index mode", async (t) => {
  const root = await fixture(t);
  await git(root, ["update-index", "--chmod=+x", "file.txt"]);
  await git(root, ["commit", "-m", "executable"]);
  const text = "ONE\r\nanchor\r\ntwo";
  await writeFile(path.join(root, "file.txt"), text);
  let view = await readStagingState(root, "file.txt");
  while (view.unstaged.length)
    view = await applyStagingHunk(root, "file.txt", "stage", 0, view.token);
  assert.equal(await git(root, ["show", ":file.txt"]), text);
  assert.match(
    await git(root, ["ls-files", "--stage", "--", "file.txt"]),
    /^100755 /,
  );
});

test("rejects unsupported bytes, LFS, paths, symlink entries, submodules and oversized buffers", async (t) => {
  const root = await fixture(t);
  for (const content of [
    Buffer.from([0, 1]),
    Buffer.from([0xff]),
    Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\n"),
    Buffer.from("mixed\r\nLF\n"),
  ]) {
    await writeFile(path.join(root, "file.txt"), content);
    assert.match(
      (await readStagingState(root, "file.txt")).error ?? "",
      /binary|UTF-8|LFS|line endings/i,
    );
  }
  for (const filename of [
    "../outside",
    ".git/config",
    "a/../file.txt",
    "C:/file.txt",
  ]) {
    assert.ok((await readStagingState(root, filename)).error);
  }
  await writeFile(path.join(root, "file.txt"), "ordinary text\n");
  assert.match(
    (
      await readStagingState(root, "file.txt", {
        exists: true,
        text: "x".repeat(2 * 1024 * 1024 + 1),
      })
    ).error ?? "",
    /limit|2 MiB|2 MB/i,
  );
  const oid = (
    await git(root, ["hash-object", "-w", "--stdin"], "target")
  ).trim();
  await git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `120000,${oid},link.txt`,
  ]);
  assert.match(
    (await readStagingState(root, "link.txt")).error ?? "",
    /symbolic|symlink/i,
  );
  const head = (await git(root, ["rev-parse", "HEAD"])).trim();
  await git(root, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${head},module`,
  ]);
  assert.match(
    (
      await readStagingState(root, "module/child.txt", {
        exists: true,
        text: "buffer",
      })
    ).error ?? "",
    /submodule/i,
  );
});

test("rejects unmerged indexes and does not write an index for invalid section selections", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "file.txt"), "changed\n");
  const view = await readStagingState(root, "file.txt");
  const before = await readFile(path.join(root, ".git", "index"));
  await assert.rejects(
    applyStagingHunk(root, "file.txt", "stage", 99, view.token),
    /section|hunk/i,
  );
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), before);
  const oid = (await git(root, ["rev-parse", "HEAD:file.txt"])).trim();
  await git(
    root,
    ["update-index", "--index-info"],
    `0 ${"0".repeat(40)}\tfile.txt\n100644 ${oid} 1\tfile.txt\n100644 ${oid} 2\tfile.txt\n100644 ${oid} 3\tfile.txt\n`,
  );
  assert.match(
    (await readStagingState(root, "file.txt")).error ?? "",
    /unmerged|conflict/i,
  );
});

test("shows and unstages a mode-only index change", async (t) => {
  const root = await fixture(t);
  await git(root, ["update-index", "--chmod=+x", "file.txt"]);
  const view = await readStagingState(root, "file.txt");
  assert.equal(view.staged.length, 1);
  assert.match(view.staged[0].summary, /mode|executable/i);
  await applyStagingHunk(root, "file.txt", "unstage", 0, view.token);
  assert.match(
    await git(root, ["ls-files", "--stage", "--", "file.txt"]),
    /^100644 /,
  );
});

test("handles split indexes and path-specific rename semantics without staging the old path", async (t) => {
  const root = await fixture(t);
  await git(root, ["update-index", "--split-index"]);
  await writeFile(path.join(root, "renamed.txt"), "one\nanchor\ntwo\n");
  await unlink(path.join(root, "file.txt"));
  const view = await readStagingState(root, "renamed.txt");
  assert.equal(view.error, undefined);
  await applyStagingHunk(root, "renamed.txt", "stage", 0, view.token);
  assert.equal(await git(root, ["show", ":file.txt"]), "one\nanchor\ntwo\n");
  assert.equal(await git(root, ["show", ":renamed.txt"]), "one\nanchor\ntwo\n");
  await assert.rejects(readFile(path.join(root, "file.txt")), {
    code: "ENOENT",
  });
});

test("supports staging and unstaging in an unborn repository with a missing index", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "branchweave-unborn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, ["init", "--initial-branch=feature/unborn"]);
  await writeFile(path.join(root, "empty.txt"), "");
  const view = await readStagingState(root, "empty.txt");
  assert.equal(view.error, undefined);
  const staged = await applyStagingHunk(
    root,
    "empty.txt",
    "stage",
    0,
    view.token,
  );
  assert.equal(staged.staged.length, 1);
  await applyStagingHunk(root, "empty.txt", "unstage", 0, staged.token);
  assert.equal(await git(root, ["ls-files"]), "");
  assert.equal(await readFile(path.join(root, "empty.txt"), "utf8"), "");
});
