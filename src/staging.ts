import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { DraftPair, type DraftContent } from "./draft";
import { GitRepository, safeRelativePath, type Snapshot } from "./git";
import type { StagingSectionView, StagingView } from "./workflowTypes";

type WorkingContent = { exists: boolean; text: string; mode?: string };
type Entry = {
  mode: string;
  oid: string;
  stage: number;
  filename: string;
  raw: string;
};
type Identity = { head: string; branch: string };
type State = Identity & {
  root: string;
  indexPath: string;
  indexBytes?: Buffer;
  entries: Entry[];
  headContent: DraftContent;
  indexContent: DraftContent;
  diskContent: DraftContent;
  workingContent: DraftContent;
  staged: DraftPair;
  unstaged: DraftPair;
  view: StagingView;
};
const MAX_BYTES = 2 * 1024 * 1024;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const stale = (): Error =>
  new Error(
    "The staging selection is stale: the file, buffer, index, HEAD or branch changed. Refresh and select the section again.",
  );

function git(
  root: string,
  args: string[],
  input?: string | Buffer,
  indexPath?: string,
  accepted = [0],
): Promise<Buffer> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
  };
  for (const key of [
    "GIT_INDEX_FILE",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
  ])
    delete (env as NodeJS.ProcessEnv)[key];
  if (indexPath) (env as NodeJS.ProcessEnv).GIT_INDEX_FILE = indexPath;
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["--literal-pathspecs", "-C", root, ...args],
      {
        encoding: "buffer",
        env,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (
          error &&
          !(typeof error.code === "number" && accepted.includes(error.code))
        )
          reject(
            new Error(
              `Git ${args[0]} failed: ${stderr.toString("utf8").trim() || error.message}`,
            ),
          );
        else resolve(stdout);
      },
    );
    // Ignore EPIPE when Git rejects input before consuming it; the exit callback reports the error.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}

async function identity(root: string): Promise<Identity> {
  const head = (
    await git(
      root,
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      undefined,
      undefined,
      [0, 1],
    )
  )
    .toString("utf8")
    .trim();
  if (head && !OBJECT_ID.test(head))
    throw new Error("Cannot resolve the current HEAD.");
  const branch = (
    await git(
      root,
      ["symbolic-ref", "--quiet", "HEAD"],
      undefined,
      undefined,
      [0, 1],
    )
  )
    .toString("utf8")
    .trim();
  return { head, branch };
}

async function optionalBytes(filename: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("The Git index must be a regular file.");
    return await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertUnlocked(indexPath: string): Promise<void> {
  try {
    await lstat(indexPath + ".lock");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    "The Git index is locked by another operation. Retry after it finishes.",
  );
}

function validatePath(filename: string): void {
  safeRelativePath(filename);
  if (
    filename.includes(":") ||
    filename
      .split("/")
      .some((part) => part.toLowerCase() === ".git" || /[. ]$/.test(part))
  ) {
    throw new Error("Unsafe working-tree path or Git metadata path.");
  }
}

function text(bytes: Buffer): string {
  if (bytes.length > MAX_BYTES)
    throw new Error("File exceeds the 2 MiB text size limit.");
  if (bytes.includes(0)) throw new Error("Binary files are unsupported.");
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error("Files with invalid UTF-8 encoding are unsupported.");
  }
  if (
    /^version https:\/\/git-lfs\.github\.com\/spec\/v1(?:\r?\n|$)/.test(value)
  )
    throw new Error("Git LFS pointer files are unsupported.");
  const remainder = value.replace(/\r\n/g, "");
  if (
    remainder.includes("\r") ||
    (value.includes("\r\n") && remainder.includes("\n"))
  )
    throw new Error(
      "Mixed or standalone carriage return line endings are unsupported.",
    );
  return value;
}

function supportedMode(mode?: string): void {
  if (mode === "120000") throw new Error("Symbolic links are unsupported.");
  if (mode === "160000") throw new Error("Submodules are unsupported.");
  if (mode && mode !== "100644" && mode !== "100755")
    throw new Error(`Unsupported Git file mode: ${mode}.`);
}

function content(snapshot: Snapshot, filename: string): DraftContent {
  if (snapshot.binary)
    throw new Error(snapshot.reason ?? "Unsupported file content.");
  supportedMode(snapshot.mode);
  return {
    exists: snapshot.exists,
    text: snapshot.text,
    mode: snapshot.mode,
    path: filename,
  };
}

async function indexEntries(
  root: string,
  indexPath?: string,
): Promise<Entry[]> {
  const raw = (
    await git(root, ["ls-files", "--stage", "-z"], undefined, indexPath)
  ).toString("utf8");
  return raw
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match || !OBJECT_ID.test(match[2]))
        throw new Error("Git returned an invalid index entry.");
      return {
        mode: match[1],
        oid: match[2],
        stage: Number(match[3]),
        filename: match[4],
        raw: record,
      };
    });
}

function sections(pair: DraftPair): StagingSectionView[] {
  const current = pair.current;
  const left = current.left.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const right = current.right.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const result = pair.hunks().map((hunk, index) => ({
    index,
    summary: `Section ${index + 1}: -${hunk.leftStart + 1},${hunk.leftCount} +${hunk.rightStart + 1},${hunk.rightCount}`,
    preview:
      [
        ...left
          .slice(hunk.leftStart, hunk.leftStart + hunk.leftCount)
          .map((line) => "-" + line),
        ...right
          .slice(hunk.rightStart, hunk.rightStart + hunk.rightCount)
          .map((line) => "+" + line),
      ]
        .join("")
        .slice(0, 2400) ||
      (!current.left.exists ? "Add empty file" : "Delete empty file"),
  }));
  if (
    current.left.exists &&
    current.right.exists &&
    current.left.mode !== current.right.mode
  ) {
    result.push({
      index: result.length,
      summary: `Executable mode: ${current.left.mode} → ${current.right.mode}`,
      preview: "File permissions only; text is unchanged by this section.",
    });
  }
  return result;
}

async function load(
  root: string,
  filename: string,
  working?: WorkingContent,
  ownLock = false,
): Promise<State> {
  validatePath(filename);
  root = await realpath(root);
  const top = await realpath(
    (await git(root, ["rev-parse", "--show-toplevel"])).toString("utf8").trim(),
  );
  if (path.relative(root, top))
    throw new Error("Staging requires the repository working-tree root.");
  const indexPath = path.resolve(
    root,
    (await git(root, ["rev-parse", "--git-path", "index"]))
      .toString("utf8")
      .trim(),
  );
  if (!ownLock) await assertUnlocked(indexPath);
  const before = await identity(root);
  const indexBytes = await optionalBytes(indexPath);
  const entries = await indexEntries(root);
  if (entries.some((entry) => entry.stage !== 0))
    throw new Error(
      "Resolve unmerged index conflicts before staging sections.",
    );
  const aliases = entries.filter(
    (entry) =>
      entry.filename !== filename &&
      (filename.startsWith(entry.filename + "/") ||
        entry.filename.startsWith(filename + "/") ||
        (process.platform === "win32" &&
          entry.filename.toLowerCase() === filename.toLowerCase())),
  );
  if (aliases.some((entry) => entry.mode === "160000"))
    throw new Error("Submodules are unsupported.");
  if (aliases.length)
    throw new Error(
      "The selected path conflicts with another Git index entry.",
    );
  const repo = new GitRepository(root);
  const headContent = before.head
    ? content(await repo.readFile(before.head, filename), filename)
    : { exists: false, text: "", path: filename };
  const entry = entries.find((candidate) => candidate.filename === filename);
  let indexContent: DraftContent = { exists: false, text: "", path: filename };
  if (entry) {
    supportedMode(entry.mode);
    const size = Number(
      (await git(root, ["cat-file", "-s", entry.oid])).toString("utf8").trim(),
    );
    if (!Number.isFinite(size) || size > MAX_BYTES)
      throw new Error("File exceeds the 2 MiB text size limit.");
    indexContent = {
      exists: true,
      text: text(await git(root, ["cat-file", "blob", entry.oid])),
      path: filename,
      mode: entry.mode,
    };
  }
  const disk = content(await repo.readWorkingFile(filename), filename);
  let workingContent = disk;
  if (working) {
    if (
      typeof working.exists !== "boolean" ||
      typeof working.text !== "string" ||
      (!working.exists && working.text !== "")
    )
      throw new Error("Invalid working buffer content.");
    supportedMode(working.mode);
    const bufferText = text(Buffer.from(working.text, "utf8"));
    if (bufferText !== working.text)
      throw new Error("Files with invalid UTF-8 encoding are unsupported.");
    workingContent = {
      exists: working.exists,
      text: bufferText,
      mode: working.mode,
      path: filename,
    };
  }
  // Section staging transfers text/existence only. Preserve executable bits already in the index.
  workingContent = {
    exists: workingContent.exists,
    text: workingContent.text,
    mode:
      indexContent.mode ?? workingContent.mode ?? headContent.mode ?? "100644",
    path: filename,
  };
  const staged = new DraftPair(headContent, indexContent),
    unstaged = new DraftPair(indexContent, workingContent);
  const after = await identity(root);
  const afterBytes = await optionalBytes(indexPath);
  if (
    before.head !== after.head ||
    before.branch !== after.branch ||
    digest(indexBytes ?? "missing") !== digest(afterBytes ?? "missing")
  )
    throw stale();
  if (!ownLock) await assertUnlocked(indexPath);
  // Saved content and the live buffer are separate baselines; an override must never hide disk drift.
  const token = digest(
    JSON.stringify({
      root,
      filename,
      ...before,
      index: digest(indexBytes ?? "missing"),
      disk,
      working: workingContent,
    }),
  );
  const view: StagingView = {
    token,
    staged: sections(staged),
    unstaged: sections(unstaged),
    bufferUnsaved:
      !!working &&
      (working.exists !== disk.exists || working.text !== disk.text),
  };
  return {
    root,
    indexPath,
    indexBytes,
    entries,
    ...before,
    headContent,
    indexContent,
    diskContent: disk,
    workingContent,
    staged,
    unstaged,
    view,
  };
}

/** These sections describe HEAD → index and index → working content, never the reference comparison. */
export async function readStagingState(
  root: string,
  relativePath: string,
  working?: WorkingContent,
): Promise<StagingView> {
  try {
    return (await load(root, relativePath, working)).view;
  } catch (error) {
    return {
      token: "",
      staged: [],
      unstaged: [],
      bufferUnsaved: false,
      error: (error as Error).message,
    };
  }
}

/** Acquire Git's real index lock, prepare an isolated index, then publish it only after revalidation. */
export async function applyStagingHunk(
  root: string,
  relativePath: string,
  operation: "stage" | "unstage",
  hunkIndex: number,
  expectedToken: string,
  working?: WorkingContent,
  beforePublish?: () => Promise<void>,
): Promise<StagingView> {
  if (operation !== "stage" && operation !== "unstage")
    throw new Error("Invalid staging operation.");
  const initial = await load(root, relativePath, working);
  if (!expectedToken || expectedToken !== initial.view.token) throw stale();
  const pair = operation === "stage" ? initial.unstaged : initial.staged;
  if (!Number.isInteger(hunkIndex) || !sections(pair)[hunkIndex])
    throw new Error("The selected staging section no longer exists.");
  if (pair.hunks()[hunkIndex])
    pair.transferHunk(
      operation === "stage" ? "right" : "left",
      hunkIndex,
      pair.version,
    );
  else {
    const values = pair.current;
    const from = operation === "stage" ? "right" : "left",
      to = operation === "stage" ? "left" : "right";
    pair.setContent(
      to,
      { ...values[to], mode: values[from].mode },
      pair.version,
    );
  }
  const next = pair.current[operation === "stage" ? "left" : "right"];
  const lockPath = initial.indexPath + ".lock";
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("The Git index is locked by another operation.");
    throw error;
  }
  const lockIdentity = await lock.stat();
  const temporary = initial.indexPath + ".branchweave-" + randomUUID();
  let published = false;
  try {
    const current = await load(root, relativePath, working, true);
    if (current.view.token !== expectedToken) throw stale();
    if (current.indexBytes)
      await writeFile(temporary, current.indexBytes, { flag: "wx" });
    else await git(root, ["read-tree", "--empty"], undefined, temporary);
    // Materialize split indexes in the independent file before editing; unrelated entries survive.
    await git(root, ["update-index", "--no-split-index"], undefined, temporary);
    if (next.exists) {
      const oid = (await git(root, ["hash-object", "-w", "--stdin"], next.text))
        .toString("utf8")
        .trim();
      if (!OBJECT_ID.test(oid))
        throw new Error("Git returned an invalid blob ID.");
      await git(
        root,
        ["update-index", "-z", "--index-info"],
        `${next.mode ?? current.indexContent.mode ?? "100644"} ${oid}\t${relativePath}\0`,
        temporary,
      );
    } else {
      const length =
        current.head.length || current.entries[0]?.oid.length || 40;
      await git(
        root,
        ["update-index", "-z", "--index-info"],
        `0 ${"0".repeat(length)}\t${relativePath}\0`,
        temporary,
      );
    }
    const updated = await indexEntries(root, temporary);
    if (
      JSON.stringify(
        updated
          .filter((entry) => entry.filename !== relativePath)
          .map((entry) => entry.raw),
      ) !==
      JSON.stringify(
        current.entries
          .filter((entry) => entry.filename !== relativePath)
          .map((entry) => entry.raw),
      )
    ) {
      throw new Error(
        "Refusing an index update that changes unrelated staged entries.",
      );
    }
    const finalState = await load(root, relativePath, working, true);
    if (finalState.view.token !== expectedToken) throw stale();
    const held = await lstat(lockPath);
    if (
      !held.isFile() ||
      held.ino !== lockIdentity.ino ||
      held.dev !== lockIdentity.dev
    )
      throw new Error("The Git index lock changed during staging.");
    await lock.writeFile(await readFile(temporary));
    await lock.sync();
    await lock.close();
    // Check immutable selection identity and the real index once more immediately before publication.
    const finalIdentity = await identity(root);
    const finalDisk = content(
      await new GitRepository(initial.root).readWorkingFile(relativePath),
      relativePath,
    );
    if (
      finalIdentity.head !== initial.head ||
      finalIdentity.branch !== initial.branch ||
      JSON.stringify(finalDisk) !== JSON.stringify(initial.diskContent) ||
      digest((await optionalBytes(initial.indexPath)) ?? "missing") !==
        digest(initial.indexBytes ?? "missing")
    )
      throw stale();
    // The host can re-read the actual live editor buffer after all awaited Git preparation.
    await beforePublish?.();
    await rename(lockPath, initial.indexPath);
    published = true;
  } finally {
    await lock.close().catch(() => undefined);
    if (!published) {
      const held = await lstat(lockPath).catch(() => undefined);
      if (held?.ino === lockIdentity.ino && held?.dev === lockIdentity.dev)
        await unlink(lockPath);
    }
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await unlink(temporary + ".lock").catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  return readStagingState(root, relativePath, working);
}
