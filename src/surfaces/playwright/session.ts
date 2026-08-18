import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

/**
 * Owns the browser process; the surface does not.
 *
 * `PlaywrightSurface` receives an already-open page and never launches or closes
 * anything. Two things follow from that split. Tests can drive the surface against one
 * browser for a whole suite instead of paying a launch per case. And the later human
 * handoff can hand a person the very page the automation was using and take it back
 * afterwards, because no automation object believes it owns the session lifetime.
 */
export interface PlaywrightSessionOptions {
  /** Headed mode is what a human handoff will need; default stays headless for CI. */
  readonly headless?: boolean;
  readonly viewport?: { readonly width: number; readonly height: number };
}

export interface PlaywrightSession {
  readonly page: Page;
  close(): Promise<void>;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export async function launchPlaywrightSession(
  options: PlaywrightSessionOptions = {},
): Promise<PlaywrightSession> {
  const headless = options.headless ?? true;
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;

  const browser: Browser = await chromium.launch({ headless });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();

  return {
    page,
    async close(): Promise<void> {
      await context.close();
      await browser.close();
    },
  };
}
