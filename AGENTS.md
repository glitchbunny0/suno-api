# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

Community-maintained fork of [gcui-art/suno-api](https://github.com/gcui-art/suno-api)
(upstream effectively unmaintained). Unofficial REST + MCP API for Suno.ai music
generation. Next.js 14 App Router, TypeScript, Node 22.

Fork remotes:
- `origin` — zach-fau/suno-api (historical base, do not push)
- `upstream` — gcui-art/suno-api (original project, PR target)
- `fork` — glitchbunny0/suno-api (**push here**)

## Architecture

- `src/lib/SunoApi.ts` — the entire API client (session/auth, captcha, all endpoints).
  One class, methods map 1:1 to Suno backend calls.
- `src/app/api/<endpoint>/route.ts` — thin Next.js route handlers, one dir per endpoint.
  Pattern: parse params → call SunoApi method → JSON response with corsHeaders.
- `src/app/api/mcp/route.ts` — MCP endpoint (mcp-handler, Streamable HTTP, stateless).
  Tools are thin zod-schematized wrappers over the same SunoApi methods.
- `src/lib/utils.ts` — sleep(seconds), waitForRequests, AsyncMutex, corsHeaders.
- Auth: Clerk session from `SUNO_COOKIE`, auto-renewed via keepAlive(). All methods
  call `await this.keepAlive(false)` first.
- Instances are cached per cookie (see `sunoApi()` factory at the bottom of SunoApi.ts).

## Adding a new endpoint (the established pattern)

1. Find the exact request shape in Suno's frontend JS bundles (suno.com/create,
   `/_next/static/chunks/*.js` — grep for the `/api/...` path string). Never guess payloads.
2. Add a method to SunoApi.ts: validation helpers (`validateRequiredString` etc.),
   `keepAlive(false)`, axios call, and log Suno's error body on AxiosError
   (`err.response.status` + `err.response.data`) — Suno errors carry useful `detail`.
3. Add a route handler under `src/app/api/<name>/route.ts` (copy an existing one).
4. If agent-facing, also register an MCP tool in `src/app/api/mcp/route.ts`.
5. `npx next build` must compile clean.
6. Test against the LIVE API with curl (localhost:3000) and record what you verified.
7. Update README.md (API reference) and STATUS.md (endpoint table).
8. Commit separately per feature. Push to `fork`, not origin.

## Suno API facts (hard-won, don't rediscover)

- Only generation requires a CAPTCHA token. `/api/c/check` returns `captcha_version`:
  1 = hCaptcha (invisible, sitekey in SunoApi.ts), 2 = Cloudflare Turnstile.
  Solved via 2Captcha (`TWOCAPTCHA_KEY`), no browser needed. ~60s per solve.
- Generate posts to `/api/generate/v2-web/` (NOT /v2/) and requires `token`,
  `token_provider`, `transaction_uuid`, and a `metadata` object. See generateSongs().
- Default model is `chirp-hawk` (v6). v6-wild = `chirp-hawk-wild`, v6-mini = `chirp-goose`. All pre-v6 slugs retired by Suno on Sep 9 2026 (generation returns errors; library stays playable).
- One persona per clip (`already_exists_for_clip`).
- Trash state is NOT on the clip object — verify via feed membership.
- Upload flow: POST /api/uploads/audio/ → S3 presigned POST → upload-finish → poll
  (4s) → initialize-clip. It asserts agreed_to_vip_upload_terms.
- WAV: GET /api/gen/{id}/wav_file/ returns url only after convert_wav POST + wait.
- `studio-api.prod.suno.com` and `studio-api-prod.suno.com` are the same host.
- The Playwright browser path is only a captcha fallback; it needs `xvfb-run -a`
  on headless machines.
- If 422 token_validation_failed ever returns: Suno rotated something. Re-scrape the
  frontend bundles (sitekey, endpoint paths, payload fields).

## Run / build / test

```bash
npm install
npx next build
xvfb-run -a npx next start -p 3000    # headless
# or: npm run dev
```

No automated test suite — verification is live curl against localhost:3000.
GET endpoints are free to test. /api/generate costs one 2Captcha solve (~$0.003)
and consumes account credits — ask before burning them.

## MCP

Endpoint: `http://localhost:3000/api/mcp` (POST, Streamable HTTP / SSE).
Tools registered as `mcp_<server>_<tool>` in MCP clients. When adding a SunoApi
method that agents should use, add a matching `server.registerTool` with a zod
schema and a description that states timing/cost (e.g. "~60s CAPTCHA solve").

## Conventions

- Commits: one feature per commit, imperative subject, body explains the "why"
  and what was verified live. Author/committer: glitchbunny0 (see above).
- Don't refactor upstream code style wholesale — diffs vs upstream should stay
  reviewable for PRs.
- STATUS.md is the living health document — keep the endpoint table accurate.
- debug/ holds captcha browser snapshots (gitignored). .env holds secrets — never commit it.
