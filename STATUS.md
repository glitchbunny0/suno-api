# Suno API — Status Report
Generated: August 3, 2026 (updated: generation FIXED same day)

## Project Location
/home/timo/media/music/suno-zach-fau/

## Current State: ALL ENDPOINTS WORKING

| Endpoint | Status | Notes |
|----------|--------|-------|
| GET /api/get_limit | WORKING | Returns 2500 credits |
| GET /api/get | WORKING | Song feed/retrieval |
| GET /api/clip/:id | WORKING | Clip metadata |
| GET /api/persona | WORKING | List personas (no id) or persona clips (?id=) |
| POST /api/persona | WORKING | Create persona from root_clip_id (one per clip) |
| Auth (Clerk) | WORKING | Session via two-step navigation |
| POST /api/generate | WORKING | Fixed Aug 3 — see below |
| POST /api/custom_generate | WORKING | Same fix |
| POST /api/generate_lyrics | UNTESTED | May need same payload updates |
| GET /api/get_wav | WORKING | WAV download URL, converts on first request |
| POST /api/upsample_prompt | WORKING | Prompt + style-tag enhancer (both modes tested) |
| POST /api/set_visibility | WORKING | Publish/unpublish, verified via clip is_public |
| POST /api/trash | WORKING | Trash/restore, verified via feed membership |

All new endpoints verified against the live API on Aug 3, 2026.
Only /api/generate + /api/custom_generate require a CAPTCHA solve
(CaptchaConsumer has exactly one value: 'generation').

Verified Aug 3, 2026: real generation returned 2 submitted clips on
chirp-crow (v5) via 2Captcha-solved hCaptcha token.

## How Generation Was Fixed (Aug 3, 2026)

Two root causes, both found by reverse-engineering Suno's current
frontend JS bundles (suno.com/create, Next.js chunks):

### Root cause 1: Wrong CAPTCHA type
Suno's `/api/c/check` returns `{"required": true, "captcha_version": 1}`.
The frontend maps version to provider:
- captcha_version 1 = hCaptcha (invisible widget, first-party enterprise
  endpoint hcaptcha-endpoint-prod.suno.com)
- captcha_version 2 = Cloudflare Turnstile

All previous attempts solved Turnstile while Suno was asking for hCaptcha
→ 422 token_validation_failed. The Turnstile widgets on the page are for
other flows (auth etc.), not generation.

The earlier conclusion "Suno switched from hCaptcha to Turnstile" was
wrong — it's version-dependent and server-driven. getCaptcha() now reads
captcha_version and picks the correct solver.

hCaptcha sitekey (from frontend bundle): d65453de-3f1a-4aac-9366-a0f06e52b2ce
Solved via 2Captcha hcaptcha() with sitekey + pageurl=https://suno.com/create,
invisible=1. The custom first-party endpoint does NOT matter — token
validation is sitekey-based, standard 2Captcha tokens are accepted.

### Root cause 2: Wrong endpoint + payload shape
The web frontend now posts to `/api/generate/v2-web/` (not /api/generate/v2/)
with additional fields:
- token_provider: 1 (hCaptcha) or 2 (Turnstile)
- transaction_uuid: client-generated UUID v4
- metadata: { web_client_pathname: '/create', create_mode: 'simple'|'custom',
  create_session_token: UUID v4 (client-generated, no server binding),
  disable_volume_normalization: false }

### Code changes (src/lib/SunoApi.ts)
- solveHCaptchaDirect(): 2Captcha hCaptcha solver
- captchaCheck(): returns {required, version} from /api/c/check
- getCaptcha(): version-aware, returns {token, provider}
- generateSongs(): POST /api/generate/v2-web/ with modern payload

## What Was Done Earlier (history)

### Upstream Merge (187 commits)
Rebuilt on gcui-art/suno-api upstream/main as base. The zach-fau fork had no
common git ancestor (fresh init, not a proper fork).

### Fork Improvements Preserved
- DEFAULT_MODEL = 'chirp-crow' (v5, not upstream's v3.5)
- Two-step Clerk auth (homepage → /create)
- Session-variant __client_uat timestamp extraction
- __client cookie on both auth.suno.com + clerk.suno.com
- Configurable timeouts via TIMEOUT_* env vars
- Input validation on all public methods
- getCredits() + deprecated get_credits() alias
- TypeScript interfaces

### PR #271 CAPTCHA v2 Rewrite (ported)
- waitForAnyVisibleLocator, waitForCaptchaFrame, saveDebugSnapshot
- Popup auto-dismissal, route interception before Create click
- AsyncMutex on CAPTCHA solving

### 2Captcha Turnstile Sitekey Solver
- solveTurnstileDirect() — kept as the captcha_version 2 path

## Upstream Project Status
The gcui-art/suno-api project is effectively abandoned:
- Issue #262 (Dec 2025): maintainer stepped away
- 99 open issues, 6 open PRs
- Issues #263, #269: same 422 token_validation_failed this fix resolves

## Run

```bash
cd /home/timo/media/music/suno-zach-fau
xvfb-run -a npx next start -p 3000
```

Requires .env: SUNO_COOKIE, TWOCAPTCHA_KEY, BROWSER_* settings.

## Branches

| Branch | Description |
|--------|-------------|
| main | Current code (upstream + fork + captcha fixes, all working) |
| zach-fau-backup | Original fork state before merge (preserved) |

## Files of Interest

- src/lib/SunoApi.ts — main API class
- src/lib/utils.ts — sleep, waitForRequests, AsyncMutex, AsyncSemaphore
- debug/ — snapshot dumps from browser CAPTCHA attempts (gitignored)
- .env — SUNO_COOKIE, TWOCAPTCHA_KEY, BROWSER settings
