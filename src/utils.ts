import { createHash } from "node:crypto";

import iconv from "iconv-lite";

import type { ResourceKind } from "./types.js";

const HTML_CONTENT_TYPES = ["text/html", "application/xhtml+xml"];
const CSS_CONTENT_TYPES = ["text/css"];

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export function normalizeUrl(input: URL): string {
  const normalized = new URL(input.toString());
  normalized.hash = "";

  if (
    (normalized.protocol === "http:" && normalized.port === "80") ||
    (normalized.protocol === "https:" && normalized.port === "443")
  ) {
    normalized.port = "";
  }

  return normalized.toString();
}

export function isHttpUrl(input: URL): boolean {
  return input.protocol === "http:" || input.protocol === "https:";
}

export function resolveUrl(rawValue: string, baseUrl: URL): URL | null {
  try {
    const resolved = new URL(rawValue, baseUrl);
    return isHttpUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function isSkippableReference(rawValue: string): boolean {
  const value = rawValue.trim();

  return (
    value.length === 0 ||
    value.startsWith("#") ||
    value.startsWith("data:") ||
    value.startsWith("javascript:") ||
    value.startsWith("mailto:") ||
    value.startsWith("tel:") ||
    value.startsWith("blob:")
  );
}

export function isHtmlContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }

  return HTML_CONTENT_TYPES.some((value) => contentType.includes(value));
}

export function isCssContentType(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }

  return CSS_CONTENT_TYPES.some((value) => contentType.includes(value));
}

export function classifyContentAsText(
  kind: ResourceKind,
  contentType?: string,
): "html" | "css" | null {
  if (kind === "page" || kind === "document" || isHtmlContentType(contentType)) {
    return "html";
  }

  if (kind === "stylesheet" || isCssContentType(contentType)) {
    return "css";
  }

  return null;
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "_";
}

export function hostKey(url: URL): string {
  return sanitizePathSegment(url.host.replaceAll(":", "_"));
}

export function hashSuffix(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 10);
}

export function toPosixPath(value: string): string {
  return value.split("\\").join("/");
}

export function decodeBuffer(buffer: Buffer, contentType?: string): string {
  const charset =
    extractCharsetFromContentType(contentType) ??
    extractCharsetFromHtmlMeta(buffer) ??
    "utf-8";

  if (iconv.encodingExists(charset)) {
    return iconv.decode(buffer, charset);
  }

  return buffer.toString("utf8");
}

export function extractCharsetFromContentType(contentType?: string): string | null {
  if (!contentType) {
    return null;
  }

  const match = contentType.match(/charset=([^;]+)/i);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : null;
}

export function extractCharsetFromHtmlMeta(buffer: Buffer): string | null {
  const preview = buffer.toString("ascii", 0, Math.min(buffer.length, 4096));
  const directCharset = preview.match(
    /<meta[^>]+charset=["']?\s*([a-z0-9_\-]+)/i,
  );

  if (directCharset?.[1]) {
    return directCharset[1].trim();
  }

  const contentTypeMeta = preview.match(
    /<meta[^>]+http-equiv=["']content-type["'][^>]+content=["'][^"']*charset=([a-z0-9_\-]+)/i,
  );

  return contentTypeMeta?.[1]?.trim() ?? null;
}

export function ensureUrlHasNoHash(input: URL): URL {
  const next = new URL(input.toString());
  next.hash = "";
  return next;
}

export function parseSrcset(input: string): Array<{ url: string; descriptor: string }> {
  const candidates: string[] = [];
  let current = "";
  let quote: string | null = null;
  let parenDepth = 0;

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null;
      }

      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }

    if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += char;
      continue;
    }

    if (char === "," && parenDepth === 0) {
      if (current.trim().length > 0) {
        candidates.push(current.trim());
      }

      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    candidates.push(current.trim());
  }

  return candidates.map((candidate) => {
    const match = candidate.match(/^(\S+)(?:\s+(.*))?$/);
    return {
      url: match?.[1] ?? candidate,
      descriptor: match?.[2]?.trim() ?? "",
    };
  });
}

export function stringifySrcset(
  entries: Array<{ url: string; descriptor: string }>,
): string {
  return entries
    .map((entry) =>
      entry.descriptor.length > 0 ? `${entry.url} ${entry.descriptor}` : entry.url,
    )
    .join(", ");
}
