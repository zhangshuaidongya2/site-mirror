import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { load } from "cheerio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MirrorEngine } from "../src/mirror.js";
import type { MirrorOptions } from "../src/types.js";
import { DEFAULT_USER_AGENT } from "../src/utils.js";

interface Route {
  body: Buffer | string;
  contentType: string;
}

const routes: Record<string, Route> = {
  "/index.html": {
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base href="/">
    <link rel="stylesheet" href="/styles/main.css">
    <link rel="preconnect" href="https://example-cdn.test">
    <style>
      @import url("/styles/extra.css");
      .hero { background-image: url("/images/hero.jpg"); }
    </style>
  </head>
  <body style="background-image:url('/images/body-pattern.png')">
    <img id="logo" src="/images/logo.png" srcset="/images/logo.png 1x, /images/logo@2x.png 2x">
    <script src="/scripts/app.js" integrity="sha256-demo" crossorigin="anonymous"></script>
    <a id="about-link" href="/about/index.html">About</a>
    <iframe id="frame" src="/frame.html"></iframe>
    <form id="contact-form" action="/submit" method="post"></form>
  </body>
</html>`,
  },
  "/about/index.html": {
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
  </head>
  <body>
    <img src="/images/about.png">
  </body>
</html>`,
  },
  "/frame.html": {
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <link rel="stylesheet" href="/styles/frame.css">
  </head>
  <body>frame</body>
</html>`,
  },
  "/styles/main.css": {
    contentType: "text/css; charset=utf-8",
    body: `@import "./theme.css";
body { background-image: url("../images/bg.png"); }
@font-face {
  font-family: "Fixture";
  src: url("../fonts/demo.woff2") format("woff2");
}`,
  },
  "/styles/theme.css": {
    contentType: "text/css; charset=utf-8",
    body: `.theme { background-image: url("../images/theme.png"); }`,
  },
  "/styles/extra.css": {
    contentType: "text/css; charset=utf-8",
    body: `.extra { background-image: url("../images/extra.png"); }`,
  },
  "/styles/frame.css": {
    contentType: "text/css; charset=utf-8",
    body: `.frame { background-image: url("../images/frame-bg.png"); }`,
  },
  "/scripts/app.js": {
    contentType: "application/javascript; charset=utf-8",
    body: `console.log("fixture app");`,
  },
  "/images/logo.png": {
    contentType: "image/png",
    body: Buffer.from("logo"),
  },
  "/images/logo@2x.png": {
    contentType: "image/png",
    body: Buffer.from("logo2"),
  },
  "/images/hero.jpg": {
    contentType: "image/jpeg",
    body: Buffer.from("hero"),
  },
  "/images/body-pattern.png": {
    contentType: "image/png",
    body: Buffer.from("body-pattern"),
  },
  "/images/bg.png": {
    contentType: "image/png",
    body: Buffer.from("bg"),
  },
  "/images/theme.png": {
    contentType: "image/png",
    body: Buffer.from("theme"),
  },
  "/images/extra.png": {
    contentType: "image/png",
    body: Buffer.from("extra"),
  },
  "/images/frame-bg.png": {
    contentType: "image/png",
    body: Buffer.from("frame"),
  },
  "/images/about.png": {
    contentType: "image/png",
    body: Buffer.from("about"),
  },
  "/fonts/demo.woff2": {
    contentType: "font/woff2",
    body: Buffer.from("font"),
  },
};

function createServer() {
  return http.createServer((request, response) => {
    if (!request.url) {
      response.statusCode = 400;
      response.end("missing url");
      return;
    }

    const pathname = new URL(request.url, "http://fixture.local").pathname;
    const route = routes[pathname];

    if (!route) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", route.contentType);
    response.end(route.body);
  });
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalReference(ownerFile: string, reference: string): string {
  const cleanReference = reference.split("#")[0];
  return path.resolve(path.dirname(ownerFile), cleanReference);
}

function makeOptions(outputDir: string, crawlDepth: number): MirrorOptions {
  return {
    outputDir,
    crawlDepth,
    concurrency: 6,
    timeoutMs: 5000,
    retries: 0,
    pageScope: "same-origin",
    assetScope: "all",
    userAgent: DEFAULT_USER_AGENT,
    verbose: false,
    stripIntegrity: true,
  };
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine fixture server address.");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe("MirrorEngine", () => {
  it("downloads assets and rewrites mirrored references to local files", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-"));
    const engine = new MirrorEngine(makeOptions(outputDir, 1));

    const result = await engine.mirror(`${baseUrl}/index.html`);
    const entryHtml = await fs.readFile(result.entryFile, "utf8");
    const launcherHtml = await fs.readFile(result.launcherFile, "utf8");
    const $ = load(entryHtml);

    expect(result.failedCount).toBe(0);
    expect(launcherHtml).toContain(path.basename(result.entryFile));
    expect(entryHtml).not.toContain("https://example-cdn.test");

    const stylesheetHref = $("link[rel='stylesheet']").attr("href");
    expect(stylesheetHref).toBeTruthy();
    expect(stylesheetHref?.startsWith("http")).toBe(false);
    expect(await fileExists(resolveLocalReference(result.entryFile, stylesheetHref!))).toBe(
      true,
    );

    const script = $("script[src]").first();
    const scriptSrc = script.attr("src");
    expect(scriptSrc?.startsWith("http")).toBe(false);
    expect(script.attr("integrity")).toBeUndefined();
    expect(script.attr("crossorigin")).toBeUndefined();
    expect(await fileExists(resolveLocalReference(result.entryFile, scriptSrc!))).toBe(
      true,
    );

    const imageSrc = $("#logo").attr("src");
    const srcset = $("#logo").attr("srcset") ?? "";
    expect(imageSrc?.startsWith("http")).toBe(false);
    expect(srcset).not.toContain(baseUrl);
    expect(await fileExists(resolveLocalReference(result.entryFile, imageSrc!))).toBe(
      true,
    );

    const aboutHref = $("#about-link").attr("href");
    expect(aboutHref?.startsWith("http")).toBe(false);
    expect(await fileExists(resolveLocalReference(result.entryFile, aboutHref!))).toBe(true);

    const iframeSrc = $("#frame").attr("src");
    expect(iframeSrc?.startsWith("http")).toBe(false);
    expect(await fileExists(resolveLocalReference(result.entryFile, iframeSrc!))).toBe(true);

    const formAction = $("#contact-form").attr("action");
    expect(formAction).toBe(`${baseUrl}/submit`);

    const cssRecord = result.records.find((record) =>
      record.localRelativePath.endsWith("/styles/main.css"),
    );
    expect(cssRecord).toBeTruthy();

    const cssText = await fs.readFile(cssRecord!.localAbsolutePath, "utf8");
    expect(cssText).not.toContain(baseUrl);
    expect(cssText).toContain("url(");

    await fs.rm(outputDir, { recursive: true, force: true });
  });

  it("keeps non-crawled page links absolute while still mirroring embedded documents", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "site-mirror-"));
    const engine = new MirrorEngine(makeOptions(outputDir, 0));

    const result = await engine.mirror(`${baseUrl}/index.html`);
    const entryHtml = await fs.readFile(result.entryFile, "utf8");
    const $ = load(entryHtml);

    const aboutHref = $("#about-link").attr("href");
    expect(aboutHref).toBe(`${baseUrl}/about/index.html`);

    const iframeSrc = $("#frame").attr("src");
    expect(iframeSrc?.startsWith("http")).toBe(false);
    expect(await fileExists(resolveLocalReference(result.entryFile, iframeSrc!))).toBe(true);

    await fs.rm(outputDir, { recursive: true, force: true });
  });
});
