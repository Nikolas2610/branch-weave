import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeThemeColor } from "../webview/colors";
test("VS Code rgba theme values become Monaco hexadecimal colors instead of invalid-color red", () => {
  assert.equal(
    normalizeThemeColor("rgba(155, 185, 85, 0.2)", "#000000"),
    "#9bb95533",
  );
  assert.equal(normalizeThemeColor("rgb(30, 30, 30)", "#000000"), "#1e1e1eff");
  assert.equal(
    normalizeThemeColor("rgb(100% 0% 0% / 50%)", "#000000"),
    "#ff000080",
  );
  assert.equal(normalizeThemeColor("#abc", "#000000"), "#aabbcc");
  assert.equal(normalizeThemeColor("invalid", "#123456"), "#123456");
  assert.equal(normalizeThemeColor("transparent", "#ffffff"), "#00000000");
});
