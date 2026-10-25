import * as esbuild from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  outfile: "dist/extension.js",
  sourcemap: true,
});
await esbuild.build({
  entryPoints: { editor: "webview/editor.ts", sidebar: "webview/sidebar.ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outdir: "dist",
  loader: { ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
});
await esbuild.build({
  entryPoints: ["node_modules/monaco-editor/esm/vs/editor/editor.worker.js"],
  bundle: true,
  format: "iife",
  outfile: "dist/editor.worker.js",
});
await copyFile("webview/style.css", "dist/style.css");
