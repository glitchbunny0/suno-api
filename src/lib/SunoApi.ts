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
export const DEFAULT_MODEL = 'chirp-fenix'; // v5.5 (newest)

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

  /**
   * Full captcha check: required flag + which captcha system Suno wants.
   * captcha_version 1 = hCaptcha (via Suno's first-party endpoint), 2 = Turnstile.
   */
  private async captchaCheck(): Promise<{ required: boolean; version: 1 | 2 }> {
    try {
      const resp = await this.client.post(`${SunoApi.BASE_URL}/api/c/check`, {
        ctype: 'generation'
      });
      const version: 1 | 2 = resp.data?.captcha_version === 2 ? 2 : 1;
      logger.info(`captcha check: required=${resp.data?.required}, version=${version}`);
      return { required: !!resp.data?.required, version };
    } catch (err) {
      logger.warn(`captcha check failed: ${toError(err).message} — assuming required, v1`);
      return { required: true, version: 1 };
    }
  }

  /**
   * Solve Cloudflare Turnstile via 2Captcha sitekey method — no browser needed.
   * 2Captcha workers solve the invisible challenge using just sitekey + page URL.
   * Returns the cf_turnstile token string.
   *
   * The sitekey is extracted from suno.com/create's Turnstile widget.
   * If Suno rotates the sitekey, we fall back to extracting it from the page.
   */
  private static TURNSTILE_SITEKEY = '0x4AAAAAADI7xDNyj-3LcIbi';
  private static TURNSTILE_PAGEURL = 'https://suno.com/create';

  private async solveTurnstileDirect(): Promise<string | null> {
    logger.info('Solving Turnstile via 2Captcha sitekey method (no browser)...');
    const startTime = Date.now();
    try {
      const result = await this.solver.cloudflareTurnstile({
        sitekey: SunoApi.TURNSTILE_SITEKEY,
        pageurl: SunoApi.TURNSTILE_PAGEURL,
      });
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Turnstile solved by 2Captcha in ${elapsed}s`);
      return result.data;
    } catch (err) {
      const error = toError(err);
      logger.error(`2Captcha Turnstile solve failed: ${error.message}`);
      // If sitekey is wrong/expired, try extracting a fresh one from the page
      logger.info('Attempting to extract fresh sitekey from suno.com/create...');
      const freshSitekey = await this.extractTurnstileSitekey().catch(() => null);
      if (freshSitekey && freshSitekey !== SunoApi.TURNSTILE_SITEKEY) {
        logger.info(`Found different sitekey: ${freshSitekey}. Retrying...`);
        SunoApi.TURNSTILE_SITEKEY = freshSitekey;
        const retry = await this.solver.cloudflareTurnstile({
          sitekey: freshSitekey,
          pageurl: SunoApi.TURNSTILE_PAGEURL,
        });
        const elapsed2 = ((Date.now() - startTime) / 1000).toFixed(1);
        logger.info(`Turnstile solved on retry in ${elapsed2}s`);
        return retry.data;
      }
      throw error;
    }
  }

  /**
   * Fetch suno.com/create and extract the Turnstile sitekey from the HTML.
   * Looks for data-sitekey attribute or the sitekey in the Turnstile iframe URL.
   */
  private async extractTurnstileSitekey(): Promise<string | null> {
    try {
      const response = await this.client.get('https://suno.com/create', {
        timeout: 15000,
        headers: { 'User-Agent': this.userAgent || undefined }
      });
      const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

      // Try data-sitekey attribute
      const sitekeyMatch = html.match(/data-sitekey=["']([0-9a-zA-Zx-]+)["']/);
      if (sitekeyMatch) return sitekeyMatch[1];

      // Try Turnstile iframe URL pattern: /turnstile/.../SITEKEY/...
      const turnstileMatch = html.match(/turnstile\/[^/]+\/[^/]+\/([0-9a-zA-Zx-]+)\//);
      if (turnstileMatch) return turnstileMatch[1];

      // Try cf-turnstile div with data-sitekey
      const cfMatch = html.match(/cf-turnstile[^>]*data-sitekey=["']([0-9a-zA-Zx-]+)["']/);
      if (cfMatch) return cfMatch[1];

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Solve hCaptcha via 2Captcha — no browser needed.
   * Suno currently gates generation with hCaptcha (captcha_version 1), rendered
   * invisibly via their first-party enterprise endpoint (hcaptcha-endpoint-prod.suno.com).
   * Sitekey recovered from the suno.com/create JS bundle (Aug 2026).
   * Token validation is sitekey-based, so a standard 2Captcha solve should validate.
   */
  private static HCAPTCHA_SITEKEY = 'd65453de-3f1a-4aac-9366-a0f06e52b2ce';
  private static HCAPTCHA_PAGEURL = 'https://suno.com/create';

  private async solveHCaptchaDirect(): Promise<string | null> {
    logger.info('Solving hCaptcha via 2Captcha sitekey method (no browser)...');
    const startTime = Date.now();
    const result = await this.solver.hcaptcha({
      sitekey: SunoApi.HCAPTCHA_SITEKEY,
      pageurl: SunoApi.HCAPTCHA_PAGEURL,
      invisible: 1,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info(`hCaptcha solved by 2Captcha in ${elapsed}s`);
    return result.data;
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
   * Picks the solver based on Suno's captcha_version: 1 = hCaptcha, 2 = Turnstile.
   * Returns the token plus the provider id for the payload's token_provider field.
   * Serialized via captchaMutex — only one solver session at a time.
   */
  public async getCaptcha(): Promise<{ token: string | null; provider: 1 | 2 | null }> {
    const initial = await this.captchaCheck();
    if (!initial.required)
      return { token: null, provider: null };

    const releaseCaptcha = await this.captchaMutex.acquire();
    if (this.captchaMutex.queueLength > 0)
      logger.info(`CAPTCHA mutex: ${this.captchaMutex.queueLength} request(s) waiting`);

    try {
      // Re-check after lock — previous caller may have already solved it
      const check = await this.captchaCheck();
      if (!check.required)
        return { token: null, provider: null };

      // STRATEGY 1: 2Captcha sitekey solver (no browser, ~10-60s)
      // Cleanest path — no DOM selectors, no bot detection.
      try {
        if (check.version === 1) {
          const token = await this.solveHCaptchaDirect();
          if (token) return { token, provider: 1 };
          logger.warn('hCaptcha direct solver returned null — falling back to browser method');
        } else {
          const token = await this.solveTurnstileDirect();
          if (token) return { token, provider: 2 };
          logger.warn('Turnstile direct solver returned null — falling back to browser method');
        }
      } catch (e) {
        logger.warn(`2Captcha direct solver failed: ${toError(e).message} — falling back to browser method`);
      }

      // STRATEGY 2: Fall back to browser-based CAPTCHA solving (v2 rewrite)
      const token = await this._solveCaptchaV2();
      return { token, provider: token ? check.version : null };
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
    const captcha = await this.getCaptcha();
    const payload: any = {
      make_instrumental,
      mv: model || DEFAULT_MODEL,
      prompt: '',
      generation_type: 'TEXT',
      continue_at,
      continue_clip_id,
      task,
      token: captcha.token,
      token_provider: captcha.provider,
      transaction_uuid: randomUUID(),
      metadata: {
        web_client_pathname: '/create',
        create_mode: isCustom ? 'custom' : 'simple',
        create_session_token: randomUUID(),
        disable_volume_normalization: false
      }
    };
    if (isCustom) {
      payload.tags = tags;
      payload.title = title;
      payload.negative_tags = negative_tags;
      payload.prompt = prompt;
    } else {
      payload.gpt_description_prompt = prompt;
    }
    logger.info(`Generate payload: ${JSON.stringify({ ...payload, token: captcha.token ? '<redacted>' : null })}`);
    let response;
    try {
      response = await this.client.post(
        `${SunoApi.BASE_URL}/api/generate/v2-web/`,
        payload,
        { timeout: SunoApi.TIMEOUTS.API_GENERATE }
      );
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Generate failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
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

  /**
   * Get a lossless WAV download URL for a clip.
   * If the clip was never converted, triggers conversion and polls
   * (frontend behavior: 5s interval, up to 24 polls = 2 minutes).
   */
  public async getWavUrl(clipId: string): Promise<string> {
    validateRequiredString(clipId, 'clipId');
    await this.keepAlive(false);
    const wavFileUrl = `${SunoApi.BASE_URL}/api/gen/${clipId}/wav_file/`;
    const existing = await this.client.get(wavFileUrl);
    if (existing.data?.wav_file_url)
      return existing.data.wav_file_url;
    logger.info(`No WAV for ${clipId} yet — triggering conversion`);
    await this.client.post(`${SunoApi.BASE_URL}/api/gen/${clipId}/convert_wav/`);
    for (let i = 0; i < 24; i++) {
      await sleep(5, 5);
      const poll = await this.client.get(wavFileUrl);
      if (poll.data?.wav_file_url)
        return poll.data.wav_file_url;
    }
    throw new Error('WAV conversion timed out after 2 minutes');
  }

  /**
   * Create a persona from a root clip (uses the clip's vocals as the persona's voice).
   * Mirrors the web frontend: only root_clip_id is required; name defaults to 'Untitled'.
   */
  public async createPersona(options: {
    root_clip_id: string;
    name?: string;
    description?: string;
    is_public?: boolean;
  }): Promise<any> {
    validateRequiredString(options.root_clip_id, 'root_clip_id');
    validateOptionalString(options.name, 'name');
    validateOptionalString(options.description, 'description');
    await this.keepAlive(false);
    const body: any = {
      root_clip_id: options.root_clip_id,
      name: options.name || 'Untitled',
      description: options.description || ''
    };
    if (options.is_public !== undefined) body.is_public = options.is_public;
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/persona/create/`, body);
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Persona create failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * List the account's personas (paginated).
   */
  public async getPersonas(page: number = 1): Promise<any> {
    validateNumber(page, 'page');
    await this.keepAlive(false);
    const response = await this.client.get(`${SunoApi.BASE_URL}/api/persona/get-personas/`, {
      params: { page },
      timeout: SunoApi.TIMEOUTS.API_PERSONA
    });
    return response.data;
  }

  /**
   * Upsample a prompt or style tags into a richer version via Suno's enhancer.
   * Two modes (matching the web frontend):
   *   { original_prompt }                    — enhance a song description
   *   { original_tags, user_guidance? }      — enhance style tags
   * Returns { upsampled, artist_replacements? }.
   */
  public async upsamplePrompt(options: {
    original_prompt?: string;
    original_tags?: string;
    user_guidance?: string;
  }): Promise<any> {
    validateOptionalString(options.original_prompt, 'original_prompt');
    validateOptionalString(options.original_tags, 'original_tags');
    validateOptionalString(options.user_guidance, 'user_guidance');
    if (!options.original_prompt && !options.original_tags)
      throw new Error('Either original_prompt or original_tags is required');
    await this.keepAlive(false);
    const body: any = {};
    if (options.original_prompt) body.original_prompt = options.original_prompt;
    if (options.original_tags) body.original_tags = options.original_tags;
    if (options.user_guidance) body.user_guidance = options.user_guidance;
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/prompts/upsample`, body);
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Prompt upsample failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Set a clip's visibility (public/private on the Suno profile).
   */
  public async setClipVisibility(clipId: string, isPublic: boolean): Promise<void> {
    validateRequiredString(clipId, 'clipId');
    await this.keepAlive(false);
    try {
      await this.client.post(`${SunoApi.BASE_URL}/api/gen/${clipId}/set_visibility/`, {
        is_public: isPublic,
        submit_to_contest: false
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Set visibility failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Move clips to trash (or restore them with trash=false).
   */
  public async trashClips(clipIds: string[], trash: boolean = true): Promise<void> {
    if (!Array.isArray(clipIds) || clipIds.length === 0)
      throw new Error('clipIds must be a non-empty array');
    clipIds.forEach((id, i) => validateRequiredString(id, `clipIds[${i}]`));
    await this.keepAlive(false);
    try {
      await this.client.post(`${SunoApi.BASE_URL}/api/gen/trash`, {
        trash,
        clip_ids: clipIds
      });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Trash failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Upload a local audio file to Suno (for extend/remix/covers).
   * Mirrors the web frontend flow:
   *   1. POST /api/uploads/audio/ -> presigned S3 POST params {id, url, fields}
   *   2. multipart POST the file to S3 (fields first, file last)
   *   3. POST upload-finish -> starts server-side processing
   *   4. poll until status complete/error (4s interval, 5 min cap)
   *   5. initialize-clip (best-effort) -> clip_id usable with extend/remix
   *
   * NOTE: agreed_to_vip_upload_terms is asserted — only upload audio you own
   * or have rights to.
   */
  public async uploadAudio(filePath: string, options?: {
    uploadType?: string;
    isStemMix?: boolean;
  }): Promise<{
    upload_id: string;
    clip_id: string | null;
    title?: string;
    has_vocal?: boolean;
    inferred_description?: string;
    image_url?: string;
  }> {
    validateRequiredString(filePath, 'filePath');
    await this.keepAlive(false);
    const fileBuffer = await fs.readFile(filePath);
    const filename = path.basename(filePath);
    const extension = filename.includes('.') ? filename.split('.')!.pop()!.toLowerCase() : 'mp3';
    const uploadType = options?.uploadType ?? 'file_upload';
    logger.info(`Uploading ${filename} (${fileBuffer.length} bytes, .${extension}) to Suno...`);

    // 1. presigned S3 params
    const paramsResp = await this.client.post(`${SunoApi.BASE_URL}/api/uploads/audio/`, {
      extension,
      is_stem_mix: options?.isStemMix ?? false,
      upload_type: uploadType
    });
    const { id: uploadId, url, fields } = paramsResp.data ?? {};
    if (!uploadId || !url)
      throw new Error('Failed to fetch upload parameters from Suno');

    // 2. S3 multipart POST (bare axios — different host, no session headers)
    const form = new FormData();
    for (const [k, v] of Object.entries(fields ?? {})) form.append(k, String(v));
    form.append('file', new Blob([fileBuffer], { type: (fields as any)?.['Content-Type'] || 'application/octet-stream' }), filename);
    await axios.post(url, form, { maxBodyLength: Infinity, maxContentLength: Infinity });

    // 3. finish -> start processing
    await this.client.post(`${SunoApi.BASE_URL}/api/uploads/audio/${uploadId}/upload-finish/`, {
      upload_type: uploadType,
      upload_filename: filename,
      agreed_to_vip_upload_terms: true
    });

    // 4. poll for processing
    let result: any = null;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const poll = await this.client.get(`${SunoApi.BASE_URL}/api/uploads/audio/${uploadId}/`);
      if (poll.data?.status === 'complete') { result = poll.data; break; }
      if (poll.data?.status === 'error')
        throw new Error(`Upload processing failed: ${poll.data?.error_message || poll.data?.error_type || 'unknown'}`);
      await sleep(4, 4);
    }
    if (!result) throw new Error('Upload processing timed out after 5 minutes');

    // 5. initialize-clip (best-effort — not fatal if it fails)
    let clipId: string | null = null;
    try {
      const init = await this.client.post(`${SunoApi.BASE_URL}/api/uploads/audio/${uploadId}/initialize-clip/`, {});
      clipId = init.data?.clip_id ?? null;
    } catch (err) {
      logger.warn(`initialize-clip failed (non-fatal): ${toError(err).message}`);
    }

    logger.info(`Upload complete: upload_id=${uploadId}, clip_id=${clipId}`);
    return {
      upload_id: uploadId,
      clip_id: clipId,
      title: result.title,
      has_vocal: result.has_vocal,
      inferred_description: result.inferred_description,
      image_url: result.image_url
    };
  }

  /**
   * Co-write lyrics with Suno's lyric editor: apply an instruction to a
   * selected piece of lyric, optionally with surrounding context.
   * Mirrors the two frontend modes:
   *   simple:  { instruction, selected, lyricist_id? }
   *   context: { instruction, selected, context_before, context_after,
   *              mode: 'apply_user_request', metadata: { lyrics_model } }
   * Returns { edited_lyrics, artist_to_tag_mapping? }.
   */
  public async cowriteLyrics(options: {
    instruction: string;
    selected: string;
    context_before?: string;
    context_after?: string;
    lyricist_id?: string;
    lyrics_model?: string;
  }): Promise<any> {
    validateRequiredString(options.instruction, 'instruction');
    validateRequiredString(options.selected, 'selected');
    validateOptionalString(options.context_before, 'context_before');
    validateOptionalString(options.context_after, 'context_after');
    validateOptionalString(options.lyricist_id, 'lyricist_id');
    validateOptionalString(options.lyrics_model, 'lyrics_model');
    await this.keepAlive(false);
    const body: any = {
      instruction: options.instruction,
      selected: options.selected
    };
    if (options.context_before !== undefined || options.context_after !== undefined || options.lyrics_model) {
      body.context_before = options.context_before ?? '';
      body.context_after = options.context_after ?? '';
      body.mode = 'apply_user_request';
      body.metadata = { lyrics_model: options.lyrics_model ?? 'default' };
    } else if (options.lyricist_id) {
      body.lyricist_id = options.lyricist_id;
    }
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/generate/cowrite-lyrics`, body);
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Cowrite failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Regenerate one section of lyrics while keeping the rest.
   * The frontend stitches: fullText = prefix + generated + suffix.
   * Returns { generated_lyrics, full_text, lyrics_request_id, lyrics_id }.
   * Suno rejects over-long input with 400 "Lyrics too long to enhance."
   */
  public async lyricsInfill(options: {
    prompt: string;
    edit: string;
    prefix?: string;
    suffix?: string;
    title?: string;
  }): Promise<any> {
    validateRequiredString(options.prompt, 'prompt');
    validateRequiredString(options.edit, 'edit');
    validateOptionalString(options.prefix, 'prefix');
    validateOptionalString(options.suffix, 'suffix');
    validateOptionalString(options.title, 'title');
    await this.keepAlive(false);
    const prefix = options.prefix ?? '';
    const suffix = options.suffix ?? '';
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/generate/lyrics-infill/`, {
        prompt: options.prompt,
        context_lyrics_prefix: prefix,
        context_lyrics_edit: options.edit,
        context_lyrics_suffix: suffix,
        create_session_token: randomUUID(),
        title: options.title ?? ''
      });
      let generated: string = response.data?.generated_lyrics ?? '';
      // Frontend newline fixups so the stitch is seamless
      if (generated.startsWith('[') && prefix.trim() && !prefix.endsWith('\n'))
        generated = '\n' + generated;
      if (options.edit.endsWith('\n') && generated && !generated.endsWith('\n'))
        generated += '\n';
      if (!options.edit && !suffix.trim() && prefix.trim() && generated && !generated.startsWith('\n'))
        generated = '\n' + generated;
      return {
        generated_lyrics: generated,
        full_text: prefix + generated + suffix,
        lyrics_request_id: response.data?.lyrics_request_id,
        lyrics_id: response.data?.lyrics_id
      };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Lyrics infill failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Rhyme suggestions for a word, optionally in the context of a lyric line.
   * Returns { perfect: [...], slant: [...] }.
   */
  public async getRhymes(options: {
    word: string;
    context_line?: string;
    style?: string;
    count?: number;
    include_slant?: boolean;
  }): Promise<any> {
    validateRequiredString(options.word, 'word');
    validateOptionalString(options.context_line, 'context_line');
    validateOptionalString(options.style, 'style');
    if (options.count !== undefined) validateNumber(options.count, 'count');
    await this.keepAlive(false);
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/generate/rhymes/`, {
        word: options.word,
        context_line: options.context_line ?? '',
        style: options.style ?? '',
        count: options.count ?? 16,
        include_slant: options.include_slant ?? true
      });
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Rhymes failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  // ── Edit operations ─────────────────────────────────────────────

  /**
   * Poll an async edit action (crop/fade) until the worker finishes.
   * Frontend behavior: GET /api/edit/action/{id}/ every 2s, 2 min cap.
   */
  private async pollEditAction(actionClipId: string, label: string): Promise<void> {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      await sleep(2, 2);
      const resp = await this.client.get(`${SunoApi.BASE_URL}/api/edit/action/${actionClipId}/`);
      if (resp.data?.status === 'complete') return;
      if (resp.data?.status === 'error')
        throw new Error(`${label} worker reported error`);
    }
    throw new Error(`${label} timed out after 2 minutes`);
  }

  /**
   * Crop a clip to [start_s, end_s] — or with remove_section=true, CUT that
   * range out and keep the rest. Returns the new clip's action_clip_id.
   */
  public async cropClip(clipId: string, options: {
    start_s: number;
    end_s: number;
    remove_section?: boolean;
    title?: string;
  }): Promise<{ action_clip_id: string }> {
    validateRequiredString(clipId, 'clipId');
    validateNumber(options.start_s, 'start_s');
    validateNumber(options.end_s, 'end_s');
    await this.keepAlive(false);
    let title = options.title;
    if (!title) {
      const clip: any = await this.getClip(clipId);
      title = `${clip?.title || 'Clip'} (${options.remove_section ? 'Remove Section' : 'Crop'})`;
    }
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/edit/crop/${clipId}/`, {
        crop_start_s: options.start_s,
        crop_end_s: options.end_s,
        is_crop_remove: options.remove_section ?? false,
        title,
        ui_surface: 'song_actions'
      });
      const actionClipId = response.data?.action_clip_id;
      if (!actionClipId) throw new Error('No action_clip_id in crop response');
      await this.pollEditAction(actionClipId, 'Crop');
      return { action_clip_id: actionClipId };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Crop failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Apply fade-in and/or fade-out to a clip (seconds, 0 to skip a side).
   * Returns the new clip's action_clip_id.
   */
  public async fadeClip(clipId: string, options: {
    fade_in_time?: number;
    fade_out_time?: number;
    title?: string;
  }): Promise<{ action_clip_id: string }> {
    validateRequiredString(clipId, 'clipId');
    if (options.fade_in_time !== undefined) validateNumber(options.fade_in_time, 'fade_in_time');
    if (options.fade_out_time !== undefined) validateNumber(options.fade_out_time, 'fade_out_time');
    if (!options.fade_in_time && !options.fade_out_time)
      throw new Error('At least one of fade_in_time or fade_out_time must be non-zero');
    await this.keepAlive(false);
    let title = options.title;
    if (!title) {
      const clip: any = await this.getClip(clipId);
      title = `${clip?.title || 'Clip'} (Fade)`;
    }
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/edit/fade/${clipId}/`, {
        fade_in_time: options.fade_in_time ?? 0,
        fade_out_time: options.fade_out_time ?? 0,
        title
      });
      const actionClipId = response.data?.action_clip_id;
      if (!actionClipId) throw new Error('No action_clip_id in fade response');
      await this.pollEditAction(actionClipId, 'Fade');
      return { action_clip_id: actionClipId };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Fade failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Change a clip's speed (optionally preserving pitch). Synchronous —
   * returns the new clip object directly. Title defaults to "Name (1.5x)".
   */
  public async adjustClipSpeed(clipId: string, options: {
    speed_multiplier: number;
    keep_pitch?: boolean;
    title?: string;
  }): Promise<any> {
    validateRequiredString(clipId, 'clipId');
    validateNumber(options.speed_multiplier, 'speed_multiplier');
    await this.keepAlive(false);
    let title = options.title;
    if (!title) {
      const clip: any = await this.getClip(clipId);
      const mult = options.speed_multiplier % 1 === 0
        ? options.speed_multiplier.toFixed(0)
        : options.speed_multiplier.toFixed(2);
      title = `${clip?.title || 'Clip'} (${mult}x)`;
    }
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/clips/adjust-speed/`, {
        clip_id: clipId,
        speed_multiplier: options.speed_multiplier,
        keep_pitch: options.keep_pitch ?? false,
        title
      });
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Adjust speed failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
  }

  /**
   * Reverse a clip. Synchronous — returns the new clip object directly.
   * Title defaults to "Name (Reversed)".
   */
  public async reverseClip(clipId: string, title?: string): Promise<any> {
    validateRequiredString(clipId, 'clipId');
    validateOptionalString(title, 'title');
    await this.keepAlive(false);
    if (!title) {
      const clip: any = await this.getClip(clipId);
      title = `${clip?.title || 'Clip'} (Reversed)`;
    }
    try {
      const response = await this.client.post(`${SunoApi.BASE_URL}/api/clips/reverse-clip/`, {
        clip_id: clipId,
        title
      });
      return response.data;
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        logger.error(`Reverse failed: HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`);
      }
      throw err;
    }
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
