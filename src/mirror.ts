import fs from "node:fs/promises";
import path from "node:path";

import { load } from "cheerio";
import got from "got";
import pLimit from "p-limit";
import postcss from "postcss";
import valueParser from "postcss-value-parser";

import {
  dedupeRelativePath,
  planLocalRelativePath,
  relativeBrowserPath,
} from "./pathing.js";
import {
  createPlaywrightMirrorClient,
  type BrowserMirrorClient,
  type BrowserMirrorClientFactory,
  type BrowserResourceSnapshot,
} from "./playwright-support.js";
import type {
  FailureRecord,
  MirrorProgress,
  MirrorProgressPhase,
  MirrorOptions,
  MirrorResult,
  ResourceKind,
  ResourceRecord,
  ScopeMode,
} from "./types.js";
import {
  classifyContentAsText,
  decodeBuffer,
  ensureUrlHasNoHash,
  isHttpUrl,
  isSkippableReference,
  normalizeUrl,
  parseSrcset,
  resolveUrl,
  stringifySrcset,
} from "./utils.js";

interface RewriteResult {
  value: string;
  mirrored: boolean;
  target?: ResourceRecord;
}

interface Replacement {
  start: number;
  end: number;
  value: string;
}

interface MirrorEngineDependencies {
  browserClientFactory?: BrowserMirrorClientFactory;
  onProgress?: (progress: MirrorProgress) => void;
}

const NETWORK_HINT_RELS = new Set(["dns-prefetch", "preconnect", "prerender"]);

function applyReplacements(input: string, replacements: Replacement[]): string {
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (output, replacement) =>
        `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`,
      input,
    );
}

function quoteForCss(value: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
  return `"${escaped}"`;
}

function unquote(value: string): string {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function inferLinkKind(relValue: string | undefined, asValue: string | undefined): ResourceKind | null {
  const rels = new Set(
    (relValue ?? "")
      .toLowerCase()
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean),
  );

  if ([...NETWORK_HINT_RELS].some((token) => rels.has(token))) {
    return null;
  }

  if (rels.has("stylesheet")) {
    return "stylesheet";
  }

  if (
    rels.has("icon") ||
    rels.has("apple-touch-icon") ||
    rels.has("mask-icon") ||
    rels.has("fluid-icon") ||
    rels.has("apple-touch-startup-image")
  ) {
    return "image";
  }

  if (rels.has("manifest")) {
    return "other";
  }

  if (rels.has("modulepreload")) {
    return "script";
  }

  if (rels.has("preload") || rels.has("prefetch")) {
    switch ((asValue ?? "").toLowerCase()) {
      case "style":
        return "stylesheet";
      case "script":
        return "script";
      case "image":
        return "image";
      case "font":
        return "font";
      case "video":
      case "audio":
        return "media";
      case "document":
        return "document";
      default:
        return "other";
    }
  }

  return null;
}

export class MirrorEngine {
  private readonly records = new Map<string, ResourceRecord>();
  private readonly failures: FailureRecord[] = [];
  private readonly tasks: Promise<void>[] = [];
  private readonly limit;
  private readonly usedPaths = new Map<string, string>();
  private readonly client;
  private readonly activeRecords = new Set<string>();
  private browserClientPromise?: Promise<BrowserMirrorClient>;
  private entryUrl!: URL;

  constructor(
    private readonly options: MirrorOptions,
    private readonly dependencies: MirrorEngineDependencies = {},
  ) {
    this.limit = pLimit(Math.max(1, options.concurrency));
    this.client = got.extend({
      followRedirect: true,
      http2: true,
      headers: {
        "user-agent": options.userAgent,
      },
      retry: {
        limit: options.retries,
      },
      timeout: {
        request: options.timeoutMs,
      },
    });
  }

  async mirror(entryUrlInput: string): Promise<MirrorResult> {
    const entryUrl = new URL(entryUrlInput);
    if (!isHttpUrl(entryUrl)) {
      throw new Error("Only http:// and https:// URLs are supported.");
    }

    try {
      this.entryUrl = entryUrl;
      await fs.mkdir(this.options.outputDir, { recursive: true });
      this.emitProgress("starting");

      const entryRecord = this.enqueueResource(entryUrl, "page", 0);
      if (!entryRecord) {
        throw new Error("Failed to enqueue the entry page.");
      }

      for (let index = 0; index < this.tasks.length; index += 1) {
        await this.tasks[index];
      }

      if (entryRecord.status === "failed") {
        throw new Error(entryRecord.error ?? "Entry page download failed.");
      }

      const launcherFile = await this.writeLauncher(entryRecord);
      const reportFile = await this.writeReport(entryRecord);
      const records = [...this.records.values()].sort((left, right) =>
        left.localRelativePath.localeCompare(right.localRelativePath),
      );
      this.emitProgress("finished", entryRecord);

      return {
        entryUrl: entryUrl.toString(),
        outputDir: this.options.outputDir,
        launcherFile,
        entryFile: entryRecord.localAbsolutePath,
        reportFile,
        downloadedCount: records.filter((record) => record.status === "done").length,
        failedCount: this.failures.length,
        records,
        failures: [...this.failures],
      };
    } finally {
      await this.closeBrowserClient();
    }
  }

  private enqueueResource(
    url: URL,
    kind: ResourceKind,
    depth: number,
    parentUrl?: string,
  ): ResourceRecord | null {
    const normalizedUrl = ensureUrlHasNoHash(url);

    if (kind === "page" || kind === "document") {
      if (!this.shouldMirror(normalizedUrl, this.options.pageScope)) {
        return null;
      }

      if (depth > this.options.crawlDepth) {
        return null;
      }
    } else if (!this.shouldMirror(normalizedUrl, this.options.assetScope)) {
      return null;
    }

    const key = normalizeUrl(normalizedUrl);
    const existing = this.records.get(key);
    if (existing) {
      return existing;
    }

    const desiredRelativePath = planLocalRelativePath(normalizedUrl, kind);
    const localRelativePath = dedupeRelativePath(
      desiredRelativePath,
      normalizedUrl,
      this.usedPaths,
      key,
    );
    const localAbsolutePath = path.join(this.options.outputDir, localRelativePath);

    const record: ResourceRecord = {
      key,
      url: key,
      kind,
      depth,
      parentUrl,
      localRelativePath,
      localAbsolutePath,
      status: "pending",
    };

    this.records.set(key, record);
    this.tasks.push(this.limit(() => this.processResource(record)));
    this.emitProgress("queued", record);
    return record;
  }

  private async processResource(record: ResourceRecord): Promise<void> {
    this.activeRecords.add(record.key);
    this.emitProgress("fetching", record);

    try {
      if (this.options.mode === "playwright") {
        await this.processResourceWithPlaywright(record);
      } else {
        await this.processResourceWithHttp(record);
      }

      record.status = "done";
      this.log(`saved ${record.localRelativePath}`);
    } catch (error) {
      record.status = "failed";
      record.error = toErrorMessage(error);
      this.failures.push({
        url: record.url,
        kind: record.kind,
        message: record.error,
      });
      this.log(`failed ${record.url}: ${record.error}`);
    } finally {
      this.activeRecords.delete(record.key);
      this.emitProgress("processed", record);
    }
  }

  private async processResourceWithHttp(record: ResourceRecord): Promise<void> {
    const response = await this.client.get(record.url, {
      headers: record.parentUrl ? { referer: record.parentUrl } : undefined,
      responseType: "buffer",
    });

    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.body);

    await this.writeProcessedResponse(record, {
      body,
      contentType: String(response.headers["content-type"] ?? ""),
      finalUrl: response.url,
    });
  }

  private async processResourceWithPlaywright(record: ResourceRecord): Promise<void> {
    const browserClient = await this.getBrowserClient();

    if (record.kind === "page" || record.kind === "document") {
      const snapshot = await browserClient.renderPage({
        url: record.url,
        referer: record.parentUrl,
      });

      await this.writeProcessedPage(record, snapshot.html, snapshot.finalUrl, snapshot.contentType);
      return;
    }

    const snapshot = await browserClient.fetchResource({
      url: record.url,
      referer: record.parentUrl,
    });

    await this.writeProcessedResponse(record, snapshot);
  }

  private async writeProcessedResponse(
    record: ResourceRecord,
    response: BrowserResourceSnapshot,
  ): Promise<void> {
    const finalUrl = new URL(response.finalUrl);
    const contentType = response.contentType;
    const body = response.body;

    record.finalUrl = finalUrl.toString();
    record.contentType = contentType;
    record.size = body.length;

    await fs.mkdir(path.dirname(record.localAbsolutePath), { recursive: true });

    const mode = classifyContentAsText(record.kind, contentType);
    if (mode === "html") {
      const html = decodeBuffer(body, contentType);
      const rewritten = await this.rewriteHtml(record, html, finalUrl);
      await fs.writeFile(record.localAbsolutePath, rewritten, "utf8");
    } else if (mode === "css") {
      const css = decodeBuffer(body, contentType);
      const rewritten = await this.rewriteCssText(record, css, finalUrl);
      await fs.writeFile(record.localAbsolutePath, rewritten, "utf8");
    } else {
      await fs.writeFile(record.localAbsolutePath, body);
    }
  }

  private async writeProcessedPage(
    record: ResourceRecord,
    html: string,
    finalUrlInput: string,
    contentType: string,
  ): Promise<void> {
    const finalUrl = new URL(finalUrlInput);

    record.finalUrl = finalUrl.toString();
    record.contentType = contentType;
    record.size = Buffer.byteLength(html);

    await fs.mkdir(path.dirname(record.localAbsolutePath), { recursive: true });

    const rewritten = await this.rewriteHtml(record, html, finalUrl);
    await fs.writeFile(record.localAbsolutePath, rewritten, "utf8");
  }

  private async rewriteHtml(record: ResourceRecord, html: string, pageUrl: URL): Promise<string> {
    const $ = load(html);

    let baseUrl = pageUrl;
    const baseElement = $("base[href]").first();
    const rawBaseHref = baseElement.attr("href");
    if (rawBaseHref) {
      try {
        baseUrl = new URL(rawBaseHref, pageUrl);
      } catch {
        baseUrl = pageUrl;
      }
      baseElement.remove();
    }

    await this.rewriteLinkElements($, record, baseUrl);
    await this.rewriteSimpleHtmlAttributes($, record, baseUrl);
    await this.rewritePageLinks($, record, baseUrl);
    await this.rewriteEmbeddedDocuments($, record, baseUrl);
    await this.rewriteForms($, baseUrl);
    await this.rewriteSrcsetAttributes($, record, baseUrl);
    await this.rewriteStyleBlocks($, record, baseUrl);
    await this.rewriteStyleAttributes($, record, baseUrl);
    await this.rewriteMetaRefresh($, record, baseUrl);

    return $.html();
  }

  private async rewriteLinkElements(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    const nodes = $("link[href]").toArray();

    await Promise.all(
      nodes.map(async (node) => {
        const element = $(node);
        const relValue = element.attr("rel");
        const rels = new Set(
          (relValue ?? "")
            .toLowerCase()
            .split(/\s+/)
            .map((token) => token.trim())
            .filter(Boolean),
        );

        if ([...NETWORK_HINT_RELS].some((token) => rels.has(token))) {
          element.remove();
          return;
        }

        const href = element.attr("href");
        if (!href) {
          return;
        }

        const kind = inferLinkKind(relValue, element.attr("as"));
        if (!kind) {
          element.attr("href", this.absolutizeReference(href, baseUrl));
          return;
        }

        const depth = kind === "document" ? record.depth : record.depth;
        const result = await this.rewriteReference({
          rawValue: href,
          baseUrl,
          owner: record,
          kind,
          depth,
        });

        element.attr("href", result.value);

        if (result.mirrored && this.options.stripIntegrity) {
          element.removeAttr("integrity");
          element.removeAttr("crossorigin");
        }
      }),
    );
  }

  private async rewriteSimpleHtmlAttributes(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    const specs: Array<{ selector: string; attr: string; kind: ResourceKind }> = [
      { selector: "script[src]", attr: "src", kind: "script" },
      { selector: "img[src]", attr: "src", kind: "image" },
      { selector: "source[src]", attr: "src", kind: "media" },
      { selector: "video[src]", attr: "src", kind: "media" },
      { selector: "audio[src]", attr: "src", kind: "media" },
      { selector: "track[src]", attr: "src", kind: "media" },
      { selector: "input[src]", attr: "src", kind: "image" },
      { selector: "image[href]", attr: "href", kind: "image" },
      { selector: "use[href]", attr: "href", kind: "image" },
      { selector: "object[data]", attr: "data", kind: "other" },
      { selector: "embed[src]", attr: "src", kind: "other" },
    ];

    await Promise.all(
      specs.flatMap((spec) =>
        $(spec.selector).toArray().map(async (node) => {
          const element = $(node);
          const current = element.attr(spec.attr);
          if (!current) {
            return;
          }

          const result = await this.rewriteReference({
            rawValue: current,
            baseUrl,
            owner: record,
            kind: spec.kind,
            depth: record.depth,
          });

          element.attr(spec.attr, result.value);

          if (
            spec.selector === "script[src]" &&
            result.mirrored &&
            this.options.stripIntegrity
          ) {
            element.removeAttr("integrity");
            element.removeAttr("crossorigin");
          }
        }),
      ),
    );
  }

  private async rewritePageLinks(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    const nodes = $("a[href], area[href]").toArray();

    await Promise.all(
      nodes.map(async (node) => {
        const element = $(node);
        const href = element.attr("href");
        if (!href) {
          return;
        }

        const result = await this.rewriteReference({
          rawValue: href,
          baseUrl,
          owner: record,
          kind: "page",
          depth: record.depth + 1,
        });

        element.attr("href", result.value);
      }),
    );
  }

  private async rewriteEmbeddedDocuments(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    const nodes = $("iframe[src], frame[src]").toArray();

    await Promise.all(
      nodes.map(async (node) => {
        const element = $(node);
        const src = element.attr("src");
        if (!src) {
          return;
        }

        const result = await this.rewriteReference({
          rawValue: src,
          baseUrl,
          owner: record,
          kind: "document",
          depth: record.depth,
        });

        element.attr("src", result.value);
      }),
    );
  }

  private async rewriteForms($: ReturnType<typeof load>, baseUrl: URL): Promise<void> {
    for (const node of $("form[action]").toArray()) {
      const element = $(node);
      const action = element.attr("action");
      if (!action) {
        continue;
      }

      element.attr("action", this.absolutizeReference(action, baseUrl));
    }
  }

  private async rewriteSrcsetAttributes(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    const nodes = $("[srcset]").toArray();

    await Promise.all(
      nodes.map(async (node) => {
        const element = $(node);
        const srcset = element.attr("srcset");
        if (!srcset) {
          return;
        }

        const entries = parseSrcset(srcset);
        const rewrittenEntries = await Promise.all(
          entries.map(async (entry) => {
            const result = await this.rewriteReference({
              rawValue: entry.url,
              baseUrl,
              owner: record,
              kind: "image",
              depth: record.depth,
            });

            return {
              url: result.value,
              descriptor: entry.descriptor,
            };
          }),
        );

        element.attr("srcset", stringifySrcset(rewrittenEntries));
      }),
    );
  }

  private async rewriteStyleBlocks(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    for (const node of $("style").toArray()) {
      const element = $(node);
      const styleText = element.html();
      if (!styleText) {
        continue;
      }

      const rewritten = await this.rewriteCssText(record, styleText, baseUrl);
      element.text(rewritten);
    }
  }

  private async rewriteStyleAttributes(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    const nodes = $("[style]").toArray();

    await Promise.all(
      nodes.map(async (node) => {
        const element = $(node);
        const styleValue = element.attr("style");
        if (!styleValue) {
          return;
        }

        const rewritten = await this.rewriteInlineStyle(record, styleValue, baseUrl);
        element.attr("style", rewritten);
      }),
    );
  }

  private async rewriteMetaRefresh(
    $: ReturnType<typeof load>,
    record: ResourceRecord,
    baseUrl: URL,
  ): Promise<void> {
    for (const node of $("meta[http-equiv]").toArray()) {
      const element = $(node);
      const httpEquiv = (element.attr("http-equiv") ?? "").toLowerCase();
      if (httpEquiv !== "refresh") {
        continue;
      }

      const content = element.attr("content");
      if (!content) {
        continue;
      }

      const match = content.match(/^(\s*\d+\s*;\s*url\s*=\s*)(.+)$/i);
      if (!match) {
        continue;
      }

      const rewritten = await this.rewriteReference({
        rawValue: match[2],
        baseUrl,
        owner: record,
        kind: "page",
        depth: record.depth + 1,
      });

      element.attr("content", `${match[1]}${rewritten.value}`);
    }
  }

  private async rewriteInlineStyle(
    record: ResourceRecord,
    styleValue: string,
    baseUrl: URL,
  ): Promise<string> {
    try {
      const root = postcss.parse(`.inline{${styleValue}}`);
      await this.rewriteCssRoot(record, root, baseUrl);
      const output = root.toString();
      const match = output.match(/^[^{]*\{([\s\S]*)\}$/);
      return match?.[1] ?? styleValue;
    } catch {
      return styleValue;
    }
  }

  private async rewriteCssText(
    record: ResourceRecord,
    cssText: string,
    baseUrl: URL,
  ): Promise<string> {
    try {
      const root = postcss.parse(cssText);
      await this.rewriteCssRoot(record, root, baseUrl);
      return root.toString();
    } catch {
      return cssText;
    }
  }

  private async rewriteCssRoot(
    record: ResourceRecord,
    root: postcss.Root,
    baseUrl: URL,
  ): Promise<void> {
    const tasks: Promise<void>[] = [];

    root.walkAtRules("import", (rule) => {
      tasks.push(
        (async () => {
          rule.params = await this.rewriteCssImportParams(record, rule.params, baseUrl);
        })(),
      );
    });

    root.walkDecls((decl) => {
      tasks.push(
        (async () => {
          decl.value = await this.rewriteCssValue(record, decl.value, baseUrl);
        })(),
      );
    });

    await Promise.all(tasks);
  }

  private async rewriteCssImportParams(
    record: ResourceRecord,
    params: string,
    baseUrl: URL,
  ): Promise<string> {
    const parsed = valueParser(params);
    const firstNode = parsed.nodes.find((node) => node.type !== "space" && node.type !== "comment");
    if (!firstNode) {
      return params;
    }

    if (firstNode.type === "function" && firstNode.value.toLowerCase() === "url") {
      const raw = unquote(valueParser.stringify(firstNode.nodes));
      const result = await this.rewriteReference({
        rawValue: raw,
        baseUrl,
        owner: record,
        kind: "stylesheet",
        depth: record.depth,
      });

      return applyReplacements(params, [
        {
          start: firstNode.sourceIndex ?? 0,
          end: firstNode.sourceEndIndex ?? params.length,
          value: `url(${quoteForCss(result.value)})`,
        },
      ]);
    }

    if (firstNode.type === "string" || firstNode.type === "word") {
      const raw = unquote(firstNode.value);
      const result = await this.rewriteReference({
        rawValue: raw,
        baseUrl,
        owner: record,
        kind: "stylesheet",
        depth: record.depth,
      });

      const replacementValue =
        firstNode.type === "string" ? quoteForCss(result.value) : result.value;

      return applyReplacements(params, [
        {
          start: firstNode.sourceIndex ?? 0,
          end: firstNode.sourceEndIndex ?? params.length,
          value: replacementValue,
        },
      ]);
    }

    return params;
  }

  private async rewriteCssValue(
    record: ResourceRecord,
    value: string,
    baseUrl: URL,
  ): Promise<string> {
    const parsed = valueParser(value);
    const replacements: Replacement[] = [];
    const tasks: Promise<void>[] = [];

    parsed.walk((node) => {
      if (node.type !== "function" || node.value.toLowerCase() !== "url") {
        return;
      }

      tasks.push(
        (async () => {
          const raw = unquote(valueParser.stringify(node.nodes));
          const result = await this.rewriteReference({
            rawValue: raw,
            baseUrl,
            owner: record,
            kind: this.kindFromCssValue(raw),
            depth: record.depth,
          });

          replacements.push({
            start: node.sourceIndex ?? 0,
            end: node.sourceEndIndex ?? value.length,
            value: `url(${quoteForCss(result.value)})`,
          });
        })(),
      );
    });

    await Promise.all(tasks);
    return applyReplacements(value, replacements);
  }

  private kindFromCssValue(rawValue: string): ResourceKind {
    const lower = rawValue.toLowerCase();

    if (lower.endsWith(".css")) {
      return "stylesheet";
    }

    if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(lower)) {
      return "font";
    }

    if (/\.(mp4|webm|mp3|ogg|wav|m4a)(\?|#|$)/i.test(lower)) {
      return "media";
    }

    return "image";
  }

  private async rewriteReference(input: {
    rawValue: string;
    baseUrl: URL;
    owner: ResourceRecord;
    kind: ResourceKind;
    depth: number;
  }): Promise<RewriteResult> {
    const rawValue = input.rawValue.trim();
    if (isSkippableReference(rawValue)) {
      return {
        value: input.rawValue,
        mirrored: false,
      };
    }

    const resolved = resolveUrl(rawValue, input.baseUrl);
    if (!resolved) {
      return {
        value: input.rawValue,
        mirrored: false,
      };
    }

    const targetUrl = ensureUrlHasNoHash(resolved);
    const suffix = resolved.hash;
    const isPageLike = input.kind === "page" || input.kind === "document";

    if (
      (isPageLike && !this.shouldMirror(targetUrl, this.options.pageScope)) ||
      (!isPageLike && !this.shouldMirror(targetUrl, this.options.assetScope)) ||
      (isPageLike && input.depth > this.options.crawlDepth)
    ) {
      return {
        value: `${targetUrl.toString()}${suffix}`,
        mirrored: false,
      };
    }

    const target = this.enqueueResource(
      targetUrl,
      input.kind,
      input.depth,
      input.owner.finalUrl ?? input.owner.url,
    );

    if (!target) {
      return {
        value: `${targetUrl.toString()}${suffix}`,
        mirrored: false,
      };
    }

    if (target.key === input.owner.key && suffix) {
      return {
        value: suffix,
        mirrored: true,
        target,
      };
    }

    const relativePath = relativeBrowserPath(
      input.owner.localAbsolutePath,
      target.localAbsolutePath,
    );

    return {
      value: `${relativePath}${suffix}`,
      mirrored: true,
      target,
    };
  }

  private absolutizeReference(rawValue: string, baseUrl: URL): string {
    if (isSkippableReference(rawValue)) {
      return rawValue;
    }

    const resolved = resolveUrl(rawValue, baseUrl);
    return resolved ? resolved.toString() : rawValue;
  }

  private shouldMirror(url: URL, scope: ScopeMode): boolean {
    switch (scope) {
      case "all":
        return true;
      case "same-host":
        return url.host === this.entryUrl.host;
      case "same-origin":
      default:
        return url.origin === this.entryUrl.origin;
    }
  }

  private async writeLauncher(entryRecord: ResourceRecord): Promise<string> {
    const launcherPath = path.join(this.options.outputDir, "index.html");
    const target = relativeBrowserPath(launcherPath, entryRecord.localAbsolutePath);
    const launcherHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=${target}">
    <title>Mirrored Site</title>
  </head>
  <body>
    <p>Open <a href="${target}">${target}</a></p>
  </body>
</html>
`;

    await fs.writeFile(launcherPath, launcherHtml, "utf8");
    return launcherPath;
  }

  private async writeReport(entryRecord: ResourceRecord): Promise<string> {
    const reportPath = path.join(this.options.outputDir, "mirror-report.json");
    const payload = {
      createdAt: new Date().toISOString(),
      entryUrl: this.entryUrl.toString(),
      entryFile: entryRecord.localAbsolutePath,
      options: this.options,
      records: [...this.records.values()].sort((left, right) =>
        left.localRelativePath.localeCompare(right.localRelativePath),
      ),
      failures: this.failures,
    };

    await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return reportPath;
  }

  private log(message: string): void {
    if (this.options.verbose) {
      console.log(message);
    }
  }

  private async getBrowserClient(): Promise<BrowserMirrorClient> {
    if (!this.browserClientPromise) {
      const factory =
        this.dependencies.browserClientFactory ?? createPlaywrightMirrorClient;
      this.browserClientPromise = factory(this.options);
    }

    return this.browserClientPromise;
  }

  private async closeBrowserClient(): Promise<void> {
    if (!this.browserClientPromise) {
      return;
    }

    try {
      const browserClient = await this.browserClientPromise;
      await browserClient.close();
    } catch {
      // Ignore browser bootstrap and shutdown failures during cleanup.
    } finally {
      this.browserClientPromise = undefined;
    }
  }

  private emitProgress(
    phase: MirrorProgressPhase,
    record?: ResourceRecord,
  ): void {
    this.dependencies.onProgress?.({
      phase,
      discoveredCount: this.records.size,
      pendingCount: [...this.records.values()].filter(
        (resource) =>
          resource.status === "pending" && !this.activeRecords.has(resource.key),
      ).length,
      inProgressCount: this.activeRecords.size,
      downloadedCount: [...this.records.values()].filter(
        (resource) => resource.status === "done",
      ).length,
      failedCount: this.failures.length,
      currentUrl: record?.url,
      currentKind: record?.kind,
    });
  }
}
