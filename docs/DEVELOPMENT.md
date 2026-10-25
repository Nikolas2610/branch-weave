# Develop BranchWeave

The [README](../README.md) is the user guide displayed with the extension. This guide covers running and checking the source project.

## Run from source

1. Open the `branch-lens` source folder in VS Code.
2. Run `npm ci` in the integrated terminal.
3. Press **F5** and choose **Run BranchWeave**. The launch configuration builds the extension and opens an Extension Development Host.
4. Open a trusted local Git repository in that new window and select BranchWeave in the Activity Bar.

The extension source folder itself does not need to be a Git repository. Branch comparison needs a Git repository open in the Extension Development Host.

## Check and package

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:host
npm run package
```

`npm run test:host` runs native smoke checks against disposable Git fixtures using installed VS Code. Set `VSCODE_EXECUTABLE_PATH` for a nondefault installation.

`npm run package` builds the extension through `vscode:prepublish` and creates `branch-lens.vsix` in the project root. To install it manually, run **Extensions: Install from VSIX…** in VS Code and select the generated package. See the [release guide](RELEASING.md) for GitHub Actions publication.

## Verification evidence

- [Current working-tree browser verification](current-working-tree-browser.md): rendered webview criteria, screenshots, and harness limitations.
- [Delivery report](DELIVERY.md): release verification, native host checks, and remaining interactive checks.
- [Original browser verification](browser-verification.md) and [host verification](host-verification.md): earlier implementation evidence.

The README screenshots use the production webview assets with sample data in the browser harness. Native file-buffer and Save behavior is checked separately in the extension host.
