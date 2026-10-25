import * as ts from "typescript";
import type { Hunk, Side } from "./draft";
import type {
  ImpactSymbolView,
  ImpactView,
  RelatedTestView,
} from "./workflowTypes";

// Parsing is advisory and deliberately smaller than the editor's draft limit.
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_TESTS = 200;
const MAX_TEST_BYTES = 2 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_SYMBOLS = 1_000;
const MAX_HUNKS = 10_000;
const sourceSuffix = /\.(?:[cm]?[jt]sx?)$/i;
const testSuffix = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const testDirectory = /(?:^|\/)(?:tests?|__tests__)\//i;

type ParsedSymbol = Omit<ImpactSymbolView, "side" | "hunks" | "id"> & {
  start: number;
  end: number;
  parent?: ParsedSymbol;
  text: string;
};

function safePath(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value.includes(":") ||
    [...value].some((char) => char.charCodeAt(0) < 32) ||
    /^(?:[/\\]|[a-z]:)/i.test(value) ||
    value
      .split(/[/\\]/)
      .some(
        (part) =>
          part === ".." ||
          part === "" ||
          part === "." ||
          part.toLowerCase() === ".git",
      )
  ) {
    throw new Error("Impact paths must be safe repository-relative paths.");
  }
  return value.replace(/\\/g, "/");
}

function lineCount(text: string): number {
  let count = text && !text.endsWith("\n") ? 1 : 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

function scriptKind(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  return /\.[cm]?js$/i.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

function parse(path: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(path),
  );
  if (
    (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
      .parseDiagnostics.length
  ) {
    throw new Error("Syntax could not be parsed reliably.");
  }
  return source;
}

/** Iterative traversal caps analysis work and does not resolve or execute imports. */
function visit(source: ts.SourceFile, callback: (node: ts.Node) => void): void {
  const stack: ts.Node[] = [source];
  let count = 0;
  while (stack.length) {
    if (++count > MAX_NODES) throw new Error("Syntax analysis limit reached.");
    const node = stack.pop()!;
    callback(node);
    const children: ts.Node[] = [];
    node.forEachChild((child) => {
      children.push(child);
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
}

function symbols(source: ts.SourceFile): ParsedSymbol[] {
  const result: ParsedSymbol[] = [];
  const byNode = new Map<ts.Node, ParsedSymbol>();
  visit(source, (node) => {
    let kind: string;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
      kind = "class";
    else if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))
      kind = "function";
    else if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    )
      kind = "method";
    else if (ts.isArrowFunction(node)) kind = "arrow";
    else return;
    let owner = node.parent;
    while (owner && !byNode.has(owner)) owner = owner.parent;
    const parent = owner ? byNode.get(owner) : undefined;
    let anchor: ts.Node = node;
    let name = (node as ts.NamedDeclaration).name?.getText(source);
    if (
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassExpression(node)) &&
      (ts.isVariableDeclaration(node.parent) ||
        ts.isPropertyDeclaration(node.parent) ||
        ts.isPropertyAssignment(node.parent))
    ) {
      anchor = node.parent;
      name = node.parent.name.getText(source);
    }
    const start = anchor.getStart(source),
      end = node.getEnd();
    const location = source.getLineAndCharacterOfPosition(start);
    name ??= ts.isConstructorDeclaration(node)
      ? "constructor"
      : `<anonymous@${location.line + 1}:${location.character + 1}>`;
    const symbol: ParsedSymbol = {
      name: `${parent ? parent.name + "." : ""}${name.slice(0, 180)}`,
      kind,
      start,
      end,
      parent,
      startLine: location.line + 1,
      endLine:
        source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1,
      text: source.text.slice(start, end),
    };
    if (result.length >= MAX_SYMBOLS || symbol.name.length > 2048)
      throw new Error("Symbol analysis limit reached.");
    byNode.set(node, symbol);
    result.push(symbol);
  });
  return result;
}

function ancestor(parent: ParsedSymbol, child: ParsedSymbol): boolean {
  for (let current = child.parent; current; current = current.parent)
    if (current === parent) return true;
  return false;
}

/** A hunk belongs to a parent only when it also changes lines outside its children. */
function affected(
  candidates: ParsedSymbol[],
  start: number,
  count: number,
): ParsedSymbol[] {
  if (!count) return [];
  const first = start + 1,
    last = start + count;
  const overlapping = candidates.filter(
    (s) => s.startLine <= last && s.endLine >= first,
  );
  return overlapping.filter((symbol) => {
    const low = Math.max(first, symbol.startLine),
      high = Math.min(last, symbol.endLine);
    const children = overlapping
      .filter((child) => ancestor(symbol, child))
      .sort((a, b) => a.startLine - b.startLine);
    let next = low;
    for (const child of children) {
      if (child.startLine > next) return true;
      next = Math.max(next, child.endLine + 1);
      if (next > high) return false;
    }
    return next <= high;
  });
}

function pairs(
  left: ParsedSymbol[],
  right: ParsedSymbol[],
): Map<ParsedSymbol, ParsedSymbol> {
  const result = new Map<ParsedSymbol, ParsedSymbol>();
  const available = new Set(right);
  // Exact matches first preserve identity when one of several equally named declarations is removed.
  for (const symbol of left) {
    const match = right.find(
      (other) =>
        available.has(other) &&
        other.name === symbol.name &&
        other.kind === symbol.kind &&
        other.text === symbol.text,
    );
    if (match) {
      result.set(symbol, match);
      available.delete(match);
    }
  }
  for (const symbol of left) {
    if (result.has(symbol)) continue;
    const match = right.find(
      (other) =>
        available.has(other) &&
        other.name === symbol.name &&
        other.kind === symbol.kind,
    );
    if (match) {
      result.set(symbol, match);
      available.delete(match);
    }
  }
  return result;
}

function stripExtension(path: string): string {
  return path.replace(sourceSuffix, "");
}

function importsTarget(
  source: ts.SourceFile,
  target: string,
): string | undefined {
  let evidence: string | undefined;
  visit(source, (node) => {
    if (evidence) return;
    let value: ts.Expression | undefined,
      kind = "import";
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      value = node.moduleSpecifier;
    else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    )
      value = node.moduleReference.expression;
    else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      value = node.arguments[0];
      kind =
        node.expression.kind === ts.SyntaxKind.ImportKeyword
          ? "dynamic import"
          : "require";
    }
    if (
      !value ||
      !ts.isStringLiteralLike(value) ||
      !/^\.\.?\//.test(value.text)
    )
      return;
    const segments = source.fileName.split("/").slice(0, -1);
    for (const part of value.text.split("/")) {
      if (part === "..") {
        if (!segments.length) return;
        segments.pop();
      } else if (part !== ".") segments.push(part);
    }
    const resolved = segments.join("/");
    if (
      resolved === target ||
      stripExtension(resolved) === stripExtension(target) ||
      (!sourceSuffix.test(resolved) &&
        stripExtension(target) === `${resolved}/index`)
    )
      evidence = `${kind} ${value.text}`;
  });
  return evidence;
}

function relatedTests(
  filePath: string,
  files: Array<{ path: string; text: string }>,
): { tests: RelatedTestView[]; limited: boolean } {
  const tests: RelatedTestView[] = [],
    seen = new Set<string>();
  let bytes = 0,
    limited = files.length > MAX_TESTS;
  const basename = stripExtension(filePath).split("/").pop();
  for (const file of files.slice(0, MAX_TESTS)) {
    const path = safePath(file.path);
    if (typeof file.text !== "string")
      throw new Error("Invalid impact test text.");
    const namedTest = testSuffix.test(path);
    if (
      path === filePath ||
      seen.has(path) ||
      !sourceSuffix.test(path) ||
      (!namedTest && !testDirectory.test(path))
    )
      continue;
    seen.add(path);
    const size = Buffer.byteLength(file.text, "utf8");
    bytes += size;
    if (size > MAX_SOURCE_BYTES || bytes > MAX_TEST_BYTES) {
      limited = true;
      continue;
    }
    const sameName =
      namedTest && path.replace(testSuffix, "").split("/").pop() === basename;
    if (sameName) {
      tests.push({
        path,
        reason: "Candidate: matching source basename (.test/.spec).",
      });
      continue;
    }
    try {
      const evidence = importsTarget(parse(path, file.text), filePath);
      if (evidence)
        tests.push({ path, reason: `Candidate: relative ${evidence}.` });
    } catch {
      /* Malformed or complex test source provides no reliable import evidence. */
    }
  }
  return { tests, limited };
}

/** Advisory source-only analysis: no file loading, evaluation, or dependency resolution. */
export function analyzeImpact(
  filePath: string,
  leftText: string,
  rightText: string,
  hunks: Hunk[],
  testFiles: Array<{ path: string; text: string }> = [],
): ImpactView {
  filePath = safePath(filePath);
  if (
    typeof leftText !== "string" ||
    typeof rightText !== "string" ||
    !Array.isArray(testFiles) ||
    !Array.isArray(hunks)
  )
    throw new Error("Invalid impact inputs.");
  if (hunks.length > MAX_HUNKS) throw new Error("Impact hunk limit exceeded.");
  const leftLines = lineCount(leftText),
    rightLines = lineCount(rightText);
  for (const hunk of hunks) {
    if (
      !hunk ||
      ![hunk.leftStart, hunk.leftCount, hunk.rightStart, hunk.rightCount].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      hunk.leftStart + hunk.leftCount > leftLines ||
      hunk.rightStart + hunk.rightCount > rightLines
    )
      throw new Error("Invalid impact hunk range.");
  }
  const language = /\.[cm]?tsx?$/i.test(filePath)
    ? "TypeScript"
    : /\.[cm]?jsx?$/i.test(filePath)
      ? "JavaScript"
      : "unsupported";
  const related = relatedTests(filePath, testFiles);
  const result: ImpactView = { symbols: [], tests: related.tests, language };
  const messages: string[] = related.limited
    ? ["Candidate test analysis reached its input limit."]
    : [];
  const groups = new Map<string, ImpactSymbolView>();
  const add = (symbol: ParsedSymbol | undefined, side: Side, index: number) => {
    const id = `${side}:${symbol ? `${symbol.kind}:${symbol.start}:${symbol.end}` : "file"}`;
    let view = groups.get(id);
    if (!view) {
      view = {
        id,
        name: symbol?.name ?? filePath,
        kind: symbol?.kind ?? "file",
        side,
        startLine: symbol?.startLine ?? 1,
        endLine:
          symbol?.endLine ??
          Math.max(1, side === "left" ? leftLines : rightLines),
        hunks: [],
      };
      groups.set(id, view);
    }
    if (!view.hunks.includes(index)) view.hunks.push(index);
  };
  const fallback = (message: string) => {
    messages.push(message);
    hunks.forEach((hunk, index) =>
      add(
        undefined,
        hunk.rightCount || (!hunk.leftCount && rightText) ? "right" : "left",
        index,
      ),
    );
  };
  if (!sourceSuffix.test(filePath))
    fallback("Unsupported language; changes grouped at file level.");
  else if (
    [leftText, rightText].some(
      (text) => Buffer.byteLength(text, "utf8") > MAX_SOURCE_BYTES,
    )
  )
    fallback(
      "Source size exceeds the syntax analysis limit; changes grouped at file level.",
    );
  else {
    try {
      const left = symbols(parse(filePath, leftText)),
        right = symbols(parse(filePath, rightText));
      if ((left.length + right.length) * hunks.length > 500_000)
        throw new Error("Symbol matching limit reached.");
      const matches = pairs(left, right),
        reverse = new Map([...matches].map(([a, b]) => [b, a]));
      hunks.forEach((hunk, index) => {
        let represented = false;
        for (const symbol of affected(
          right,
          hunk.rightStart,
          hunk.rightCount,
        )) {
          if (reverse.get(symbol)?.text === symbol.text) continue;
          add(symbol, "right", index);
          represented = true;
        }
        for (const symbol of affected(left, hunk.leftStart, hunk.leftCount)) {
          const current = matches.get(symbol);
          if (current?.text === symbol.text) continue;
          add(current ?? symbol, current ? "right" : "left", index);
          represented = true;
        }
        // File groups also preserve top-level parts of a hunk containing a symbol edit.
        const uncovered = (
          list: ParsedSymbol[],
          start: number,
          count: number,
        ) => {
          if (!count) return false;
          let next = start + 1;
          for (const symbol of list) {
            if (symbol.endLine < next) continue;
            if (symbol.startLine > next) return true;
            next = Math.max(next, symbol.endLine + 1);
            if (next > start + count) return false;
          }
          return next <= start + count;
        };
        if (
          !represented ||
          uncovered(right, hunk.rightStart, hunk.rightCount) ||
          uncovered(left, hunk.leftStart, hunk.leftCount)
        ) {
          add(undefined, hunk.rightCount ? "right" : "left", index);
          if (!messages.some((message) => message.includes("Top-level")))
            messages.push("Top-level changes grouped at file level.");
        }
      });
    } catch {
      fallback(
        "Syntax could not be parsed within the analysis limit; changes grouped at file level.",
      );
    }
  }
  result.symbols = [...groups.values()].sort((a, b) =>
    a.side === b.side ? a.startLine - b.startLine : a.side === "right" ? -1 : 1,
  );
  if (messages.length) result.message = messages.join(" ");
  return result;
}
