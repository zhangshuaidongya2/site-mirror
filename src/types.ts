export type ResourceKind =
  | "page"
  | "stylesheet"
  | "script"
  | "image"
  | "font"
  | "media"
  | "document"
  | "other";

export type ScopeMode = "same-origin" | "same-host" | "all";

export interface MirrorOptions {
  outputDir: string;
  crawlDepth: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  pageScope: ScopeMode;
  assetScope: ScopeMode;
  userAgent: string;
  verbose: boolean;
  stripIntegrity: boolean;
}

export interface ResourceRecord {
  key: string;
  url: string;
  finalUrl?: string;
  kind: ResourceKind;
  depth: number;
  parentUrl?: string;
  contentType?: string;
  localRelativePath: string;
  localAbsolutePath: string;
  status: "pending" | "done" | "failed";
  size?: number;
  error?: string;
}

export interface FailureRecord {
  url: string;
  kind: ResourceKind;
  message: string;
}

export interface MirrorResult {
  entryUrl: string;
  outputDir: string;
  launcherFile: string;
  entryFile: string;
  reportFile: string;
  downloadedCount: number;
  failedCount: number;
  records: ResourceRecord[];
  failures: FailureRecord[];
}
