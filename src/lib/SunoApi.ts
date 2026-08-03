import axios, { AxiosInstance } from 'axios';
import UserAgent from 'user-agents';
import pino from 'pino';
import yn from 'yn';
import { isPage, sleep, waitForRequests, AsyncMutex } from '@/lib/utils';
import * as cookie from 'cookie';
import { randomUUID } from 'node:crypto';
import { Solver } from '@2captcha/captcha-solver';
import { paramsCoordinates } from '@2captcha/captcha-solver/dist/structs/2captcha';
import { BrowserContext, Page, Locator, chromium, firefox } from 'rebrowser-playwright-core';
import { createCursor, Cursor } from 'ghost-cursor-playwright';
import { promises as fs } from 'fs';
import path from 'node:path';

// sunoApi instance caching
const globalForSunoApi = global as unknown as { sunoApiCache?: Map<string, SunoApi> };
const cache = globalForSunoApi.sunoApiCache || new Map<string, SunoApi>();
globalForSunoApi.sunoApiCache = cache;

const logger = pino();
export const DEFAULT_MODEL = 'chirp-crow'; // v5 (newest)

// ── Utility functions ──────────────────────────────────────────────

/**
 * Ensure error objects are proper Error instances.
 */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  if (error && typeof error === 'object' && 'message' in error)
    return new Error(String((error as any).message));
  return new Error('Unknown error occurred');
}

/**
 * Validate that a parameter is a non-empty string.
 */
function validateRequiredString(value: unknown, paramName: string): asserts value is string {
  if (typeof value !== 'string')
    throw new Error(`Invalid parameter '${paramName}': expected string, got ${typeof value}`);
  if (value.trim().length === 0)
    throw new Error(`Invalid parameter '${paramName}': must not be empty`);
}

/**
 * Validate that a parameter is a string or null/undefined.
 */
function validateOptionalString(value: unknown, paramName: string): asserts value is string | null | undefined {
  if (value !== null && value !== undefined && typeof value !== 'string')
    throw new Error(`Invalid parameter '${paramName}': expected string, null, or undefined, got ${typeof value}`);
}

/**
 * Validate that a parameter is a number.
 */
function validateNumber(value: unknown, paramName: string): asserts value is number {
  if (typeof value !== 'number' || isNaN(value))
    throw new Error(`Invalid parameter '${paramName}': expected number, got ${typeof value}`);
}

// ── Types ──────────────────────────────────────────────────────────

export interface AudioInfo {
  id: string;
  title?: string;
  image_url?: string;
  lyric?: string;
  audio_url?: string;
  video_url?: string;
  created_at: string;
  model_name: string;
  gpt_description_prompt?: string;
  prompt?: string;
  status: string;
  type?: string;
  tags?: string;
  negative_tags?: string;
  duration?: string;
  error_message?: string;
  stem_from_id?: string;
}

interface PersonaResponse {
  persona: {
    id: string;
    name: string;
    description: string;
    image_s3_id: string;
    root_clip_id: string;
    clip: any;
    user_display_name: string;
    user_handle: string;
    user_image_url: string;
    persona_clips: Array<{ clip: any }>;
    is_suno_persona: boolean;
    is_trashed: boolean;
    is_owned: boolean;
    is_public: boolean;
    is_public_approved: boolean;
    is_loved: boolean;
    upvote_count: number;
    clip_count: number;
  };
  total_results: number;
  current_page: number;
  is_following: boolean;
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CaptchaSolution {
  id: string;
  data: Array<{ x: number; y: number }>;
}

// ── Main class ─────────────────────────────────────────────────────

class SunoApi {
  private static BASE_URL: string = 'https://studio-api.prod.suno.com';
  private static CLERK_BASE_URL: string = 'https://auth.suno.com';
  private static CLERK_VERSION = '5.117.0';
  private static CLERK_API_VERSION = '2025-11-10';

  /**
   * Centralized timeout configuration (ms unless noted).
   * All values can be overridden via environment variables.
   */
  private static readonly TIMEOUTS = {
    PAGE_NAVIGATION: Number(process.env.TIMEOUT_PAGE_NAVIGATION) || 0,
    PAGE_API_RESPONSE: Number(process.env.TIMEOUT_PAGE_API_RESPONSE) || 30000,
    POPUP_CLOSE: Number(process.env.TIMEOUT_POPUP_CLOSE) || 2000,
    TEXTAREA_WAIT: Number(process.env.TIMEOUT_TEXTAREA_WAIT) || 3000,
    CREATE_BUTTON_WAIT: Number(process.env.TIMEOUT_CREATE_BUTTON_WAIT) || 5000,
    CAPTCHA_SCREENSHOT: Number(process.env.TIMEOUT_CAPTCHA_SCREENSHOT) || 5000,
    CAPTCHA_IMAGE_LOAD_DELAY: Number(process.env.TIMEOUT_CAPTCHA_IMAGE_LOAD) || 3,
    CAPTCHA_PIECE_UNLOCK_DELAY: Number(process.env.TIMEOUT_CAPTCHA_PIECE_UNLOCK) || 1.1,
    API_CONCATENATE: Number(process.env.TIMEOUT_API_CONCATENATE) || 10000,
    API_GENERATE: Number(process.env.TIMEOUT_API_GENERATE) || 10000,
    API_FEED: Number(process.env.TIMEOUT_API_FEED) || 10000,
    API_PERSONA: Number(process.env.TIMEOUT_API_PERSONA) || 10000,
    KEEP_ALIVE_SLEEP_MIN: Number(process.env.TIMEOUT_KEEP_ALIVE_MIN) || 1,
    KEEP_ALIVE_SLEEP_MAX: Number(process.env.TIMEOUT_KEEP_ALIVE_MAX) || 2,
    LYRICS_POLL_DELAY: Number(process.env.TIMEOUT_LYRICS_POLL) || 2,
    AUDIO_POLL_DELAY_MIN: Number(process.env.TIMEOUT_AUDIO_POLL_MIN) || 3,
    AUDIO_POLL_DELAY_MAX: Number(process.env.TIMEOUT_AUDIO_POLL_MAX) || 6,
    AUDIO_POLL_INITIAL_DELAY: Number(process.env.TIMEOUT_AUDIO_POLL_INITIAL) || 5,
    AUDIO_GENERATION_MAX: Number(process.env.TIMEOUT_AUDIO_GENERATION_MAX) || 100000,
  } as const;

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private deviceId?: string;
  private userAgent?: string;
  private cookies: Record<string, string | undefined>;
  private solver = new Solver(`${process.env.TWOCAPTCHA_KEY}`);
  private ghostCursorEnabled = yn(process.env.BROWSER_GHOST_CURSOR, { default: false });
  private cursor?: Cursor;
  private captchaMutex = new AsyncMutex();

  constructor(cookies: string) {
    this.userAgent = new UserAgent(/Macintosh/).random().toString();
    this.cookies = cookie.parse(cookies);
    this.deviceId = this.cookies.ajs_anonymous_id || randomUUID();
    this.client = axios.create({
      withCredentials: true,
      headers: {
        'Affiliate-Id': 'undefined',
        'Device-Id': `"${this.deviceId}"`,
        'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
        'X-Requested-With': 'com.suno.android',
        'sec-ch-ua': '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'User-Agent': this.userAgent
      }
    });
    this.client.interceptors.request.use(config => {
      if (this.currentToken && !config.headers.Authorization)
        config.headers.Authorization = `Bearer ${this.currentToken}`;
      const cookiesArray = Object.entries(this.cookies).map(([key, value]) =>
        cookie.serialize(key, value as string)
      );
      config.headers.Cookie = cookiesArray.join('; ');
      return config;
    });
    this.client.interceptors.response.use(resp => {
      const setCookieHeader = resp.headers['set-cookie'];
      if (Array.isArray(setCookieHeader)) {
        const newCookies = cookie.parse(setCookieHeader.join('; '));
        for (const [key, value] of Object.entries(newCookies)) {
          this.cookies[key] = value;
        }
      }
      return resp;
    });
  }

  public async init(): Promise<SunoApi> {
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  // ── Authentication ───────────────────────────────────────────────

  private async getAuthToken() {
    logger.info('Getting the session ID from auth.suno.com');
    const getSessionUrl = `${SunoApi.CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}&__clerk_api_version=${SunoApi.CLERK_API_VERSION}`;
    const sessionResponse = await this.client.get(getSessionUrl, {
      headers: { Authorization: this.cookies.__client as string }
    });
    if (!sessionResponse?.data?.response?.last_active_session_id) {
      throw new Error('Failed to get session id, you may need to update the SUNO_COOKIE');
    }
    this.sid = sessionResponse.data.response.last_active_session_id;
  }

  public async keepAlive(isWait?: boolean): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    const renewUrl = `${SunoApi.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_is_native=true&_clerk_js_version=${SunoApi.CLERK_VERSION}&__clerk_api_version=${SunoApi.CLERK_API_VERSION}`;
    logger.info('KeepAlive...\n');
    const renewResponse = await this.client.post(renewUrl, {}, {
      headers: { Authorization: this.cookies.__client as string }
    });
    if (isWait) {
      await sleep(SunoApi.TIMEOUTS.KEEP_ALIVE_SLEEP_MIN, SunoApi.TIMEOUTS.KEEP_ALIVE_SLEEP_MAX);
    }
    this.currentToken = renewResponse.data.jwt;
  }

  private async captchaRequired(): Promise<boolean> {
    const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
      ctype: 'generation'
    });
    return resp.data.required;
  }

  // ── Browser / CAPTCHA ────────────────────────────────────────────

  private async click(target: Locator | Page, position?: { x: number, y: number }): Promise<void> {
    if (this.ghostCursorEnabled) {
      let pos: BoundingBox | { x: number; y: number } = isPage(target) ? { x: 0, y: 0 } : await target.boundingBox() as BoundingBox;
      if (position) {
        const basePos = 'width' in pos ? pos : { ...pos, width: 0, height: 0 };
        pos = {
          x: basePos.x + position.x,
          y: basePos.y + position.y,
          width: (basePos as BoundingBox).width,
          height: (basePos as BoundingBox).height,
        };
      }
      return this.cursor?.actions.click({ target: pos });
    } else {
      if (isPage(target))
        return target.mouse.click(position?.x ?? 0, position?.y ?? 0);
      else
        return target.click({ force: true, position });
    }
  }

  private getBrowserType() {
    const browser = process.env.BROWSER?.toLowerCase();
    switch (browser) {
      case 'firefox':
        return firefox;
      default:
        return chromium;
    }
  }

  /**
   * Launch a browser with proper Clerk cookie setup.
   * Key fix: Do NOT inject __session — let Clerk JS create it via two-step navigation.
   */
  private async launchBrowser(): Promise<BrowserContext> {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-features=site-per-process',
      '--disable-features=IsolateOrigins',
      '--disable-extensions',
      '--disable-infobars'
    ];
    if (yn(process.env.BROWSER_DISABLE_GPU, { default: false }))
      args.push('--enable-unsafe-swiftshader', '--disable-gpu', '--disable-setuid-sandbox');
    const browser = await this.getBrowserType().launch({
      args,
      headless: yn(process.env.BROWSER_HEADLESS, { default: true })
    });
    const context = await browser.newContext({ userAgent: this.userAgent, locale: process.env.BROWSER_LOCALE, viewport: null });

    const lax: 'Lax' | 'Strict' | 'None' = 'Lax';
    const none: 'Lax' | 'Strict' | 'None' = 'None';
    const cookies: Array<{ name: string; value: string; domain: string; path: string; sameSite: 'Lax' | 'Strict' | 'None'; secure?: boolean; httpOnly?: boolean }> = [];

    // DO NOT set __session — Clerk JS creates it after validating __client.
    // Set most cookies on .suno.com (skip __client/__client_uat, handled separately)
    for (const key in this.cookies) {
      if (key === '__client' || key === '__client_uat') continue;
      cookies.push({
        name: key,
        value: `${this.cookies[key]}`,
        domain: '.suno.com',
        path: '/',
        sameSite: lax
      });
    }

    // __client on both auth.suno.com (for suno.com) and clerk.suno.com (for accounts.suno.com)
    if (this.cookies.__client) {
      cookies.push({
        name: '__client', value: `${this.cookies.__client}`,
        domain: 'auth.suno.com', path: '/', sameSite: none, secure: true, httpOnly: true
      });
      cookies.push({
        name: '__client', value: `${this.cookies.__client}`,
        domain: 'clerk.suno.com', path: '/', sameSite: lax, secure: true, httpOnly: true
      });
    }

    // __client_uat: auth.suno.com gets "0", .suno.com gets the real timestamp.
    // The plain __client_uat is often "0" — find the real one from session-variant cookies.
    let clientUatTimestamp = this.cookies.__client_uat || '0';
    for (const key in this.cookies) {
      if (key.startsWith('__client_uat_') && this.cookies[key] && this.cookies[key] !== '0') {
        clientUatTimestamp = this.cookies[key]!;
        break;
      }
    }

    if (clientUatTimestamp && clientUatTimestamp !== '0') {
      cookies.push({ name: '__client_uat', value: '0', domain: 'auth.suno.com', path: '/', sameSite: none, secure: true });
      cookies.push({ name: '__client_uat', value: clientUatTimestamp, domain: '.suno.com', path: '/', sameSite: lax, secure: true });
    } else {
      logger.warn('No valid __client_uat timestamp found! Browser auth will fail.');
    }

    await context.addCookies(cookies);
    return context;
  }

  /**
   * Solve a CAPTCHA challenge with retry logic.
   */
  private async solveCaptchaWithRetry(challenge: Locator, isDrag: boolean): Promise<CaptchaSolution> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        logger.info('Sending the CAPTCHA to 2Captcha');
        const payload: paramsCoordinates = {
          body: (await challenge.screenshot({ timeout: SunoApi.TIMEOUTS.CAPTCHA_SCREENSHOT })).toString('base64'),
          lang: process.env.BROWSER_LOCALE
        };
        if (isDrag) {
          payload.textinstructions = 'CLICK on the shapes at their edge or center as shown above—please be precise!';
          payload.imginstructions = (await fs.readFile(path.join(process.cwd(), 'public', 'drag-instructions.jpg'))).toString('base64');
        }
        return await this.solver.coordinates(payload) as unknown as CaptchaSolution;
      } catch (err) {
        const error = toError(err);
        if (attempt < 2) {
          logger.info(`${error.message} — retrying...`);
        } else {
          throw error;
        }
      }
    }
    throw new Error('Failed to solve CAPTCHA after 3 attempts');
  }

  // ── v2 CAPTCHA helpers (from PR #271) ─────────────────────────────

  /**
   * Poll multiple selectors until one becomes visible.
   * Resistant to Suno UI changes — tries 10+ selectors in rotation.
   */
  private async waitForAnyVisibleLocator(page: Page, selectors: string[], timeout = 15000): Promise<Locator | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      for (const selector of selectors) {
        const locator = page.locator(selector).first();
        if (await locator.isVisible().catch(() => false))
          return locator;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * Save HTML, screenshot, and frame list to debug/ for troubleshooting.
   */
  private async saveDebugSnapshot(page: Page, label: string, requestLog?: string[]): Promise<void> {
    const debugDir = path.join(process.cwd(), 'debug');
    try {
      await fs.mkdir(debugDir, { recursive: true });
      await fs.writeFile(path.join(debugDir, `${label}.html`), await page.content());
      await page.screenshot({ path: path.join(debugDir, `${label}.png`), fullPage: true });
      if (requestLog)
        await fs.writeFile(path.join(debugDir, `${label}-requests.log`), requestLog.join('\n'));
      const frameUrls = page.frames().map(f => f.url());
      await fs.writeFile(path.join(debugDir, `${label}-frames.log`), frameUrls.join('\n'));
      logger.info(`Debug snapshot saved: debug/${label}.*`);
    } catch (e: any) {
      logger.warn(`Failed to save debug snapshot "${label}": ${e.message}`);
    }
  }

  /**
   * Wait for any CAPTCHA iframe to appear. Detects hCaptcha, reCAPTCHA, Turnstile, Arkose.
   */
  private async waitForCaptchaFrame(page: Page, timeout = 15000): Promise<string | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const frames = page.frames();
      for (const frame of frames) {
        const url = frame.url().toLowerCase();
        if (url.includes('hcaptcha.com')) return 'hcaptcha';
        if (url.includes('recaptcha')) return 'recaptcha';
        if (url.includes('challenges.cloudflare.com') || url.includes('turnstile')) return 'turnstile';
        if (url.includes('arkoselabs.com') || url.includes('funcaptcha')) return 'arkose';
      }
      for (const selector of [
        'iframe[title*="hCaptcha" i]', 'iframe[title*="recaptcha" i]',
        'iframe[title*="Cloudflare" i]', 'iframe[src*="hcaptcha" i]',
      ]) {
        if (await page.locator(selector).first().isVisible().catch(() => false)) {
          if (selector.includes('hcaptcha') || selector.includes('hCaptcha')) return 'hcaptcha';
          if (selector.includes('recaptcha')) return 'recaptcha';
          return 'unknown';
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  /**
   * Check and solve CAPTCHA if required (v2 rewrite).
   * Uses multi-selector polling, popup dismissal, route interception before click,
   * multi-provider CAPTCHA detection, and debug snapshots.
   * Serialized via captchaMutex — only one browser session at a time.
   */
  public async getCaptcha(): Promise<string | null> {
    if (!await this.captchaRequired())
      return null;

    const releaseCaptcha = await this.captchaMutex.acquire();
    if (this.captchaMutex.queueLength > 0)
      logger.info(`CAPTCHA mutex: ${this.captchaMutex.queueLength} request(s) waiting`);

    try {
      // Re-check after lock — previous caller may have already solved it
      if (!await this.captchaRequired())
        return null;

      return await this._solveCaptchaV2();
    } finally {
      releaseCaptcha();
    }
  }

  private async _solveCaptchaV2(): Promise<string | null> {
    logger.info('CAPTCHA required. Launching browser (v2)...');
    const browser = await this.launchBrowser();
    const page = await browser.newPage();

    const requestLog: string[] = [];
    page.on('request', (req: any) => {
      const url: string = req.url();
      if (!url.startsWith('data:') && !url.endsWith('.woff2') && !url.endsWith('.woff'))
        requestLog.push(`[${new Date().toISOString()}] ${req.method()} ${url}`);
    });

    // STEP 1: Navigate to homepage first to let Clerk JS establish the session
    logger.info('Step 1: Navigating to suno.com homepage...');
    await page.goto('https://suno.com', {
      referer: 'https://www.google.com/',
      waitUntil: 'domcontentloaded',
      timeout: SunoApi.TIMEOUTS.PAGE_NAVIGATION || 60000
    });
    try {
      await page.waitForResponse(
        response => response.url().includes('auth.suno.com/v1/client') && response.status() === 200,
        { timeout: 10000 }
      );
      logger.info('Clerk authentication response received');
      await sleep(2);
    } catch {
      logger.warn('Clerk auth response timeout — continuing anyway');
    }

    // STEP 2: Navigate to create page
    logger.info('Step 2: Navigating to suno.com/create...');
    await page.goto('https://suno.com/create', {
      referer: 'https://suno.com/',
      waitUntil: 'domcontentloaded',
      timeout: SunoApi.TIMEOUTS.PAGE_NAVIGATION || 60000
    });

    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch {
      logger.warn('Network did not reach idle state within 30s; continuing');
    }

    await this.saveDebugSnapshot(page, '01-page-loaded', requestLog);

    if (this.ghostCursorEnabled)
      this.cursor = await createCursor(page);

    // Close popups / modals / banners
    for (const closeSelector of [
      'button[aria-label="Close"]', '[aria-label="close"]', '[aria-label="Dismiss"]',
      'button:has-text("Got it")', 'button:has-text("Accept")', 'button:has-text("OK")',
    ]) {
      try {
        const closeBtn = page.locator(closeSelector).first();
        if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
          await closeBtn.click({ timeout: 1000 });
          logger.info(`Closed popup via ${closeSelector}`);
        }
      } catch {}
    }

    // STEP 3: Find and fill the prompt input (10 fallback selectors)
    logger.info('Looking for prompt input');
    const promptSelectors = [
      '.custom-textarea',
      'textarea[placeholder*="lyrics" i]',
      'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="song" i]',
      'textarea[placeholder*="prompt" i]',
      'textarea:visible',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'div[role="textbox"]',
      'input[type="text"]',
    ];
    const promptInput = await this.waitForAnyVisibleLocator(page, promptSelectors, 15000);
    if (promptInput) {
      const desc = await promptInput.evaluate((el: Element) =>
        `${el.tagName}.${el.className} placeholder="${el.getAttribute('placeholder') || ''}"`
      ).catch(() => 'unknown');
      logger.info(`Found prompt input: ${desc}`);
      await this.click(promptInput);
      await new Promise(r => setTimeout(r, 300));
      await promptInput.pressSequentially('Lorem ipsum dolor sit amet', { delay: 60 });
    } else {
      logger.warn('No prompt input found anywhere on page');
      await this.saveDebugSnapshot(page, '03-no-prompt-input', requestLog);
    }

    // STEP 4: Find the Create / Generate button (8 fallback selectors)
    logger.info('Looking for Create/Generate button');
    const buttonSelectors = [
      'button[aria-label="Create"]',
      'button:has-text("Create")',
      '[role="button"]:has-text("Create")',
      'button[type="submit"]',
      'button:has-text("Generate")',
      '[role="button"]:has-text("Generate")',
      'button:has-text("Make a song")',
      'button:has-text("Submit")',
    ];
    const button = await this.waitForAnyVisibleLocator(page, buttonSelectors, 15000);
    if (!button) {
      logger.error('Could not find any Create/Generate button');
      await this.saveDebugSnapshot(page, '04-no-create-button', requestLog);
      await browser.browser()?.close();
      throw new Error('Could not find a Create/Generate button. Check debug/ folder for HTML snapshots.');
    }

    const buttonInfo = await button.evaluate((el: Element) =>
      `<${el.tagName} class="${el.className}" aria-label="${el.getAttribute('aria-label') || ''}">${(el as HTMLElement).innerText?.slice(0, 40)}`
    ).catch(() => 'unknown');
    logger.info(`Found button: ${buttonInfo}`);

    // STEP 5: Set up route interception BEFORE clicking (so we never miss the token)
    const controller = new AbortController();
    const tokenPromise = new Promise<string | null>((resolve, reject) => {
      page.route('**/api/generate/v2/**', async (route: any) => {
        try {
          logger.info('Generate API call intercepted! Extracting token and closing browser');
          const request = route.request();
          this.currentToken = request.headers().authorization?.split('Bearer ').pop();
          const postData = request.postDataJSON();
          route.abort();
          controller.abort();
          browser.browser()?.close().catch(() => {});
          resolve(postData?.token || postData?.hcaptcha_token || null);
        } catch (err) {
          reject(toError(err));
        }
      });
    });

    // STEP 6: Click Create and wait for CAPTCHA
    logger.info('Clicking Create button');
    await this.click(button);
    await new Promise(r => setTimeout(r, 3000));
    await this.saveDebugSnapshot(page, '05-after-create-click', requestLog);

    // STEP 7: Detect CAPTCHA type
    logger.info('Waiting for CAPTCHA challenge to appear...');
    let captchaType = await this.waitForCaptchaFrame(page, 15000);

    if (!captchaType) {
      // Retry the click — sometimes the first one is swallowed
      logger.warn('No CAPTCHA detected after first click. Retrying...');
      await this.click(button);
      await new Promise(r => setTimeout(r, 5000));
      await this.saveDebugSnapshot(page, '06-after-second-click', requestLog);
      captchaType = await this.waitForCaptchaFrame(page, 20000);
    }

    if (!captchaType) {
      // Maybe CAPTCHA wasn't needed — check if generation already proceeded
      logger.warn('No CAPTCHA iframe found. Checking if generation proceeded without CAPTCHA...');
      const raceResult = await Promise.race([
        tokenPromise.then(t => ({ type: 'token' as const, value: t })),
        new Promise<{ type: 'timeout' }>(r => setTimeout(() => r({ type: 'timeout' }), 10000)),
      ]);
      if (raceResult.type === 'token') {
        logger.info('Generation proceeded without visible CAPTCHA');
        return raceResult.value;
      }
      await this.saveDebugSnapshot(page, '07-no-captcha-final', requestLog);
      await browser.browser()?.close();
      throw new Error('No CAPTCHA appeared and generation did not proceed. Check debug/ folder.');
    }

    logger.info(`Detected CAPTCHA type: ${captchaType}`);

    // Cloudflare Turnstile is invisible/managed — no visual puzzle to solve.
    // It runs in the background and, when it passes, the generate request fires
    // automatically. We just need to wait for the route interceptor to catch it.
    // Same for reCAPTCHA v3 (invisible score-based).
    if (captchaType === 'turnstile' || captchaType === 'recaptcha') {
      logger.info(`${captchaType} is invisible/managed — waiting for it to pass and generate request to fire...`);
      const timeoutMs = captchaType === 'turnstile' ? 30000 : 30000;
      const result = await Promise.race([
        tokenPromise,
        new Promise<null>(resolve => setTimeout(() => {
          logger.warn(`${captchaType} did not resolve within ${timeoutMs / 1000}s`);
          resolve(null);
        }, timeoutMs))
      ]);
      if (result) {
        logger.info(`Generate request captured after ${captchaType} pass!`);
      }
      await browser.browser()?.close().catch(() => {});
      return result;
    }

    if (captchaType !== 'hcaptcha') {
      await this.saveDebugSnapshot(page, '08-unsupported-captcha', requestLog);
      await browser.browser()?.close();
      throw new Error(`Detected "${captchaType}" — only hCaptcha and Turnstile are supported.`);
    }

    // STEP 8: Solve hCaptcha challenges in a loop
    logger.info('Starting hCaptcha solving loop');
    const captchaSolverPromise = new Promise<void>(async (resolve, reject) => {
      const frame = page.frameLocator('iframe[title*="hCaptcha"]');
      const challenge = frame.locator('.challenge-container');
      try {
        let wait = false; // first iteration: images already loaded
        while (true) {
          if (wait)
            await waitForRequests(page, controller.signal);

          await challenge.waitFor({ state: 'visible', timeout: 60000 });
          const promptText = await challenge.locator('.prompt-text').first().innerText({ timeout: 15000 }).catch(() => '');
          const isDrag = promptText.toLowerCase().includes('drag');

          const solution = await this.solveCaptchaWithRetry(challenge, isDrag);

          if (isDrag) {
            const challengeBox = await challenge.boundingBox();
            if (!challengeBox)
              throw new Error('.challenge-container boundingBox is null!');
            if (solution.data.length % 2 !== 0) {
              logger.info('Drag solution has odd points — requesting new solution...');
              this.solver.badReport(solution.id);
              wait = false;
              continue;
            }
            for (let i = 0; i < solution.data.length; i += 2) {
              const startPt = solution.data[i];
              const endPt = solution.data[i + 1];
              await page.mouse.move(challengeBox.x + +startPt.x, challengeBox.y + +startPt.y);
              await page.mouse.down();
              await sleep(SunoApi.TIMEOUTS.CAPTCHA_PIECE_UNLOCK_DELAY);
              await page.mouse.move(challengeBox.x + +endPt.x, challengeBox.y + +endPt.y, { steps: 30 });
              await page.mouse.up();
            }
            wait = true;
          } else {
            for (const coord of solution.data) {
              await this.click(challenge, { x: +coord.x, y: +coord.y });
            }
            wait = true;
          }

          this.click(frame.locator('.button-submit')).catch(e => {
            const error = toError(e);
            if (error.message.includes('viewport'))
              this.click(button);
            else
              throw error;
          });
        }
      } catch (e) {
        const error = toError(e);
        if (error.message.includes('been closed') || error.message === 'AbortError')
          resolve();
        else
          reject(error);
      }
    });

    // Wire solver errors into the token promise
    captchaSolverPromise.catch(e => {
      browser.browser()?.close().catch(() => {});
      // Don't reject — just log. tokenPromise will time out gracefully.
      logger.error(`CAPTCHA solver error: ${toError(e).message}`);
    });
    captchaSolverPromise.catch(() => {});

    // Safety timeout — if token is never captured, bail after 120s
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => {
        logger.warn('getCaptcha overall timeout (120s) — returning null token');
        browser.browser()?.close().catch(() => {});
        controller.abort();
        resolve(null);
      }, 120000);
    });

    return Promise.race([tokenPromise, timeoutPromise]);
  }

  // ── Generation ───────────────────────────────────────────────────

  public async generate(
    prompt: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false
  ): Promise<AudioInfo[]> {
    validateRequiredString(prompt, 'prompt');
    validateOptionalString(model, 'model');
    await this.keepAlive(false);
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt, false, undefined, undefined, make_instrumental, model, wait_audio
    );
    logger.info(`Generate cost: ${Date.now() - startTime}ms`);
    return audios;
  }

  public async concatenate(clip_id: string): Promise<AudioInfo> {
    validateRequiredString(clip_id, 'clip_id');
    await this.keepAlive(false);
    const response = await this.client.post<AudioInfo>(
      `${SunoApi.BASE_URL}/api/generate/concat/v2/`,
      { clip_id },
      { timeout: SunoApi.TIMEOUTS.API_CONCATENATE }
    );
    if (response.status !== 200)
      throw new Error(`Error response: ${response.statusText}`);
    return response.data;
  }

  public async custom_generate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string
  ): Promise<AudioInfo[]> {
    validateRequiredString(prompt, 'prompt');
    validateRequiredString(tags, 'tags');
    validateRequiredString(title, 'title');
    validateOptionalString(model, 'model');
    const startTime = Date.now();
    const audios = await this.generateSongs(
      prompt, true, tags, title, make_instrumental, model, wait_audio, negative_tags
    );
    logger.info(`Custom generate cost: ${Date.now() - startTime}ms`);
    return audios;
  }

  private async generateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    make_instrumental?: boolean,
    model?: string,
    wait_audio: boolean = false,
    negative_tags?: string,
    task?: string,
    continue_clip_id?: string,
    continue_at?: number
  ): Promise<AudioInfo[]> {
    await this.keepAlive();
    const payload: any = {
      make_instrumental,
      mv: model || DEFAULT_MODEL,
      prompt: '',
      generation_type: task === 'extend' ? 'EXTEND' : 'TEXT',
      continue_at,
      continue_clip_id,
      task,
      token: await this.getCaptcha()
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/v2/`,
      payload,
      { timeout: SunoApi.TIMEOUTS.API_GENERATE }
    );
    if (response.status !== 200)
      throw new Error(`Error response: ${response.statusText}`);

    const songIds = response.data.clips.map((audio: any) => audio.id);

    if (wait_audio) {
      const startTime = Date.now();
      let lastResponse: AudioInfo[] = [];
      await sleep(SunoApi.TIMEOUTS.AUDIO_POLL_INITIAL_DELAY, SunoApi.TIMEOUTS.AUDIO_POLL_INITIAL_DELAY);
      while (Date.now() - startTime < SunoApi.TIMEOUTS.AUDIO_GENERATION_MAX) {
        const pollResponse = await this.get(songIds);
        const allCompleted = pollResponse.every(a => a.status === 'streaming' || a.status === 'complete');
        const allError = pollResponse.every(a => a.status === 'error');
        if (allCompleted || allError) return pollResponse;
        lastResponse = pollResponse;
        await sleep(SunoApi.TIMEOUTS.AUDIO_POLL_DELAY_MIN, SunoApi.TIMEOUTS.AUDIO_POLL_DELAY_MAX);
        await this.keepAlive(true);
      }
      return lastResponse;
    } else {
      return response.data.clips.map((audio: any): AudioInfo => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        negative_tags: audio.metadata.negative_tags,
        duration: audio.metadata.duration
      }));
    }
  }

  public async generateLyrics(prompt: string): Promise<string> {
    validateRequiredString(prompt, 'prompt');
    await this.keepAlive(false);
    const generateResponse = await this.client.post(
      `${SunoApi.BASE_URL}/api/generate/lyrics/`,
      { prompt }
    );
    const generateId = generateResponse.data.id;

    let lyricsResponse = await this.client.get(
      `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
    );
    while (lyricsResponse?.data?.status !== 'complete') {
      await sleep(SunoApi.TIMEOUTS.LYRICS_POLL_DELAY);
      lyricsResponse = await this.client.get(
        `${SunoApi.BASE_URL}/api/generate/lyrics/${generateId}`
      );
    }
    return lyricsResponse.data;
  }

  public async extendAudio(
    audioId: string,
    prompt: string = '',
    continueAt: number,
    tags: string = '',
    negative_tags: string = '',
    title: string = '',
    model?: string,
    wait_audio?: boolean
  ): Promise<AudioInfo[]> {
    validateRequiredString(audioId, 'audioId');
    validateNumber(continueAt, 'continueAt');
    return this.generateSongs(prompt, true, tags, title, false, model, wait_audio, negative_tags, 'extend', audioId, continueAt);
  }

  public async generateStems(song_id: string): Promise<AudioInfo[]> {
    validateRequiredString(song_id, 'song_id');
    await this.keepAlive(false);
    const response = await this.client.post(
      `${SunoApi.BASE_URL}/api/edit/stems/${song_id}`, {}
    );
    return response.data.clips.map((clip: any): AudioInfo => ({
      id: clip.id,
      status: clip.status,
      created_at: clip.created_at,
      title: clip.title,
      model_name: clip.model_name,
      stem_from_id: clip.metadata.stem_from_id,
      duration: clip.metadata.duration
    }));
  }

  // ── Retrieval ────────────────────────────────────────────────────

  public async getLyricAlignment(song_id: string): Promise<object[]> {
    validateRequiredString(song_id, 'song_id');
    await this.keepAlive(false);
    const response = await this.client.get(
      `${SunoApi.BASE_URL}/api/gen/${song_id}/aligned_lyrics/v2/`
    );
    return response.data?.aligned_words.map((w: any) => ({
      word: w.word,
      start_s: w.start_s,
      end_s: w.end_s,
      success: w.success,
      p_align: w.p_align
    }));
  }

  private parseLyrics(prompt: string): string {
    return prompt.split('\n').filter(line => line.trim() !== '').join('\n');
  }

  public async get(
    songIds?: string[],
    page?: string | null
  ): Promise<AudioInfo[]> {
    await this.keepAlive(false);
    let url = new URL(`${SunoApi.BASE_URL}/api/feed/v2`);
    if (songIds) url.searchParams.append('ids', songIds.join(','));
    if (page) url.searchParams.append('page', page);
    const response = await this.client.get(url.href, {
      timeout: SunoApi.TIMEOUTS.API_FEED
    });
    return response.data.clips.map((audio: any): AudioInfo => ({
      id: audio.id,
      title: audio.title,
      image_url: audio.image_url,
      lyric: audio.metadata.prompt ? this.parseLyrics(audio.metadata.prompt) : '',
      audio_url: audio.audio_url,
      video_url: audio.video_url,
      created_at: audio.created_at,
      model_name: audio.model_name,
      status: audio.status,
      gpt_description_prompt: audio.metadata.gpt_description_prompt,
      prompt: audio.metadata.prompt,
      type: audio.metadata.type,
      tags: audio.metadata.tags,
      duration: audio.metadata.duration,
      error_message: audio.metadata.error_message
    }));
  }

  public async getClip(clipId: string): Promise<object> {
    validateRequiredString(clipId, 'clipId');
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/clip/${clipId}`);
    return response.data;
  }

  public async getCredits(): Promise<object> {
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/billing/info/`);
    return {
      credits_left: response.data.total_credits_left,
      period: response.data.period,
      monthly_limit: response.data.monthly_limit,
      monthly_usage: response.data.monthly_usage
    };
  }

  /** @deprecated Use getCredits() instead */
  public async get_credits(): Promise<object> {
    return this.getCredits();
  }

  public async getPersonaPaginated(personaId: string, page: number = 1): Promise<PersonaResponse> {
    validateRequiredString(personaId, 'personaId');
    validateNumber(page, 'page');
    await this.keepAlive(false);
    const url = `${SunoApi.BASE_URL}/api/persona/get-persona-paginated/${personaId}/?page=${page}`;
    const response = await this.client.get(url, { timeout: SunoApi.TIMEOUTS.API_PERSONA });
    if (response.status !== 200)
      throw new Error(`Error response: ${response.statusText}`);
    return response.data;
  }
}

// ── Factory ────────────────────────────────────────────────────────

export const sunoApi = async (cookieStr?: string) => {
  const resolvedCookie = cookieStr && cookieStr.includes('__client') ? cookieStr : process.env.SUNO_COOKIE;
  if (!resolvedCookie) {
    throw new Error('Please provide a cookie either in the .env file or in the Cookie header of your request.');
  }
  const cachedInstance = cache.get(resolvedCookie);
  if (cachedInstance) return cachedInstance;
  const instance = await new SunoApi(resolvedCookie).init();
  cache.set(resolvedCookie, instance);
  return instance;
};
