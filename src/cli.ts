#!/usr/bin/env node

import path from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { MirrorEngine } from "./mirror.js";
import type {
  MirrorProgress,
  MirrorMode,
  MirrorOptions,
  MirrorResult,
  PlaywrightBrowser,
  PlaywrightWaitUntil,
  ScopeMode,
} from "./types.js";
import { DEFAULT_USER_AGENT } from "./utils.js";

function parseInteger(name: string, minimum: number) {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < minimum) {
      throw new InvalidArgumentError(`${name} must be an integer >= ${minimum}`);
    }

    return parsed;
  };
}

function parseScope(value: string): ScopeMode {
  if (value === "same-origin" || value === "same-host" || value === "all") {
    return value;
  }

  throw new InvalidArgumentError(
    "scope must be one of: same-origin, same-host, all",
  );
}

function parseMode(value: string): MirrorMode {
  if (value === "http" || value === "playwright") {
    return value;
  }

  throw new InvalidArgumentError("mode must be one of: http, playwright");
}

function parsePlaywrightBrowser(value: string): PlaywrightBrowser {
  if (value === "chromium" || value === "firefox" || value === "webkit") {
    return value;
  }

  throw new InvalidArgumentError(
    "playwright browser must be one of: chromium, firefox, webkit",
  );
}

function parsePlaywrightWaitUntil(value: string): PlaywrightWaitUntil {
  if (
    value === "domcontentloaded" ||
    value === "load" ||
    value === "networkidle"
  ) {
    return value;
  }

  throw new InvalidArgumentError(
    "playwright wait-until must be one of: domcontentloaded, load, networkidle",
  );
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const head = Math.max(0, Math.floor((maxLength - 3) / 2));
  const tail = Math.max(0, maxLength - 3 - head);
  return `${value.slice(0, head)}...${value.slice(value.length - tail)}`;
}

function formatProgress(progress: MirrorProgress): string {
  const parts = [
    `found ${progress.discoveredCount}`,
    `active ${progress.inProgressCount}`,
    `done ${progress.downloadedCount}`,
  ];

  if (progress.pendingCount > 0) {
    parts.push(`pending ${progress.pendingCount}`);
  }

  if (progress.failedCount > 0) {
    parts.push(`failed ${progress.failedCount}`);
  }

  if (progress.currentUrl) {
    const kind = progress.currentKind ? `${progress.currentKind} ` : "";
    parts.push(`${kind}${truncateMiddle(progress.currentUrl, 72)}`);
  }

  return `Progress: ${parts.join(", ")}`;
}

function createProgressReporter(input: {
  url: string;
  outputDir: string;
  mode: MirrorMode;
}) {
  let latest: MirrorProgress | null = null;
  let lastRenderedLine = "";
  let timer: NodeJS.Timeout | undefined;

  const isInteractive = Boolean(process.stderr.isTTY);

  const render = (force = false) => {
    if (!latest) {
      return;
    }

    const line = formatProgress(latest);
    if (!force && line === lastRenderedLine) {
      return;
    }

    if (isInteractive) {
      const padded = line.padEnd(lastRenderedLine.length, " ");
      process.stderr.write(`\r${padded}`);
      lastRenderedLine = line;
      return;
    }

    process.stderr.write(`${line}\n`);
    lastRenderedLine = line;
  };

  return {
    start() {
      process.stderr.write(
        `Starting mirror: ${input.url}\nMode: ${input.mode}\nOutput: ${input.outputDir}\n`,
      );
      timer = setInterval(() => render(false), 1000);
      timer.unref();
    },

    update(progress: MirrorProgress) {
      latest = progress;
      if (progress.phase === "starting" || progress.phase === "fetching") {
        render(false);
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer);
      }

      render(true);

      if (isInteractive && lastRenderedLine.length > 0) {
        process.stderr.write("\n");
      }
    },
  };
}

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("site-mirror")
    .description("Mirror a URL into a local offline-openable snapshot.");

  program
    .command("mirror")
    .argument("<url>", "The entry page URL to mirror")
    .option(
      "-o, --output <dir>",
      "Output directory",
      path.resolve(process.cwd(), "mirror-output"),
    )
    .option(
      "--depth <number>",
      "How many same-scope HTML navigation levels to crawl",
      parseInteger("depth", 0),
      0,
    )
    .option(
      "--concurrency <number>",
      "Concurrent downloads",
      parseInteger("concurrency", 1),
      8,
    )
    .option(
      "--timeout <ms>",
      "Per-request timeout in milliseconds",
      parseInteger("timeout", 1000),
      20000,
    )
    .option(
      "--retries <number>",
      "Retry count for failed requests",
      parseInteger("retries", 0),
      2,
    )
    .option(
      "--page-scope <scope>",
      "HTML page crawl scope: same-origin, same-host, all",
      parseScope,
      "same-origin",
    )
    .option(
      "--asset-scope <scope>",
      "Asset download scope: same-origin, same-host, all",
      parseScope,
      "all",
    )
    .option(
      "--mode <mode>",
      "Mirroring mode: http, playwright",
      parseMode,
      "http",
    )
    .option(
      "--playwright-browser <name>",
      "Playwright browser engine: chromium, firefox, webkit",
      parsePlaywrightBrowser,
      "chromium",
    )
    .option(
      "--playwright-wait-until <state>",
      "Playwright navigation wait state: domcontentloaded, load, networkidle",
      parsePlaywrightWaitUntil,
      "load",
    )
    .option(
      "--playwright-wait-ms <ms>",
      "Extra delay after Playwright navigation completes",
      parseInteger("playwright-wait-ms", 0),
      1000,
    )
    .option("--user-agent <ua>", "HTTP User-Agent", DEFAULT_USER_AGENT)
    .option("--keep-integrity", "Keep SRI attributes instead of stripping them")
    .option("--verbose", "Print saved files as they are mirrored")
    .action(async (url: string, commandOptions) => {
      const options: MirrorOptions = {
        outputDir: path.resolve(commandOptions.output),
        crawlDepth: commandOptions.depth,
        concurrency: commandOptions.concurrency,
        timeoutMs: commandOptions.timeout,
        retries: commandOptions.retries,
        pageScope: commandOptions.pageScope,
        assetScope: commandOptions.assetScope,
        userAgent: commandOptions.userAgent,
        mode: commandOptions.mode,
        playwrightBrowser: commandOptions.playwrightBrowser,
        playwrightWaitUntil: commandOptions.playwrightWaitUntil,
        playwrightWaitMs: commandOptions.playwrightWaitMs,
        verbose: Boolean(commandOptions.verbose),
        stripIntegrity: !commandOptions.keepIntegrity,
      };

      const progressReporter = createProgressReporter({
        url,
        outputDir: options.outputDir,
        mode: options.mode,
      });
      const engine = new MirrorEngine(options, {
        onProgress: (progress) => {
          progressReporter.update(progress);
        },
      });
      progressReporter.start();

      let result: MirrorResult;
      try {
        result = await engine.mirror(url);
      } finally {
        progressReporter.stop();
      }

      console.log(`Entry: ${result.entryUrl}`);
      console.log(`Launcher: ${result.launcherFile}`);
      console.log(`Page: ${result.entryFile}`);
      console.log(`Report: ${result.reportFile}`);
      console.log(
        `Downloaded: ${result.downloadedCount}, Failed: ${result.failedCount}`,
      );
    });

  await program.parseAsync(process.argv);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`site-mirror failed: ${message}`);
  process.exitCode = 1;
});
