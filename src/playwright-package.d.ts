declare module "playwright" {
  export type WaitUntilState = "load" | "domcontentloaded" | "networkidle";

  export interface APIResponse {
    body(): Promise<Buffer>;
    headers(): Record<string, string>;
    status(): number;
    url(): string;
  }

  export interface Response {
    headers(): Record<string, string>;
    status(): number;
    url(): string;
  }

  export interface Page {
    close(): Promise<void>;
    content(): Promise<string>;
    goto(
      url: string,
      options?: {
        referer?: string;
        timeout?: number;
        waitUntil?: WaitUntilState;
      },
    ): Promise<Response | null>;
    url(): string;
    waitForTimeout(timeout: number): Promise<void>;
  }

  export interface APIRequestContext {
    get(
      url: string,
      options?: {
        failOnStatusCode?: boolean;
        headers?: Record<string, string>;
        timeout?: number;
      },
    ): Promise<APIResponse>;
  }

  export interface BrowserContext {
    close(): Promise<void>;
    newPage(): Promise<Page>;
    request: APIRequestContext;
  }

  export interface Browser {
    close(): Promise<void>;
    newContext(options?: {
      userAgent?: string;
    }): Promise<BrowserContext>;
  }

  export interface BrowserType {
    launch(options?: {
      headless?: boolean;
    }): Promise<Browser>;
  }

  export const chromium: BrowserType;
  export const firefox: BrowserType;
  export const webkit: BrowserType;
}
