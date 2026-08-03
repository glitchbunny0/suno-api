import pino from "pino";
import { Page } from "rebrowser-playwright-core";

const logger = pino();

/**
 * Pause for a specified number of seconds.
 * @param x Minimum number of seconds.
 * @param y Maximum number of seconds (optional).
 */
export const sleep = (x: number, y?: number): Promise<void> => {
  let timeout = x * 1000;
  if (y !== undefined && y !== x) {
    const min = Math.min(x, y);
    const max = Math.max(x, y);
    timeout = Math.floor(Math.random() * (max - min + 1) + min) * 1000;
  }
  // console.log(`Sleeping for ${timeout / 1000} seconds`);
  logger.info(`Sleeping for ${timeout / 1000} seconds`);

  return new Promise(resolve => setTimeout(resolve, timeout));
}

/**
 * @param target A Locator or a page
 * @returns {boolean} 
 */
export const isPage = (target: any): target is Page => {
  return target.constructor.name === 'Page';
}

/**
 * Waits for CAPTCHA image/resource requests to settle (any provider).
 * @param page
 * @param signal `const controller = new AbortController();`
 */
export const waitForRequests = (page: Page, signal: AbortSignal): Promise<void> => {
  return new Promise((resolve, reject) => {
    const urlPatterns = [
      /^https:\/\/img[a-zA-Z0-9]*\.hcaptcha\.com\/.*$/,
      /^https:\/\/.*\.hcaptcha\.com\/captcha\/.*$/,
      /^https:\/\/www\.google\.com\/recaptcha\/.*$/,
      /^https:\/\/www\.gstatic\.com\/recaptcha\/.*$/,
      /^https:\/\/challenges\.cloudflare\.com\/.*$/,
      /^https:\/\/.*\.arkoselabs\.com\/.*$/,
    ];

    const matchesCaptchaUrl = (url: string) => urlPatterns.some(p => p.test(url));

    let timeoutHandle: NodeJS.Timeout | null = null;
    let activeRequestCount = 0;
    let requestOccurred = false;

    const cleanupListeners = () => {
      page.off('request', onRequest);
      page.off('requestfinished', onRequestFinished);
      page.off('requestfailed', onRequestFinished);
      page.off('request', onInitialClear);
    };

    const resetTimeout = () => {
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      if (activeRequestCount === 0) {
        timeoutHandle = setTimeout(() => {
          cleanupListeners();
          resolve();
        }, 1000);
      }
    };

    const onRequest = (request: { url: () => string }) => {
      if (matchesCaptchaUrl(request.url())) {
        requestOccurred = true;
        activeRequestCount++;
        if (timeoutHandle)
          clearTimeout(timeoutHandle);
      }
    };

    const onRequestFinished = (request: { url: () => string }) => {
      if (matchesCaptchaUrl(request.url())) {
        activeRequestCount--;
        resetTimeout();
      }
    };

    const onInitialClear = (request: { url: () => string }) => {
      if (matchesCaptchaUrl(request.url())) {
        clearTimeout(initialTimeout);
      }
    };

    // Wait up to 2 minutes for a CAPTCHA request
    const initialTimeout = setTimeout(() => {
      if (!requestOccurred) {
        cleanupListeners();
        reject(new Error('No CAPTCHA image/resource requests detected within 2 minutes.'));
      } else {
        resetTimeout();
      }
    }, 120000);

    page.on('request', onRequest);
    page.on('requestfinished', onRequestFinished);
    page.on('requestfailed', onRequestFinished);
    page.on('request', onInitialClear);

    const onAbort = () => {
      cleanupListeners();
      clearTimeout(initialTimeout);
      if (timeoutHandle)
        clearTimeout(timeoutHandle);
      signal.removeEventListener('abort', onAbort);
      reject(new Error('AbortError'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

/**
 * Simple async mutex — one holder at a time, others queue.
 */
export class AsyncMutex {
  private queue: Array<(release: () => void) => void> = [];
  private locked = false;

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push((release) => resolve(release));
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next(() => this.release());
    } else {
      this.locked = false;
    }
  }

  get isLocked(): boolean { return this.locked; }
  get queueLength(): number { return this.queue.length; }
}

/**
 * Async semaphore — up to maxConcurrency holders.
 */
export class AsyncSemaphore {
  private currentCount = 0;
  private queue: Array<(release: () => void) => void> = [];

  constructor(private maxConcurrency: number) {
    if (!maxConcurrency || maxConcurrency < 1) this.maxConcurrency = 1;
  }

  async acquire(): Promise<() => void> {
    if (this.currentCount < this.maxConcurrency) {
      this.currentCount++;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push((release) => resolve(release));
    });
  }

  private release(): void {
    this.currentCount--;
    if (this.queue.length > 0) {
      this.currentCount++;
      const next = this.queue.shift()!;
      next(() => this.release());
    }
  }

  get activeCount(): number { return this.currentCount; }
  get waitingCount(): number { return this.queue.length; }
}