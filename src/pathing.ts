import path from "node:path";

import type { ResourceKind } from "./types.js";
import { hashSuffix, hostKey, sanitizePathSegment, toPosixPath } from "./utils.js";

const HTML_EXTENSIONS = new Set([".html", ".htm", ".xhtml"]);

function splitPathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => sanitizePathSegment(segment));
}

function splitFileName(fileName: string): { name: string; ext: string } {
  const ext = path.posix.extname(fileName);
  const name = ext.length > 0 ? fileName.slice(0, -ext.length) : fileName;
  return { name, ext };
}

function defaultLeafName(kind: ResourceKind): string {
  switch (kind) {
    case "stylesheet":
      return "stylesheet.css";
    case "script":
      return "script.js";
    case "page":
    case "document":
      return "index.html";
    case "image":
      return "image";
    case "font":
      return "font";
    case "media":
      return "media";
    default:
      return "asset";
  }
}

function ensureLeafExtension(fileName: string, kind: ResourceKind): string {
  const ext = path.posix.extname(fileName);
  if (ext.length > 0) {
    if (
      (kind === "page" || kind === "document") &&
      !HTML_EXTENSIONS.has(ext.toLowerCase())
    ) {
      return `${fileName}.html`;
    }

    return fileName;
  }

  if (kind === "stylesheet") {
    return `${fileName}.css`;
  }

  if (kind === "script") {
    return `${fileName}.js`;
  }

  if (kind === "page" || kind === "document") {
    return `${fileName}.html`;
  }

  return fileName;
}

export function planLocalRelativePath(url: URL, kind: ResourceKind): string {
  const scopeFolder = kind === "page" || kind === "document" ? "pages" : "assets";
  const segments = splitPathSegments(url.pathname);
  const isDirectoryLike = url.pathname.endsWith("/") || segments.length === 0;

  let relativeSegments = [scopeFolder, hostKey(url), ...segments];

  if (kind === "page" || kind === "document") {
    if (isDirectoryLike) {
      relativeSegments.push("index.html");
    } else {
      const leaf = relativeSegments.pop() ?? defaultLeafName(kind);
      relativeSegments.push(ensureLeafExtension(leaf, kind));
    }
  } else if (isDirectoryLike) {
    relativeSegments.push(defaultLeafName(kind));
  } else {
    const leaf = relativeSegments.pop() ?? defaultLeafName(kind);
    relativeSegments.push(ensureLeafExtension(leaf, kind));
  }

  if (url.search.length > 0) {
    const leaf = relativeSegments.pop() ?? defaultLeafName(kind);
    const { name, ext } = splitFileName(leaf);
    relativeSegments.push(`${name}__${hashSuffix(url.search)}${ext}`);
  }

  return toPosixPath(path.posix.join(...relativeSegments));
}

export function dedupeRelativePath(
  desiredPath: string,
  url: URL,
  usedPaths: Map<string, string>,
  key: string,
): string {
  const existingOwner = usedPaths.get(desiredPath);
  if (!existingOwner || existingOwner === key) {
    usedPaths.set(desiredPath, key);
    return desiredPath;
  }

  const ext = path.posix.extname(desiredPath);
  const base = ext.length > 0 ? desiredPath.slice(0, -ext.length) : desiredPath;
  const deduped = `${base}__${hashSuffix(url.toString())}${ext}`;
  usedPaths.set(deduped, key);
  return deduped;
}

export function relativeBrowserPath(fromFile: string, toFile: string): string {
  const relative = toPosixPath(path.relative(path.dirname(fromFile), toFile));
  return relative.length > 0 ? relative : path.posix.basename(toFile);
}
