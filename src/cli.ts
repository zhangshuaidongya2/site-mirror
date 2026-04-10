#!/usr/bin/env node

import path from "node:path";

import { Command, InvalidArgumentError } from "commander";

import { MirrorEngine } from "./mirror.js";
import type { MirrorOptions, ScopeMode } from "./types.js";
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
        verbose: Boolean(commandOptions.verbose),
        stripIntegrity: !commandOptions.keepIntegrity,
      };

      const engine = new MirrorEngine(options);
      const result = await engine.mirror(url);

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
