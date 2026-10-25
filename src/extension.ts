import * as path from "node:path";
import * as vscode from "vscode";
import { diffLines } from "diff";
import { GitRepository, ComparisonSession, Snapshot, ChangedFile } from "./git";
import { DraftPair, Side, DraftContent } from "./draft";
import { applyDraft, showConflict } from "./apply";
import { ApplyConflict } from "./applyPlan";
import {
  writeWorkingFile,
  saveWorkingFile,
  workingBufferContents,
  LiveConflict,
} from "./live";
import { html } from "./webview";
import { safeApplyPath } from "./applyPlan";
import {
  ReviewStore,
  PresetStore,
  snapshotFingerprint,
  exportReviewMarkdown,
  type ReviewSnapshot,
} from "./review";
import { readStagingState, applyStagingHunk } from "./staging";
import { analyzeImpact } from "./impact";
import type { ReviewView, StagingView, ImpactView } from "./workflowTypes";
import {
  actions,
  Action,
  validateMessage,
  matchesDraftTarget,
} from "./messages";

interface Settings {
  left: string;
  right: string;
  includeUpstream: boolean;
  highlight: boolean;
  flat: boolean;
  focusMode: boolean;
  ignoreWhitespace: boolean;
  filter: string;
}
interface Saved {
  session: ComparisonSession;
  drafts: [number, string][];
  active: number;
  pinned?: ChangedFile;
}
class ComparisonState {
  constructor(
    public session: ComparisonSession,
    public drafts = new Map<number, DraftPair>(),
    public active = 0,
    public pinned?: ChangedFile,
  ) {}
  serialize() {
    return JSON.stringify({
      session: this.session,
      drafts: [...this.drafts].map(([i, p]) => [i, p.serialize()]),
      active: this.active,
      pinned: this.pinned,
    } satisfies Saved);
  }
  static parse(text: string) {
    const s = JSON.parse(text) as Saved;
    if (!s.session?.rightWorkingTree || !Array.isArray(s.drafts))
      throw new Error("Unsupported saved comparison");
    return new ComparisonState(
      s.session,
      new Map(s.drafts.map(([i, p]) => [i, DraftPair.restore(p)])),
      s.active,
      s.pinned,
    );
  }
}
class BranchLens implements vscode.Disposable {
  private sidebars = new Set<vscode.Webview>();
  private panel?: vscode.WebviewPanel;
  private panelReady = false;
  private doc?: ComparisonState;
  private repositories: GitRepository[] = [];
  private repository?: GitRepository;
  private settings: Settings = {
    left: "",
    right: "",
    includeUpstream: false,
    highlight: true,
    flat: false,
    focusMode: false,
    ignoreWhitespace: false,
    filter: "",
  };
  private generation = 0;
  private fileGeneration = 0;
  private loading = false;
  private error = "";
  private queue: Promise<unknown> = Promise.resolve();
  private disposables: vscode.Disposable[] = [];
  private gitTimer?: ReturnType<typeof setTimeout>;
  private recoveryTimer?: ReturnType<typeof setTimeout>;
  private writing = 0;
  private initialization: Promise<void>;
  private reviews = new ReviewStore();
  private presets = new PresetStore();
  private reviewScope = "";
  private reviewedFiles = new Set<number>();
  private workflowTimer?: ReturnType<typeof setTimeout>;
  private pendingNavigation?: {
    hunk?: number;
    side?: "left" | "right";
    line?: number;
  };
  private relatedTests = new Set<string>();
  private testCache?: {
    root: string;
    at: number;
    files: { path: string; text: string }[];
  };
  constructor(private context: vscode.ExtensionContext) {
    for (const kind of ["compare", "files"] as const)
      this.disposables.push(
        vscode.window.registerWebviewViewProvider(
          "branchlens." + kind,
          {
            resolveWebviewView: (view) => {
              view.webview.options = {
                enableScripts: true,
                localResourceRoots: [
                  vscode.Uri.joinPath(context.extensionUri, "dist"),
                ],
              };
              view.webview.html = html(
                view.webview,
                context.extensionUri,
                kind,
              );
              this.sidebars.add(view.webview);
              view.onDidDispose(() => this.sidebars.delete(view.webview));
              view.webview.onDidReceiveMessage((m) => this.receive(m));
              this.updateSidebar();
            },
          },
          { webviewOptions: { retainContextWhenHidden: true } },
        ),
      );
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer("branchlens.diff", {
        deserializeWebviewPanel: async (panel) => {
          await this.initialization;
          if (!this.doc) {
            panel.dispose();
            return;
          }
          this.bindPanel(panel);
        },
      }),
    );
    for (const action of actions)
      this.disposables.push(
        vscode.commands.registerCommand("branchlens." + action, (value) => {
          this.invalidateComparison(action);
          return this.enqueue(async () => {
            await this.initialization;
            // The webview posts Save after its pending text messages on the same
            // channel, so a fast Ctrl+S cannot save before the last typed edit.
            if (action === "save" && this.panel && this.panelReady) {
              await this.panel.webview.postMessage({
                type: "command",
                action: "save",
              });
              return;
            }
            return this.action(action, value);
          });
        }),
      );
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(
        () => void this.enqueue(() => this.discover()),
      ),
      vscode.workspace.onDidGrantWorkspaceTrust(
        () => void this.enqueue(() => this.discover()),
      ),
    );
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (!this.writing && event.document.uri.scheme === "file")
          void this.enqueue(() => this.syncDocument(event.document));
      }),
    );
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme === "file")
          void this.enqueue(async () => {
            await this.syncDocument(document);
            await this.sendStatus();
          });
      }),
    );
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    const changed = (uri: vscode.Uri) => {
      if (this.repository && this.relative(uri) !== undefined && !this.writing)
        this.gitChanged();
    };
    watcher.onDidCreate(changed);
    watcher.onDidDelete(changed);
    watcher.onDidChange(changed);
    this.disposables.push(watcher);
    const git = vscode.extensions.getExtension<any>("vscode.git");
    void Promise.resolve(git?.activate())
      .then(() => {
        if (!git) return;
        const api = git.exports.getAPI(1);
        for (const r of api.repositories)
          this.disposables.push(r.state.onDidChange(() => this.gitChanged()));
        this.disposables.push(
          api.onDidOpenRepository((r: any) => {
            this.disposables.push(r.state.onDidChange(() => this.gitChanged()));
            void this.enqueue(() => this.discover());
          }),
        );
      })
      .catch((e) => this.report(e));
    this.initialization = this.discover().catch((e) => this.report(e));
  }
  private enqueue(fn: () => Promise<unknown> | unknown) {
    this.queue = this.queue.then(fn).catch((e) => this.report(e));
    return this.queue;
  }
  private invalidateComparison(action: string) {
    if (
      this.loading &&
      ["repository", "left", "compare", "refresh", "upstream"].includes(action)
    )
      this.generation++;
  }
  private receive(message: unknown, panel?: vscode.WebviewPanel) {
    if (!validateMessage(message) || (panel && panel !== this.panel)) return;
    const m = message as any;
    if (m.type === "action") this.invalidateComparison(m.action);
    return this.enqueue(async () => {
      await this.initialization;
      if (panel && panel !== this.panel) return;
      if (m.type === "ready") {
        if (panel) this.panelReady = true;
        this.updateSidebar();
        await this.showFile();
      } else if (m.type === "action") {
        if (
          panel &&
          m.sessionId !== undefined &&
          this.doc &&
          (m.sessionId !== this.doc.session.id ||
            (m.fileKey !== undefined
              ? m.fileKey !== this.fileKey(this.doc.drafts.get(this.doc.active))
              : m.index !== this.doc.active))
        )
          return;
        if (
          [
            "reviewFile",
            "reviewHunk",
            "addNote",
            "deleteNote",
            "stageHunk",
            "unstageHunk",
          ].includes(m.action)
        ) {
          const active = await this.pair();
          if (
            !(active instanceof DraftPair) ||
            !this.doc ||
            !matchesDraftTarget(
              m,
              this.doc.session.id,
              this.doc.active,
              active.version,
              this.fileKey(active),
            )
          ) {
            await this.showFile();
            throw new Error(
              "The file changed. Retry using the updated review or staging selection.",
            );
          }
        }
        await this.action(m.action, m.value);
      } else await this.edit(m);
    });
  }
  private report(e: unknown) {
    this.error = e instanceof Error ? e.message : String(e);
    this.updateSidebar();
    void this.panel?.webview.postMessage({
      type: "error",
      message: this.error,
    });
    void vscode.window.showErrorMessage("BranchWeave: " + this.error);
  }
  private async discover() {
    if (!vscode.workspace.isTrusted) {
      this.error = "Trust this workspace to allow local Git commands.";
      this.updateSidebar();
      return;
    }
    this.repositories = await GitRepository.discover(
      (vscode.workspace.workspaceFolders || [])
        .filter((f) => f.uri.scheme === "file")
        .map((f) => f.uri.fsPath),
    );
    if (!this.repository && this.repositories.length) {
      const preferred =
        this.context.workspaceState.get<string>("latestRepository");
      await this.selectRepository(
        this.repositories.find((r) => r.root === preferred) ||
          this.repositories[0],
      );
    }
    this.updateSidebar();
  }
  private async selectRepository(repo: GitRepository) {
    this.repository = repo;
    const branches = await repo.branches();
    const current = await repo.currentBranch();
    const saved = this.context.workspaceState.get<Settings>(
      "repo:" + repo.root,
    );
    this.settings = {
      left: branches.some((b) => b.name === "development")
        ? "development"
        : branches.find((b) => !b.current && !b.remote)?.name ||
          (current.startsWith("detached:") ? "HEAD" : current),
      right: current,
      includeUpstream: false,
      highlight: true,
      flat: false,
      focusMode: false,
      ignoreWhitespace: false,
      filter: "",
      ...saved,
    };
    this.settings.right = current;
    this.presets = new PresetStore(
      this.context.workspaceState.get("presets:" + repo.root),
    );
    this.testCache = undefined;
    this.relatedTests.clear();
    this.doc = undefined;
    const recovery =
      this.context.workspaceState.get<string>(
        "liveSession:" + repo.root + ":" + current,
      ) || this.context.workspaceState.get<string>("liveSession:" + repo.root);
    if (recovery)
      try {
        const restored = ComparisonState.parse(recovery);
        if (
          restored.session.rightRef === current &&
          restored.session.leftRef === this.settings.left &&
          restored.session.includeUpstream === this.settings.includeUpstream
        )
          this.doc = restored;
      } catch {
        /* Old or unavailable recovery data does not block a fresh comparison. */
      }
    this.error = "";
    await this.loadReviewScope();
    if (this.doc) await this.refreshReviewProgress();
    this.updateSidebar();
  }
  private async persist() {
    if (this.repository) {
      await this.context.workspaceState.update(
        "repo:" + this.repository.root,
        this.settings,
      );
      await this.context.workspaceState.update(
        "latestRepository",
        this.repository.root,
      );
    }
    this.updateSidebar();
  }
  private scheduleSave() {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(
      () => void this.persistSession().catch((e) => this.report(e)),
      400,
    );
  }
  private async persistSession() {
    const d = this.doc;
    if (d)
      await this.context.workspaceState.update(
        "liveSession:" + d.session.root + ":" + d.session.rightRef,
        d.serialize(),
      );
  }
  async flush() {
    clearTimeout(this.recoveryTimer);
    await this.queue;
    await this.persistSession();
    await this.persistReview();
  }
  private updateSidebar() {
    for (const w of this.sidebars)
      void w.postMessage({
        type: "state",
        repos: this.repositories.map((r) => r.root),
        root: this.repository?.root,
        settings: this.settings,
        files:
          this.doc?.session.root === this.repository?.root
            ? this.doc?.session.files
            : [],
        session: this.doc?.session.id,
        active: this.doc?.active,
        loading: this.loading,
        error: this.error,
        rightWorkingTree: true,
        currentBranch: this.settings.right,
        presets: this.presets.list(),
        reviewedFiles: [...this.reviewedFiles],
        reviewProgress: {
          reviewed: this.reviewedFiles.size,
          total: this.doc?.session.files.length || 0,
        },
      });
  }
  private async canReplace() {
    if (
      !this.doc ||
      ![...this.doc.drafts.values()].some((p) => p.dirty("left"))
    )
      return true;
    const result = await vscode.window.showWarningMessage(
      "Replace the modified reference previews? Your current working-file changes will remain in their real editor buffers.",
      { modal: true },
      "Replace reference previews",
    );
    return result === "Replace reference previews";
  }
  private bindPanel(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panelReady = false;
    panel.title =
      "BranchWeave · " + (this.doc?.session.rightRef || "Current branch");
    panel.iconPath = vscode.Uri.joinPath(
      this.context.extensionUri,
      "media",
      "branchlens.svg",
    );
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    panel.webview.html = html(
      panel.webview,
      this.context.extensionUri,
      "editor",
    );
    panel.webview.onDidReceiveMessage((m) => this.receive(m, panel));
    panel.onDidChangeViewState(() => {
      void vscode.commands.executeCommand(
        "setContext",
        "branchlens.active",
        Boolean(this.panel?.active),
      );
      if (panel.active) void this.enqueue(() => this.showFile());
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.generation++;
        this.fileGeneration++;
        this.panel = undefined;
        this.panelReady = false;
      }
      void this.persistSession();
      void vscode.commands.executeCommand(
        "setContext",
        "branchlens.active",
        Boolean(this.panel?.active),
      );
    });
    void vscode.commands.executeCommand(
      "setContext",
      "branchlens.active",
      panel.active,
    );
  }
  private ensurePanel() {
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        "branchlens.diff",
        "BranchWeave",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, "dist"),
          ],
        },
      );
      this.bindPanel(panel);
    } else this.panel.reveal(undefined, true);
  }
  private async compare(automatic = false) {
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this workspace before comparing branches.");
    if (!this.repository || !this.settings.left)
      throw new Error("Select a repository and reference branch first.");
    if (!automatic && !(await this.canReplace())) return false;
    if (!automatic) this.testCache = undefined;
    const token = ++this.generation;
    this.fileGeneration++;
    this.loading = true;
    this.error = "";
    this.updateSidebar();
    try {
      const old = this.doc;
      const oldPath =
        old?.drafts.get(old.active)?.current.right.path ||
        old?.session.files[old.active]?.newPath ||
        old?.pinned?.newPath;
      const session = await this.repository.compareWorking(
        this.settings.left,
        this.settings.includeUpstream,
        workingBufferContents(this.repository.root),
      );
      if (token !== this.generation) return false;
      if (
        automatic &&
        old &&
        old.session.leftSha === session.leftSha &&
        old.session.rightRef === session.rightRef
      )
        session.id = old.session.id;
      const drafts = new Map<number, DraftPair>();
      if (
        automatic &&
        old &&
        old.session.leftSha === session.leftSha &&
        old.session.rightRef === session.rightRef
      ) {
        for (const [i, pair] of old.drafts) {
          const f =
            old.session.files[i] || (i === old.active ? old.pinned : undefined);
          if (!f) continue;
          const next = session.files.findIndex(
            (n) =>
              n.oldPath === f.oldPath && n.newPath === pair.current.right.path,
          );
          if (next >= 0) drafts.set(next, pair);
        }
      }
      let active = session.files.findIndex((f) => f.newPath === oldPath);
      let pinned: ChangedFile | undefined;
      if (
        automatic &&
        active < 0 &&
        old &&
        old.session.leftSha === session.leftSha &&
        old.session.rightRef === session.rightRef
      ) {
        const pair = old.drafts.get(old.active);
        const file = old.session.files[old.active] || old.pinned;
        if (pair && file) {
          active = session.files.length;
          pinned = { ...file, newPath: pair.current.right.path };
          drafts.set(active, pair);
        }
      }
      this.doc = new ComparisonState(
        session,
        drafts,
        Math.max(0, active),
        pinned,
      );
      this.settings.right = session.rightRef;
      await this.loadReviewScope();
      await this.refreshReviewProgress();
      await this.persist();
      await this.persistSession();
      if (!automatic) this.ensurePanel();
      if (this.panel) {
        this.panel.title = "BranchWeave · " + session.rightRef;
        await this.showFile();
      }
      return true;
    } finally {
      this.loading = false;
      this.updateSidebar();
    }
  }
  private relative(uri: vscode.Uri) {
    if (!this.repository || uri.scheme !== "file") return;
    const relative = path
      .relative(this.repository.root, uri.fsPath)
      .split(path.sep)
      .join("/");
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith("../") ||
      path.isAbsolute(relative) ||
      relative.split("/").some((p) => p.toLowerCase() === ".git")
    )
      return;
    return relative;
  }
  private rightUnsaved(pair?: DraftPair) {
    if (!pair || !this.doc) return false;
    const absolute = path.resolve(
      this.doc.session.root,
      pair.current.right.path,
    );
    return vscode.workspace.textDocuments.some(
      (d) =>
        d.uri.scheme === "file" &&
        path.resolve(d.uri.fsPath).toLowerCase() === absolute.toLowerCase() &&
        d.isDirty,
    );
  }
  private async readRight(
    repo: GitRepository,
    filename: string,
  ): Promise<Snapshot> {
    const disk = await repo.readWorkingFile(filename);
    if (disk.reason) return disk;
    const buffers = workingBufferContents(repo.root);
    return buffers.has(filename)
      ? {
          ...disk,
          exists: true,
          text: buffers.get(filename)!,
          mode: disk.mode || "100644",
        }
      : disk;
  }
  private async pair() {
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust the workspace before loading Git snapshots.");
    const d = this.doc;
    if (!d) return;
    const index = d.active;
    const session = d.session;
    const f =
      session.files[index] || (index === d.active ? d.pinned : undefined);
    if (!f) return;
    const repo =
      this.repository?.root === session.root
        ? this.repository
        : new GitRepository(session.root);
    let pair = d.drafts.get(index);
    if (pair) {
      const actual = await this.readRight(repo, pair.current.right.path);
      if (actual.reason)
        return {
          unsupported: actual.reason,
          left: pair.current.left,
          right: { ...actual, path: pair.current.right.path },
        };
      const content = {
        exists: actual.exists,
        text: actual.text,
        path: pair.current.right.path,
        mode: actual.mode,
      };
      if (!this.sameContent(pair.current.right, content)) {
        pair.setContent("right", content);
        this.scheduleSave();
      }
      return pair;
    }
    const [left, right] = await Promise.all([
      repo.readFile(session.leftSha, f.oldPath),
      this.readRight(repo, f.newPath),
    ]);
    if (d.session !== session) return;
    if (left.reason || right.reason)
      return {
        unsupported: [left.reason, right.reason].filter(Boolean).join(" · "),
        left: { ...left, path: f.oldPath },
        right: { ...right, path: f.newPath },
      };
    pair = new DraftPair(
      {
        exists: left.exists,
        text: left.text,
        path: f.oldPath,
        mode: left.mode,
      },
      {
        exists: right.exists,
        text: right.text,
        path: f.newPath,
        mode: right.mode,
      },
    );
    d.drafts.set(index, pair);
    return pair;
  }
  private sameContent(a: DraftContent, b: DraftContent) {
    return (
      a.exists === b.exists &&
      a.text === b.text &&
      a.path === b.path &&
      (a.mode || "100644") === (b.mode || "100644")
    );
  }
  private fileKey(pair?: DraftPair) {
    return pair
      ? JSON.stringify([pair.original.left.path, pair.original.right.path])
      : undefined;
  }
  private async loadReviewScope() {
    if (!this.repository) return;
    const session =
      this.doc?.session.root === this.repository.root
        ? this.doc.session
        : undefined;
    const scope =
      "review:" +
      JSON.stringify([
        this.repository.root,
        session?.rightRef ?? this.settings.right,
        session?.leftRef ?? this.settings.left,
        session?.includeUpstream ?? this.settings.includeUpstream,
      ]);
    if (scope === this.reviewScope) return;
    await this.persistReview();
    this.reviewScope = scope;
    this.reviews = new ReviewStore(this.context.workspaceState.get(scope));
    this.reviewedFiles.clear();
  }
  private async persistReview() {
    if (this.reviewScope)
      await this.context.workspaceState.update(
        this.reviewScope,
        this.reviews.serialize(),
      );
  }
  private reviewKey(index: number): string {
    const d = this.doc!,
      pair = d.drafts.get(index),
      file = d.session.files[index] || d.pinned;
    return pair
      ? this.fileKey(pair)!
      : JSON.stringify([file.oldPath, file.newPath]);
  }
  private snapshot(pair: DraftPair): ReviewSnapshot {
    return { ...pair.current, hunks: pair.hunks() };
  }
  private async snapshotAt(index: number): Promise<ReviewSnapshot | undefined> {
    const d = this.doc,
      repo = this.repository;
    if (!d || !repo) return;
    const file =
      d.session.files[index] || (index === d.active ? d.pinned : undefined);
    if (!file) return;
    const cached = d.drafts.get(index)?.current;
    const [left, right] = await Promise.all([
      cached
        ? Promise.resolve(cached.left)
        : repo.readFile(d.session.leftSha, file.oldPath),
      this.readRight(repo, cached?.right.path || file.newPath),
    ]);
    if ((left as Snapshot).reason || right.reason) return;
    const pair = new DraftPair(
      { ...left, path: cached?.left.path || file.oldPath },
      { ...right, path: cached?.right.path || file.newPath },
    );
    return this.snapshot(pair);
  }
  private async refreshReviewProgress() {
    const d = this.doc;
    this.reviewedFiles.clear();
    if (!d) return;
    for (let i = 0; i < d.session.files.length; i++) {
      const key = this.reviewKey(i);
      if (!this.reviews.hasReviewed(key)) continue;
      const snapshot = await this.snapshotAt(i);
      if (d !== this.doc) return;
      if (
        snapshot &&
        this.reviews.matchesFile(key, snapshotFingerprint(snapshot))
      )
        this.reviewedFiles.add(i);
    }
  }
  private reviewView(pair: DraftPair): ReviewView {
    const view = this.reviews.inspect(
      this.reviewKey(this.doc!.active),
      this.snapshot(pair),
    );
    if (this.doc!.active < this.doc!.session.files.length) {
      if (view.reviewed) this.reviewedFiles.add(this.doc!.active);
      else this.reviewedFiles.delete(this.doc!.active);
    }
    return {
      ...view,
      filesReviewed: this.reviewedFiles.size,
      totalFiles: this.doc!.session.files.length,
    };
  }
  private async candidateTests() {
    const repo = this.repository;
    if (!repo) return [];
    if (
      this.testCache?.root === repo.root &&
      Date.now() - this.testCache.at < 5000
    )
      return this.testCache.files;
    const pattern = "**/{*.test,*.spec}.{ts,tsx,js,jsx,mjs,cjs}";
    const directories =
      "**/{__tests__,tests,test}/**/*.{ts,tsx,js,jsx,mjs,cjs}";
    const exclude =
      "**/{node_modules,.git,dist,out,build,coverage,.test-host}/**";
    const found = [
      ...(await vscode.workspace.findFiles(
        new vscode.RelativePattern(repo.root, pattern),
        exclude,
        200,
      )),
      ...(await vscode.workspace.findFiles(
        new vscode.RelativePattern(repo.root, directories),
        exclude,
        200,
      )),
    ];
    const files: { path: string; text: string }[] = [],
      seen = new Set<string>();
    let budget = 2 * 1024 * 1024;
    for (const uri of found) {
      const relative = path
        .relative(repo.root, uri.fsPath)
        .split(path.sep)
        .join("/");
      if (seen.has(relative) || files.length >= 200 || budget <= 0) continue;
      seen.add(relative);
      try {
        const safe = await safeApplyPath(repo.root, relative);
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(safe));
        if (stat.size > Math.min(128 * 1024, budget)) continue;
        const snapshot = await this.readRight(repo, relative);
        if (snapshot.reason || !snapshot.exists) continue;
        budget -= Buffer.byteLength(snapshot.text, "utf8");
        files.push({ path: relative, text: snapshot.text });
      } catch {
        /* Unsafe or disappearing test candidates are not opened. */
      }
    }
    this.testCache = { root: repo.root, at: Date.now(), files };
    return files;
  }
  private async workflowState(
    pair: DraftPair,
  ): Promise<{ review: ReviewView; staging: StagingView; impact: ImpactView }> {
    const snapshot = this.snapshot(pair);
    const [staging, candidates] = await Promise.all([
      readStagingState(
        this.doc!.session.root,
        snapshot.right.path,
        snapshot.right,
      ),
      this.candidateTests(),
    ]);
    staging.bufferUnsaved = staging.bufferUnsaved || this.rightUnsaved(pair);
    const impact = analyzeImpact(
      snapshot.right.path,
      snapshot.left.text,
      snapshot.right.text,
      snapshot.hunks,
      candidates,
    );
    this.relatedTests = new Set(impact.tests.map((test) => test.path));
    return { review: this.reviewView(pair), staging, impact };
  }
  private scheduleWorkflow() {
    clearTimeout(this.workflowTimer);
    this.workflowTimer = setTimeout(
      () => void this.enqueue(() => this.showFile()),
      350,
    );
  }
  private updateCounts(pair: DraftPair) {
    const f =
      this.doc && (this.doc.session.files[this.doc.active] || this.doc.pinned);
    if (!f) return;
    const { left, right } = pair.current;
    f.newPath = right.path;
    f.additions = 0;
    f.deletions = 0;
    for (const change of diffLines(left.text, right.text)) {
      if (change.added) f.additions += change.count || 0;
      if (change.removed) f.deletions += change.count || 0;
    }
    f.status = !left.exists
      ? "A"
      : !right.exists
        ? "D"
        : left.path !== right.path
          ? "R"
          : "M";
    this.updateSidebar();
  }
  private async showFile() {
    const d = this.doc;
    const panel = this.panel;
    if (!d || !panel || !this.panelReady) return;
    const generation = ++this.fileGeneration,
      index = d.active;
    const result = await this.pair();
    if (
      generation !== this.fileGeneration ||
      d !== this.doc ||
      index !== d.active ||
      panel !== this.panel ||
      !this.panelReady
    )
      return;
    const session = d.session,
      file = session.files[index] || d.pinned;
    if (!file) {
      await panel.webview.postMessage({
        type: "file",
        sessionId: session.id,
        index: 0,
        total: 0,
        path: "No changed files",
        left: { text: "", path: "", exists: false },
        right: { text: "", path: "", exists: false },
        leftLabel: session.leftRef,
        rightLabel: session.rightRef + " · current working tree",
        rightWorkingTree: true,
        version: 0,
        hunks: [],
        unsupported:
          "No changed files. Working-tree and unsaved changes will appear here when you edit a file.",
        highlight: this.settings.highlight,
        focusMode: this.settings.focusMode,
        ignoreWhitespace: this.settings.ignoreWhitespace,
      });
      return;
    }
    const pair = result instanceof DraftPair ? result : undefined;
    const contents = pair?.current || (result as any);
    if (!contents) return;
    const workflow = pair ? await this.workflowState(pair) : undefined;
    if (
      generation !== this.fileGeneration ||
      d !== this.doc ||
      index !== d.active ||
      panel !== this.panel
    )
      return;
    const pendingNavigation = this.pendingNavigation;
    this.pendingNavigation = undefined;
    await panel.webview.postMessage({
      type: "file",
      sessionId: session.id,
      index,
      fileKey: this.fileKey(pair),
      total: session.files.length,
      filePosition:
        d.pinned && index === session.files.length
          ? "Working file · no remaining branch differences"
          : undefined,
      path:
        file.status === "R"
          ? file.oldPath + " → " + file.newPath
          : file.newPath,
      left: contents.left,
      right: contents.right,
      leftLabel: session.includeUpstream
        ? `${session.leftRef} · ${session.leftSha.slice(0, 8)}`
        : `Merge base (${session.leftRef} ↔ ${session.rightRef}) · ${session.leftSha.slice(0, 8)}`,
      rightLabel: `${session.rightRef} · current working tree`,
      rightWorkingTree: true,
      rightUnsaved: this.rightUnsaved(pair),
      leftDirty: pair?.dirty("left"),
      rightDirty: pair?.dirty("right"),
      version: pair?.version || 0,
      hunks: pair?.hunks() || [],
      dirty: pair?.dirty(),
      unsupported: (result as any)?.unsupported,
      highlight: this.settings.highlight,
      focusMode: this.settings.focusMode,
      ignoreWhitespace: this.settings.ignoreWhitespace,
      pendingNavigation,
      ...workflow,
    });
    this.updateSidebar();
  }
  private async sendStatus() {
    if (!this.doc) return;
    const pair = this.doc.drafts.get(this.doc.active);
    await this.panel?.webview.postMessage({
      type: "globalstatus",
      sessionId: this.doc.session.id,
      index: this.doc.active,
      rightUnsaved: this.rightUnsaved(pair),
      leftDirty: pair?.dirty("left"),
    });
  }
  private async syncDocument(document: vscode.TextDocument) {
    const relative = this.relative(document.uri);
    if (relative === undefined || !this.doc || this.writing) return;
    this.testCache = undefined;
    let found = false;
    for (const [index, pair] of this.doc.drafts) {
      if (pair.current.right.path !== relative) continue;
      found = true;
      if (
        pair.current.right.text !== document.getText() ||
        !pair.current.right.exists
      ) {
        pair.setContent("right", {
          ...pair.current.right,
          exists: true,
          text: document.getText(),
        });
        this.scheduleSave();
        if (index === this.doc.active) {
          this.updateCounts(pair);
          await this.showFile();
        }
      }
    }
    if (!found) this.gitChanged();
    await this.sendStatus();
  }
  private async mutate(pair: DraftPair, change: () => void) {
    const d = this.doc!;
    const before = pair.current.right,
      backup = pair.serialize();
    try {
      change();
      const after = pair.current.right;
      if (!this.sameContent(before, after)) {
        this.writing++;
        try {
          await writeWorkingFile(
            new GitRepository(d.session.root),
            d.session,
            before,
            after,
          );
        } finally {
          this.writing--;
        }
      }
      this.error = "";
      this.updateCounts(pair);
      this.scheduleSave();
    } catch (error) {
      d.drafts.set(d.active, DraftPair.restore(backup));
      await this.showFile();
      if (error instanceof LiveConflict) {
        await showConflict(
          new ApplyConflict(
            error.message,
            error.filePath,
            error.actual,
            error.draft,
          ),
        );
        return false;
      }
      throw error;
    }
    return true;
  }
  private async edit(m: any) {
    const d = this.doc;
    if (
      !d ||
      m.sessionId !== d.session.id ||
      (m.fileKey !== undefined
        ? m.fileKey !== this.fileKey(d.drafts.get(d.active))
        : m.index !== d.active)
    ) {
      await this.showFile();
      return;
    }
    const pair = await this.pair();
    if (!(pair instanceof DraftPair))
      throw new Error("This content cannot be edited.");
    if (
      !matchesDraftTarget(
        m,
        d.session.id,
        d.active,
        pair.version,
        this.fileKey(pair),
      )
    ) {
      await this.showFile();
      throw new Error(
        "The working file changed. Retry using the updated comparison.",
      );
    }
    if (
      !(await this.mutate(pair, () => {
        if (m.action === "edit") pair.setText(m.side, m.text, m.version);
        else if (m.action === "undo") pair.undo();
        else if (m.action === "redo") pair.redo();
        else if (m.action === "transferHunk")
          pair.transferHunk(m.side, m.hunk, m.version);
        else if (m.action === "transferLine")
          pair.transferLine(m.side, m.line, m.version);
      }))
    )
      return;
    if (m.action === "edit") {
      const review = this.reviewView(pair);
      await this.panel?.webview.postMessage({
        type: "edited",
        sessionId: d.session.id,
        index: d.active,
        version: pair.version,
        hunks: pair.hunks(),
        dirty: pair.dirty(),
        leftDirty: pair.dirty("left"),
        rightUnsaved: this.rightUnsaved(pair),
        review,
        staging: {
          token: "",
          staged: [],
          unstaged: [],
          bufferUnsaved: this.rightUnsaved(pair),
          error: "Updating index changes…",
        },
        impact: analyzeImpact(
          pair.current.right.path,
          pair.current.left.text,
          pair.current.right.text,
          pair.hunks(),
          this.testCache?.files || [],
        ),
      });
      this.updateSidebar();
      this.scheduleWorkflow();
      return;
    }
    await this.showFile();
  }
  private async workflowAction(action: Action, value?: any) {
    if (action === "filter") {
      this.settings.filter = value;
      if (this.repository)
        await this.context.workspaceState.update(
          "repo:" + this.repository.root,
          this.settings,
        );
      return;
    }
    if (action === "focusMode" || action === "ignoreWhitespace") {
      this.settings[action] =
        typeof value === "boolean" ? value : !this.settings[action];
      await this.persist();
      await this.showFile();
      return;
    }
    if (["savePreset", "loadPreset", "deletePreset"].includes(action)) {
      if (!this.repository)
        throw new Error("Choose a repository before managing presets.");
      if (action === "savePreset") {
        const name =
          typeof value === "string"
            ? value
            : await vscode.window.showInputBox({
                title: "Save comparison preset",
                prompt:
                  "Name for this repository's reference, display options and path filter",
                validateInput: (text) =>
                  !text.trim() || text.length > 80
                    ? "Enter 1–80 characters."
                    : undefined,
              });
        if (!name) return;
        this.presets.save(name, { ...this.settings });
      } else {
        const list = this.presets.list();
        const id =
          typeof value === "string"
            ? value
            : (
                await vscode.window.showQuickPick(
                  list.map((p) => ({
                    label: p.name,
                    description: p.left,
                    id: p.id,
                  })),
                  {
                    title:
                      action === "loadPreset"
                        ? "Load comparison preset"
                        : "Delete comparison preset",
                  },
                )
              )?.id;
        if (!id) return;
        const preset = list.find((p) => p.id === id || p.name === id);
        if (!preset) throw new Error("This preset no longer exists.");
        if (action === "deletePreset") this.presets.remove(preset.id);
        else {
          const before = { ...this.settings };
          const { id: _id, name: _name, ...settings } = preset;
          this.settings = { ...this.settings, ...settings };
          try {
            if (!(await this.compare())) {
              this.settings = before;
              await this.persist();
              return;
            }
          } catch (error) {
            this.settings = before;
            await this.persist();
            throw error;
          }
          await this.persist();
        }
      }
      await this.context.workspaceState.update(
        "presets:" + this.repository.root,
        this.presets.serialize(),
      );
      this.updateSidebar();
      return;
    }
    if (!this.doc || !this.repository)
      throw new Error("Open a comparison before using review tools.");
    await this.loadReviewScope();
    if (action === "exportReview") {
      const d = this.doc;
      const files: { path: string; review: ReviewView }[] = [];
      const included = new Set<string>();
      for (let i = 0; i < d.session.files.length; i++) {
        const snapshot = await this.snapshotAt(i);
        if (snapshot) {
          const key = this.reviewKey(i);
          included.add(key);
          files.push({
            path: d.session.files[i].newPath,
            review: this.reviews.inspect(key, snapshot),
          });
        }
      }
      const archivedNotes = this.reviews
        .storedNotes()
        .filter((entry) => !included.has(entry.key))
        .map((entry) => {
          let filename = entry.key;
          try {
            const paths = JSON.parse(entry.key);
            if (Array.isArray(paths) && typeof paths[1] === "string")
              filename = paths[1];
          } catch {
            /* Retain legacy note identities as plain report text. */
          }
          return { path: filename, notes: entry.notes };
        });
      const report = exportReviewMarkdown({
        reference: d.session.leftRef,
        current: d.session.rightRef,
        files,
        archivedNotes,
      });
      const document = await vscode.workspace.openTextDocument({
        content: report,
        language: "markdown",
      });
      await vscode.window.showTextDocument(document, { preview: false });
      return;
    }
    if (action === "nextUnreviewed") {
      await this.refreshReviewProgress();
      const d = this.doc;
      const active = await this.pair();
      if (active instanceof DraftPair) {
        const reviewed = this.reviewView(active);
        const hunk = active
          .hunks()
          .findIndex((_, index) => !reviewed.reviewedHunks.includes(index));
        if (hunk >= 0) {
          this.pendingNavigation = { hunk };
          await this.showFile();
          return;
        }
      }
      const count = d.session.files.length;
      for (let offset = 1; offset <= count; offset++) {
        const index = (Math.min(d.active, count - 1) + offset) % count;
        if (this.reviewedFiles.has(index)) continue;
        d.active = index;
        d.pinned = undefined;
        this.pendingNavigation = { hunk: 0 };
        this.ensurePanel();
        await this.showFile();
        return;
      }
      await vscode.window.showInformationMessage(
        "All current changed files have been reviewed.",
      );
      return;
    }
    if (action === "openRelatedTest") {
      const selected =
        typeof value === "string"
          ? value
          : await vscode.window.showQuickPick([...this.relatedTests], {
              title: "Candidate related tests",
            });
      if (!selected) return;
      if (!this.relatedTests.has(selected))
        throw new Error(
          "Refresh the impact list before opening this test candidate.",
        );
      const safe = await safeApplyPath(this.repository.root, selected);
      await vscode.window.showTextDocument(vscode.Uri.file(safe), {
        preview: true,
      });
      return;
    }
    const pair = await this.pair();
    if (!(pair instanceof DraftPair))
      throw new Error(
        "Review and staging tools require supported text content.",
      );
    const key = this.reviewKey(this.doc.active),
      snapshot = this.snapshot(pair);
    if (action === "reviewFile")
      this.reviews.markFile(
        key,
        snapshot,
        typeof value === "boolean"
          ? value
          : !this.reviews.inspect(key, snapshot).reviewed,
      );
    else if (action === "reviewHunk")
      this.reviews.markHunk(key, snapshot, value.index, value.reviewed);
    else if (action === "addNote") {
      const note = value || {
        text: await vscode.window.showInputBox({
          title: "Add local file review note",
          prompt: "1–4000 characters; notes stay local to this workspace",
          validateInput: (text) =>
            !text.trim() || text.length > 4000
              ? "Enter 1–4000 characters."
              : undefined,
        }),
      };
      if (!note.text) return;
      this.reviews.addNote(key, snapshot, note.text, note.hunk);
    } else if (action === "deleteNote") {
      const id =
        value ||
        (
          await vscode.window.showQuickPick(
            this.reviews
              .inspect(key, snapshot)
              .notes.map((note) => ({
                label: note.text.slice(0, 100),
                id: note.id,
              })),
            { title: "Delete local review note" },
          )
        )?.id;
      if (id) this.reviews.deleteNote(key, id);
    } else if (action === "stageHunk" || action === "unstageHunk") {
      let selection = value;
      if (!selection) {
        const staging = await readStagingState(
          this.repository.root,
          snapshot.right.path,
          snapshot.right,
        );
        if (staging.error) throw new Error(staging.error);
        const sections =
          action === "stageHunk" ? staging.unstaged : staging.staged;
        const chosen = await vscode.window.showQuickPick(
          sections.map((section) => ({
            label: section.summary,
            index: section.index,
          })),
          {
            title:
              action === "stageHunk"
                ? "Stage index change section"
                : "Unstage index change section",
          },
        );
        if (!chosen) return;
        selection = { index: chosen.index, token: staging.token };
      }
      const expected = snapshot.right;
      await applyStagingHunk(
        this.repository.root,
        expected.path,
        action === "stageHunk" ? "stage" : "unstage",
        selection.index,
        selection.token,
        expected,
        async () => {
          const actual = await this.readRight(this.repository!, expected.path);
          if (
            actual.reason ||
            !this.sameContent(expected, { ...actual, path: expected.path })
          )
            throw new Error(
              "The live working buffer changed during staging. Refresh and select the section again.",
            );
        },
      );
      await this.compare(true);
      return;
    }
    await this.persistReview();
    this.reviewView(pair);
    this.updateSidebar();
    await this.showFile();
  }
  private async action(action: Action, value?: any) {
    if (action === "reviewHunk" && value === undefined) {
      this.ensurePanel();
      await this.panel?.webview.postMessage({ type: "command", action });
      return;
    }
    if (
      [
        "reviewFile",
        "reviewHunk",
        "nextUnreviewed",
        "addNote",
        "deleteNote",
        "exportReview",
        "focusMode",
        "ignoreWhitespace",
        "filter",
        "savePreset",
        "loadPreset",
        "deletePreset",
        "stageHunk",
        "unstageHunk",
        "openRelatedTest",
      ].includes(action)
    ) {
      await this.workflowAction(action, value);
      return;
    }
    if (action === "focusFiles") {
      await vscode.commands.executeCommand("branchlens.files.focus");
      return;
    }
    if (
      [
        "nextHunk",
        "previousHunk",
        "focusLeft",
        "focusRight",
        "transferLine",
        "transferHunk",
        "undo",
        "redo",
      ].includes(action)
    ) {
      this.ensurePanel();
      await this.panel?.webview.postMessage({ type: "command", action, value });
      return;
    }
    if (action === "repository") {
      const selected = await vscode.window.showQuickPick(
        this.repositories.map((r) => ({ label: r.root, repo: r })),
        { title: "BranchWeave repository" },
      );
      if (
        selected &&
        selected.repo.root !== this.repository?.root &&
        (await this.canReplace())
      ) {
        await this.persistSession();
        await this.selectRepository(selected.repo);
        await this.compare();
      }
      return;
    }
    if (action === "left") {
      if (!this.repository) return;
      const branches = await this.repository.branches();
      const selected = await vscode.window.showQuickPick(
        branches.map((b) => ({
          label: b.name,
          description: b.remote
            ? "remote-tracking"
            : b.current
              ? "current local branch"
              : "local branch",
        })),
        {
          title: "Reference branch",
          matchOnDescription: true,
          placeHolder: "Type to search local and remote-tracking branches",
        },
      );
      if (selected) {
        const old = this.settings.left;
        this.settings.left = selected.label;
        if (!(await this.compare())) this.settings.left = old;
        await this.persist();
      }
      return;
    }
    if (action === "right" || action === "swap") {
      await vscode.window.showInformationMessage(
        "The right side follows the checked-out branch and its working files. Select a reference branch on the left.",
      );
      return;
    }
    if (action === "compare" || action === "refresh") {
      await this.compare();
      return;
    }
    if (action === "upstream") {
      const previous = this.settings.includeUpstream;
      this.settings.includeUpstream =
        typeof value === "boolean" ? value : !previous;
      if (!(await this.compare())) this.settings.includeUpstream = previous;
      await this.persist();
      return;
    }
    if (action === "highlight" || action === "flat") {
      this.settings[action] =
        typeof value === "boolean" ? value : !this.settings[action];
      await this.persist();
      if (action === "highlight") await this.showFile();
      return;
    }
    if (
      action === "open" ||
      action === "nextFile" ||
      action === "previousFile"
    ) {
      if (!this.doc) return;
      const n = this.doc.session.files.length;
      if (!n) return;
      this.doc.active =
        action === "open"
          ? Math.min(value, n - 1)
          : this.doc.active >= n
            ? action === "nextFile"
              ? 0
              : n - 1
            : (this.doc.active + (action === "nextFile" ? 1 : -1) + n) % n;
      this.doc.pinned = undefined;
      this.ensurePanel();
      await this.showFile();
      this.scheduleSave();
      return;
    }
    const pair = await this.pair();
    if (!(pair instanceof DraftPair) || !this.doc) return;
    const side: Side = value === "left" ? "left" : "right";
    if (action === "save" || (action === "apply" && side === "right")) {
      if (pair.current.right.exists) {
        await saveWorkingFile(
          new GitRepository(this.doc.session.root),
          this.doc.session,
          pair.current.right.path,
        );
        await this.sendStatus();
      }
      return;
    }
    if (action === "reset") {
      if (
        pair.dirty(side) &&
        (await vscode.window.showWarningMessage(
          `Reset ${side === "right" ? "the working file" : "the reference preview"} to its opening content?`,
          { modal: true },
          "Reset",
        )) === "Reset"
      ) {
        if (await this.mutate(pair, () => pair.reset(side)))
          await this.showFile();
      }
      return;
    }
    if (action === "export") {
      const uri = await vscode.window.showSaveDialog({
        filters: { "Git patch": ["patch"] },
        defaultUri: vscode.Uri.file("branchlens-" + side + ".patch"),
      });
      if (uri)
        await vscode.workspace.fs.writeFile(uri, Buffer.from(pair.patch(side)));
      return;
    }
    if (action === "fileOperation") {
      const operation = await vscode.window.showQuickPick(
        ["Create empty file", "Delete file", "Rename file"],
        {
          title:
            side === "right"
              ? "Current working file operation"
              : "Reference preview file operation",
        },
      );
      if (!operation) return;
      const content = pair.current[side];
      let next: DraftContent;
      if (operation === "Rename file") {
        const filename = await vscode.window.showInputBox({
          title: "New repository-relative path",
          value: content.path,
        });
        if (!filename) return;
        next = { ...content, path: filename };
      } else if (operation === "Delete file") {
        if (
          side === "right" &&
          (await vscode.window.showWarningMessage(
            `Delete working file ${content.path}?`,
            { modal: true },
            "Delete file",
          )) !== "Delete file"
        )
          return;
        next = { ...content, exists: false, text: "" };
      } else {
        if (
          content.exists &&
          content.text &&
          (await vscode.window.showWarningMessage(
            "Replace this content with an empty file?",
            { modal: true },
            "Replace",
          )) !== "Replace"
        )
          return;
        next = { ...content, exists: true, text: "", mode: "100644" };
      }
      if (await this.mutate(pair, () => pair.setContent(side, next)))
        await this.showFile();
      return;
    }
    if (action === "apply") {
      if (!vscode.workspace.isTrusted)
        throw new Error(
          "Trust the workspace before applying reference drafts.",
        );
      await applyDraft(
        new GitRepository(this.doc.session.root),
        this.doc.session,
        pair,
        "left",
      );
    }
  }
  private gitChanged() {
    this.testCache = undefined;
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(
      () =>
        void this.enqueue(async () => {
          if (!this.repository || this.writing) return;
          const current = await this.repository.currentBranch();
          this.settings.right = current;
          this.updateSidebar();
          if (!this.doc) return;
          if ([...this.doc.drafts.values()].some((p) => p.dirty("left"))) {
            this.error =
              "Modified reference previews are preserved. Refresh to update the comparison; real working-file buffers will remain intact.";
            this.updateSidebar();
            return;
          }
          await this.compare(true);
        }),
      600,
    );
  }
  dispose() {
    clearTimeout(this.gitTimer);
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.workflowTimer);
    void this.persistSession();
    this.disposables.forEach((d) => d.dispose());
  }
}
let controller: BranchLens | undefined;
export function activate(context: vscode.ExtensionContext) {
  controller = new BranchLens(context);
  context.subscriptions.push(controller);
}
export async function deactivate() {
  await controller?.flush();
}
