/** Host/webview contract for the review workflow. Values contain no executable markup. */
export interface ReviewNoteView {
  id: string;
  text: string;
  hunk?: number;
  stale: boolean;
}
export interface ReviewView {
  reviewed: boolean;
  reviewedHunks: number[];
  totalHunks: number;
  notes: ReviewNoteView[];
  filesReviewed: number;
  totalFiles: number;
}
export interface StagingSectionView {
  index: number;
  summary: string;
  preview: string;
}
export interface StagingView {
  token: string;
  staged: StagingSectionView[];
  unstaged: StagingSectionView[];
  bufferUnsaved: boolean;
  error?: string;
}
export interface ImpactSymbolView {
  id: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  side: "left" | "right";
  hunks: number[];
}
export interface RelatedTestView {
  path: string;
  reason: string;
}
export interface ImpactView {
  symbols: ImpactSymbolView[];
  tests: RelatedTestView[];
  language: string;
  message?: string;
}
export interface ComparisonPreset {
  id: string;
  name: string;
  left: string;
  includeUpstream: boolean;
  highlight: boolean;
  flat: boolean;
  focusMode: boolean;
  ignoreWhitespace: boolean;
  filter: string;
}
