# Suno API — Status Report
Generated: August 3, 2026

## Project Location
/home/timo/media/music/suno-zach-fau/

## What Was Done

### Upstream Merge (187 commits)
Rebuilt on gcui-art/suno-api upstream/main as base. The zach-fau fork had no
common git ancestor (fresh init, not a proper fork). Gained all 187 upstream
commits including:
- hCaptcha drag-type CAPTCHA solving
- Persona API endpoint
- Cookie validation before browser launch
- Auto-install browser NPM package
- waitForRequests() for smarter image loading detection
- Community timeout/error handling fixes

### Fork Improvements Preserved
- DEFAULT_MODEL = 'chirp-crow' (v5, not upstream's v3.5)
- Two-step Clerk auth (homepage → /create) — lets Clerk JS create __session
- Session-variant __client_uat timestamp extraction
- __client cookie on both auth.suno.com + clerk.suno.com
- Configurable timeouts via TIMEOUT_* env vars
- Input validation on all public methods
- getCredits() + deprecated get_credits() alias
- TypeScript interfaces (AudioInfo, PersonaResponse, etc.)

### PR #271 CAPTCHA v2 Rewrite (ported)
- waitForAnyVisibleLocator: polls 10 selectors for prompt, 8 for Create button
- waitForCaptchaFrame: detects hCaptcha, reCAPTCHA, Turnstile, Arkose
- saveDebugSnapshot: dumps HTML/screenshots/request logs to debug/
- Popup auto-dismissal
- Route interception set up BEFORE clicking Create
- AsyncMutex on CAPTCHA solving (one browser at a time)
- AsyncMutex/AsyncSemaphore in utils.ts

### 2Captcha Turnstile Sitekey Solver
- solveTurnstileDirect(): calls solver.cloudflareTurnstile() with sitekey + URL
- extractTurnstileSitekey(): scrapes fresh sitekey from page HTML
- getCaptcha() tries Turnstile direct first, falls back to browser v2

### Code Optimization
- SunoApi.ts: 1732 lines → 1119 lines (stripped JSDoc bloat, same functionality)


## What Works (verified Aug 3, 2026)

| Endpoint | Status | Notes |
|----------|--------|-------|
| GET /api/get_limit | WORKING | Returns 2500 credits, 0 usage |
| GET /api/get | WORKING | Song feed/retrieval |
| GET /api/clip/:id | WORKING | Clip metadata |
| GET /api/persona | WORKING | Persona info |
| Auth (Clerk) | WORKING | Session established via two-step navigation |
| POST /api/generate | BROKEN | 422 token_validation_failed |
| POST /api/custom_generate | BROKEN | Same — requires CAPTCHA token |
| POST /api/generate_lyrics | BROKEN | Same token requirement |


## Why Generation Is Broken

### Root Cause: Suno switched from hCaptcha to Cloudflare Turnstile

The CAPTCHA flow for song generation requires a valid token in the generate
payload. Suno changed their CAPTCHA system from hCaptcha (visual puzzle) to
Cloudflare Turnstile (invisible/managed challenge).

### Evidence

1. The captcha check endpoint returns: {"required": true, "captcha_version": 1}

2. The suno.com/create page loads Turnstile JS:
   https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit

3. Turnstile iframe with sitekey appears in frames log:
   challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/...
   .../0x4AAAAAAAFV93qQdS0ycilX/... (visible widget)
   .../0x4AAAAAADI7xDNyj-3LcIbi/... (invisible widget)

4. The page also loads hCaptcha JS from a Suno custom endpoint:
   https://hcaptcha-endpoint-prod.suno.com/1/api.js
   But the active challenge is Turnstile, not hCaptcha.

5. The old selectors (.custom-textarea, button[aria-label="Create"]) no longer
   exist. The new DOM has:
   - Textarea: placeholder contains rotating prompt suggestions (e.g.
     "Creepy bebop song about the price of loyalty", "Describe the sound you want")
   - Create button: aria-label="Create song", class includes "hxc-btn-base"

### Three approaches attempted, all blocked

#### Approach 1: Browser automation (PR #271 v2 rewrite)
The v2 selectors DO find the new DOM elements. The textarea is found, filled,
and the Create button is clicked. Turnstile loads and runs its invisible
challenge (POST requests to challenges.cloudflare.com are visible in logs).

BLOCKER: Turnstile detects headless Chromium (even with rebrowser-playwright-core
patches) and refuses to produce a token. The generate request never fires.
The browser automation works — the anti-bot detection blocks it.

Research confirms: Cloudflare Turnstile in 2026 scores the entire request
(TLS/JA4 fingerprint, HTTP/2 fingerprint, behavioral analysis, IP reputation,
browser fingerprint). No single stealth plugin or patched browser clears all
layers reliably. puppeteer-extra-plugin-stealth (last updated 3 years ago)
does not pass Turnstile. Camoufox (C++ level Firefox patches) has a
maintenance gap and is Python-only.

#### Approach 2: 2Captcha Turnstile sitekey solver
2Captcha's cloudflareTurnstile() method successfully solves the Turnstile
challenge using sitekey + pageurl — no browser needed. Returns a valid token
(format: 1.xxx.yyy.zzz) in ~10 seconds.

Both sitekeys tested:
- 0x4AAAAAAAFV93qQdS0ycilX → token rejected (422)
- 0x4AAAAAADI7xDNyj-3LcIbi → token rejected (422)

BLOCKER: Suno's server-side validation rejects tokens solved from 2Captcha's
worker IPs. The token is valid Cloudflare format, but Suno runs a custom
validation layer (hcaptcha-endpoint-prod.suno.com) that binds tokens beyond
standard Cloudflare siteverify. Likely binds to requesting session, IP, or
browser fingerprint.

No separate token verification endpoint exists:
- /api/c/verify → 404
- /api/c/submit → 404
- /api/c/token → 404
Token goes directly in generate payload's "token" field.

#### Approach 3: Headless browser with anti-detection
Not implemented. Research concluded that Cloudflare Turnstile bot detection
in 2026 requires solving TLS fingerprinting + browser fingerprinting + IP
reputation + behavioral analysis simultaneously. This is an arms race that
no free/open-source tool wins reliably for Turnstile specifically.

Favorable factor: lizzie is on a residential IP (not datacenter), which
removes one detection signal.


## Upstream Project Status

The gcui-art/suno-api project is effectively abandoned:
- Issue #262 (Dec 2025): "Is anyone out there willing to take over this project?"
- Original author stepped away
- 99 open issues, 6 open PRs
- Last meaningful commit to SunoApi.ts: Clerk endpoint fix
- Multiple users report the same 422 token_validation_failed (issues #263, #269)

Two open PRs attempt to fix generation:
- PR #271 (aqeel-spec): CAPTCHA v2 rewrite (we ported this)
- PR #277 (courcirc8): MANUAL_CAPTCHA mode (human-in-the-loop)


## Remaining Options

### Option A: useapi.net ($15/month flat)
https://useapi.net

$15/mo for all their APIs including Suno, Mureka, MiniMax, Flow Music, and
others. They handle the browser automation and CAPTCHA solving infrastructure.
We would rewrite the skill's API layer to call their REST API instead of
localhost:3000.

Pros: Just works. No CAPTCHA maintenance. Multiple music models included.
Cons: Monthly cost. External dependency. ToS ambiguity (unofficial access).
Effort: Medium — rewrite API layer, but eliminate browser automation entirely.

### Option B: MANUAL_CAPTCHA mode (free, human-in-the-loop)
Port PR #277. Opens a visible browser on the desktop (needs a display or
VNC). User fills the form and clicks Create manually. Route interceptor
captures the token. Zero DOM selectors needed — survives any UI change.

Pros: Free. Works on any UI version. No 2Captcha needed for Turnstile.
Cons: Requires human + display each time. Not automation.
Effort: Low — small code addition.

### Option C: Wait for Suno official API
Suno's CPO Jack Brody announced July 2026 they're "exploring" a developer
API with curated partners. No public keys, pricing, or launch date.

Pros: Official, stable, no cat-and-mouse.
Cons: Unknown timeline. Could be months or never.
Effort: Zero (just wait).

### Option D: Switch model (MiniMax Music 3.0)
MiniMax Music 3.0 has a real public API. Free tier (3 req/min), paid at
$0.15/song. Not Suno vocal quality but works for automation.

Pros: Real API, no CAPTCHA, works today.
Cons: Different model, different sound quality.
Effort: Medium — new integration.

### Option E: Residential proxy + 2Captcha with proxy
2Captcha's Turnstile solver supports a proxy parameter. If we route the
token solve through our residential IP, Suno's IP binding might accept it.

Pros: Keeps current architecture. ~$0.002/solve.
Cons: Requires a proxy server. May not work if Suno binds to session
not IP. Untested.
Effort: Low — add proxy params to solveTurnstileDirect().


## Branches

| Branch | Description |
|--------|-------------|
| main | Current merged code (upstream + fork + v2 + Turnstile) |
| zach-fau-backup | Original fork state before merge (preserved) |

## Files of Interest

- src/lib/SunoApi.ts — main API class (1119 lines)
- src/lib/utils.ts — sleep, waitForRequests, AsyncMutex, AsyncSemaphore (189 lines)
- debug/ — snapshot dumps from v2 CAPTCHA attempts (gitignored)
- CURRENT_ISSUE.md — old Clerk auth debugging notes (resolved)
- .env — SUNO_COOKIE, TWOCAPTCHA_KEY, BROWSER settings
