declare module "monaco-editor/base/common/codicons.js" {
  export const Codicon: Readonly<
    Record<
      | "goToFile"
      | "arrowLeft"
      | "arrowRight"
      | "arrowUp"
      | "arrowDown"
      | "discard"
      | "redo"
      | "refresh"
      | "fileCode"
      | "export"
      | "check"
      | "save"
      | "diffSingle"
      | "diffMultiple",
      { readonly id: string }
    >
  >;
}
