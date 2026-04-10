import type {
  MirrorOptions,
  PlaywrightBrowser,
  PlaywrightWaitUntil,
} from "./types.js";

export interface BrowserPageSnapshot {
  finalUrl: string;
  contentType: string;
  html: string;
}

export interface BrowserResourceSnapshot {
  finalUrl: string;
  contentType: string;
  body: Buffer;
}

export interface BrowserMirrorClient {
  renderPage(input: {
    url: string;
    referer?: string;
  }): Promise<BrowserPageSnapshot>;
  fetchResource(input: {
    url: string;
    referer?: string;
  }): Promise<BrowserResourceSnapshot>;
  close(): Promise<void>;
}

export type BrowserMirrorClientFactory = (
  options: MirrorOptions,
) => Promise<BrowserMirrorClient>;

function pickHeader(
  headers: Record<string, string>,
  name: string,
): string {
  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return "";
}

function selectBrowserType(
  playwright: {
    chromium: import("playwright").BrowserType;
    firefox: import("playwright").BrowserType;
    webkit: import("playwright").BrowserType;
  },
  browser: PlaywrightBrowser,
): import("playwright").BrowserType {
  switch (browser) {
    case "firefox":
      return playwright.firefox;
    case "webkit":
      return playwright.webkit;
    case "chromium":
    default:
      return playwright.chromium;
  }
}

function toPlaywrightWaitUntil(
  waitUntil: PlaywrightWaitUntil,
): import("playwright").WaitUntilState {
  switch (waitUntil) {
    case "domcontentloaded":
      return "domcontentloaded";
    case "networkidle":
      return "networkidle";
    case "load":
    default:
      return "load";
  }
}

export async function createPlaywrightMirrorClient(
  options: MirrorOptions,
): Promise<BrowserMirrorClient> {
  let playwright: typeof import("playwright");

  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright mode requires the optional `playwright` package. Install it with `npm install playwright`, then install a browser with `npx playwright install chromium`.",
    );
  }

  const browserType = selectBrowserType(playwright, options.playwrightBrowser);
  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: options.userAgent,
  });
  const waitUntil = toPlaywrightWaitUntil(options.playwrightWaitUntil);

  return {
    async renderPage({
      url,
      referer,
    }: {
      url: string;
      referer?: string;
    }): Promise<BrowserPageSnapshot> {
      const page = await context.newPage();

      try {
        const response = await page.goto(url, {
          referer,
          timeout: options.timeoutMs,
          waitUntil,
        });

        if (response && response.status() >= 400) {
          throw new Error(`Navigation failed with status ${response.status()}`);
        }

        if (options.playwrightWaitMs > 0) {
          await page.waitForTimeout(options.playwrightWaitMs);
        }

        return {
          finalUrl: page.url(),
          contentType: response ? pickHeader(response.headers(), "content-type") : "",
          html: await page.content(),
        };
      } finally {
        await page.close();
      }
    },

    async fetchResource({
      url,
      referer,
    }: {
      url: string;
      referer?: string;
    }): Promise<BrowserResourceSnapshot> {
      const response = await context.request.get(url, {
        failOnStatusCode: false,
        headers: referer ? { referer } : undefined,
        timeout: options.timeoutMs,
      });

      if (response.status() >= 400) {
        throw new Error(`Request failed with status ${response.status()}`);
      }

      return {
        finalUrl: response.url(),
        contentType: pickHeader(response.headers(), "content-type"),
        body: await response.body(),
      };
    },

    async close(): Promise<void> {
      await context.close();
      await browser.close();
    },
  };
}
