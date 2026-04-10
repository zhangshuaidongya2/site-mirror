# site-mirror

[中文说明](./README.zh-CN.md)

A CLI tool that mirrors a website into a local offline snapshot.

Give it a URL and it will download the page HTML, CSS, JS, images, fonts, media, and other static assets, then rewrite resource references to local relative paths so the result can be opened directly from disk.

## Features

- Download the entry page HTML
- Download linked CSS, JS, images, fonts, and media assets
- Rewrite HTML `src`, `href`, `srcset`, and inline `style` references
- Rewrite CSS `@import` and `url(...)` references
- Optionally crawl additional HTML pages by depth and rewrite page links to local files
- Generate an offline launcher `index.html`
- Generate a `mirror-report.json` report

## Limits

This tool mirrors front-end resources available to the browser. It does not fetch the target site's server-side source code.

It does not include:

- backend code
- databases
- service logic behind runtime APIs
- protected content that is not exposed to the browser
- dynamic request chains that only appear after runtime execution and are not directly exposed in the fetched source

## Requirements

- Node.js 20+

## Install

```bash
npm install
npm run build
```

## Usage

Basic usage:

```bash
node dist/cli.js mirror https://example.com
```

Write output to a custom directory:

```bash
node dist/cli.js mirror https://example.com -o ./snapshots/example
```

The repository already ignores `./snapshots`, so you can use it to store downloaded site snapshots locally.

Crawl the current page plus one additional level of in-scope pages:

```bash
node dist/cli.js mirror https://example.com --depth 1
```

## Common Options

- `-o, --output <dir>` Output directory
- `--depth <number>` HTML crawl depth, default `0`
- `--concurrency <number>` Concurrent downloads, default `8`
- `--timeout <ms>` Per-request timeout in milliseconds, default `20000`
- `--retries <number>` Retry count for failed requests, default `2`
- `--page-scope <scope>` HTML crawl scope: `same-origin`, `same-host`, `all`
- `--asset-scope <scope>` Asset download scope: `same-origin`, `same-host`, `all`
- `--user-agent <ua>` Custom HTTP `User-Agent`
- `--keep-integrity` Keep SRI attributes instead of removing them after local rewrites
- `--verbose` Print saved files while mirroring

## Output Structure

The command generates a directory similar to:

```text
mirror-output/
  index.html
  mirror-report.json
  pages/
  assets/
```

- `index.html` is the offline entry point
- `pages/` contains mirrored HTML pages
- `assets/` contains CSS, JS, images, fonts, and other static files
- `mirror-report.json` records downloaded items and failures

## Development

```bash
npm test
npm run build
```
