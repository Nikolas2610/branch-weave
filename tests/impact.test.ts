import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeImpact } from "../src/impact";
import { DraftPair } from "../src/draft";

function analyze(
  left: string,
  right: string,
  path = "src/calc.ts",
  tests: Array<{ path: string; text: string }> = [],
) {
  const pair = new DraftPair(
    { exists: true, text: left, path },
    { exists: true, text: right, path },
  );
  return analyzeImpact(path, left, right, pair.hunks(), tests);
}

test("changed functions use right-side one-based ranges and unchanged functions are excluded", () => {
  const left =
    "export function sum() {\n  return 1;\n}\n\nfunction untouched() { return 7; }\n";
  const result = analyze(left, left.replace("return 1", "return 2"));
  assert.deepEqual(
    result.symbols.map(({ name, kind, startLine, endLine, side, hunks }) => ({
      name,
      kind,
      startLine,
      endLine,
      side,
      hunks,
    })),
    [
      {
        name: "sum",
        kind: "function",
        startLine: 1,
        endLine: 3,
        side: "right",
        hunks: [0],
      },
    ],
  );
});

test("deleted functions and methods retain navigation on the left", () => {
  const left =
    "function gone() { return 1; }\nclass Box {\n  gone() { return 2; }\n  stay() { return 3; }\n}\n";
  const right = "class Box {\n  stay() { return 3; }\n}\n";
  const result = analyze(left, right);
  assert.deepEqual(
    result.symbols.map((s) => [s.name, s.side, s.startLine, s.endLine]),
    [
      ["gone", "left", 1, 1],
      ["Box.gone", "left", 3, 3],
    ],
  );
});

test("nested methods and arrow functions group the most specific changed code with unique IDs", () => {
  const left =
    "class Box {\n  run() {\n    const nested = () => {\n      return 1;\n    };\n    return nested();\n  }\n  other = () => 4;\n}\nconst another = () => 1;\n";
  const right = left
    .replace("return 1", "return 2")
    .replace("() => 4", "() => 5")
    .replace("() => 1", "() => 2");
  const result = analyze(left, right);
  assert.deepEqual(
    result.symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine]),
    [
      ["Box.run.nested", "arrow", 3, 5],
      ["Box.other", "arrow", 8, 8],
      ["another", "arrow", 10, 10],
    ],
  );
  assert.equal(
    new Set(result.symbols.map((s) => s.id)).size,
    result.symbols.length,
  );
});

test("class header edits group the class and duplicate declarations never share IDs", () => {
  const result = analyze(
    "class Old {}\nfunction same() { return 1; }\nfunction same() { return 2; }",
    "class New {}\nfunction same() { return 3; }\nfunction same() { return 4; }",
  );
  assert.ok(
    result.symbols.some(
      (s) => s.name === "New" && s.kind === "class" && s.side === "right",
    ),
  );
  assert.equal(
    result.symbols.filter((s) => s.name === "same" && s.side === "right")
      .length,
    2,
  );
  assert.equal(
    new Set(result.symbols.map((s) => s.id)).size,
    result.symbols.length,
  );
});

test("comments and strings cannot create fake symbols and top-level changes have a file group", () => {
  const left =
    '// function fake() {}\nconst note = "class Fake {}";\nfunction real() { return 1; }';
  const right = left.replace("fake()", "changed()").replace("Fake", "Changed");
  const result = analyze(left, right);
  assert.deepEqual(
    result.symbols.map((s) => [s.name, s.kind]),
    [["src/calc.ts", "file"]],
  );
  assert.match(result.message ?? "", /file|top.level/i);
});

test("JS, JSX, TSX and module suffixes parse actual functions without executing source", () => {
  for (const path of [
    "src/view.js",
    "src/view.jsx",
    "src/view.tsx",
    "src/view.mjs",
    "src/view.cjs",
  ]) {
    const result = analyze(
      "const render = () => <div>before</div>;",
      "const render = () => <div>after</div>;",
      path,
    );
    assert.deepEqual(
      result.symbols.map((s) => s.name),
      ["render"],
    );
  }
});

test("related tests report basename and static relative import evidence without string or comment false positives", () => {
  const result = analyze(
    "function sum() { return 1; }",
    "function sum() { return 2; }",
    "src/calc.ts",
    [
      { path: "tests/calc.test.ts", text: "" },
      { path: "src/calc.spec.ts", text: "" },
      {
        path: "tests/consumer.test.ts",
        text: "import { sum } from '../src/calc';",
      },
      {
        path: "tests/require.spec.cjs",
        text: "const calc = require('../src/calc.js');",
      },
      {
        path: "tests/dynamic.test.ts",
        text: "const calc = import('../src/calc');",
      },
      {
        path: "tests/unrelated.test.ts",
        text: "const message = \"import x from '../src/calc'\"; // require('../src/calc')",
      },
      { path: "tests/wrong.test.ts", text: "import x from '../other/calc';" },
      { path: "src/helper.ts", text: "import x from './calc';" },
    ],
  );
  assert.deepEqual(
    result.tests.map((t) => t.path),
    [
      "tests/calc.test.ts",
      "src/calc.spec.ts",
      "tests/consumer.test.ts",
      "tests/require.spec.cjs",
      "tests/dynamic.test.ts",
    ],
  );
  assert.match(result.tests[0].reason, /candidate.*(name|basename)/i);
  assert.match(result.tests[2].reason, /candidate.*import/i);
  assert.match(result.tests[3].reason, /candidate.*require/i);
});

test("conventional test directories admit unsuffixed JS and TS files only with parsed import evidence", () => {
  const result = analyze(
    "function sum() { return 1; }",
    "function sum() { return 2; }",
    "src/calc.ts",
    [
      { path: "tests/calc.ts", text: "import { sum } from '../src/calc';" },
      {
        path: "__tests__/consumer.ts",
        text: "import { sum } from '../src/calc';",
      },
      {
        path: "test/consumer.js",
        text: "const calc = require('../src/calc');",
      },
      {
        path: "packages/test/consumer.tsx",
        text: "import { sum } from '../../src/calc';",
      },
      { path: "tests/helpers.ts", text: "export const helper = 1;" },
      {
        path: "__tests__/calc.ts",
        text: "// no import evidence despite the matching basename",
      },
      {
        path: "test/string.ts",
        text: "const note = \"import x from '../src/calc'\";",
      },
      { path: "tests/plain.json", text: "import x from '../src/calc';" },
      { path: "src/consumer.ts", text: "import { sum } from './calc';" },
      {
        path: "contest/consumer.ts",
        text: "import { sum } from '../src/calc';",
      },
    ],
  );
  assert.deepEqual(
    result.tests.map((item) => item.path),
    [
      "tests/calc.ts",
      "__tests__/consumer.ts",
      "test/consumer.js",
      "packages/test/consumer.tsx",
    ],
  );
  assert.ok(
    result.tests.every((item) =>
      /candidate.*(?:import|require)/i.test(item.reason),
    ),
  );
});

test("unsupported language and unparseable source retain file navigation", () => {
  const unsupported = analyze(
    "def run():\n  return 1\n",
    "def run():\n  return 2\n",
    "src/run.py",
  );
  assert.deepEqual(
    unsupported.symbols.map((s) => [s.kind, s.side, s.startLine, s.hunks]),
    [["file", "right", 1, [0]]],
  );
  assert.match(unsupported.message ?? "", /unsupported|file.level/i);
  const invalid = analyze("const x = 1;", "function () {");
  assert.deepEqual(
    invalid.symbols.map((s) => s.kind),
    ["file"],
  );
  assert.match(invalid.message ?? "", /pars|syntax/i);
});

test("unchanged files produce no impact symbols and inputs remain unmodified", () => {
  const hunks = [{ leftStart: 0, leftCount: 1, rightStart: 0, rightCount: 1 }];
  const tests = [{ path: "tests/calc.test.ts", text: "" }];
  const before = JSON.stringify({ hunks, tests });
  analyzeImpact(
    "src/calc.ts",
    "const before = 1;",
    "const after = 2;",
    hunks,
    tests,
  );
  assert.equal(JSON.stringify({ hunks, tests }), before);
  assert.deepEqual(
    analyze("function same() {}", "function same() {}").symbols,
    [],
  );
});

test("unsafe repository paths and invalid hunk ranges are rejected before parsing", () => {
  for (const path of [
    "../outside.ts",
    "/absolute.ts",
    "C:\\outside.ts",
    "safe/../outside.ts",
    "bad\0.ts",
    "src/file.ts:stream",
    ".git/config.ts",
  ]) {
    assert.throws(() => analyzeImpact(path, "", "", []), /path/i);
  }
  assert.throws(
    () =>
      analyzeImpact(
        "src/calc.ts",
        "",
        "",
        [],
        [{ path: "../outside.test.ts", text: "" }],
      ),
    /path/i,
  );
  for (const value of [-1, NaN, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () =>
        analyzeImpact("src/calc.ts", "x", "y", [
          { leftStart: value, leftCount: 1, rightStart: 0, rightCount: 1 },
        ]),
      /hunk|range/i,
    );
  }
});

test("deleting one duplicate declaration excludes its unchanged surviving sibling", () => {
  const result = analyze(
    "function same() { return 1; }\nfunction same() { return 2; }\n",
    "function same() { return 2; }\n",
  );
  assert.deepEqual(
    result.symbols.map((s) => [s.name, s.side, s.startLine]),
    [["same", "left", 1]],
  );
});

test("pure body deletions still navigate to a surviving current function", () => {
  const result = analyze(
    "function run() {\n  const removed = 1;\n  return 2;\n}\n",
    "function run() {\n  return 2;\n}\n",
  );
  assert.deepEqual(
    result.symbols.map((s) => [s.name, s.side, s.startLine, s.endLine]),
    [["run", "right", 1, 3]],
  );
});

test("relative test imports cannot climb above the repository and reenter it", () => {
  const result = analyze("function a() {}", "function b() {}", "src/calc.ts", [
    { path: "tests/escape.test.ts", text: "import x from '../../src/calc';" },
  ]);
  assert.deepEqual(result.tests, []);
});

test("very large symbol collections fall back without an unbounded matching pass", () => {
  const source = Array.from(
    { length: 2500 },
    (_, index) => `function f${index}() { return ${index}; }`,
  ).join("\n");
  const result = analyzeImpact("src/calc.ts", "", source, [
    { leftStart: 0, leftCount: 0, rightStart: 0, rightCount: 2500 },
  ]);
  assert.deepEqual(
    result.symbols.map((s) => s.kind),
    ["file"],
  );
  assert.match(result.message ?? "", /limit/);
});

test("oversized source and test collections return bounded file-level suggestions", () => {
  const source = "x".repeat(600_000);
  const result = analyzeImpact("src/calc.ts", "", source, [
    { leftStart: 0, leftCount: 0, rightStart: 0, rightCount: 1 },
  ]);
  assert.deepEqual(
    result.symbols.map((s) => s.kind),
    ["file"],
  );
  assert.match(result.message ?? "", /limit|large|size/i);
  const tests = Array.from({ length: 1_000 }, (_, index) => ({
    path: `tests/other${index}.test.ts`,
    text: "",
  }));
  const bounded = analyze(
    "function a() {}",
    "function b() {}",
    "src/calc.ts",
    tests,
  );
  assert.match(bounded.message ?? "", /limit|candidate|test/i);
});
