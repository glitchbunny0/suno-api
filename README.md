<div align="center">
  <h1 align="center">Suno AI API</h1>
  <p>Unofficial API for Suno.ai music generation — generation, lyrics, editing, playlists, personas, and an MCP server for AI agents.</p>
</div>

![suno-api banner](public/suno-banner.png)

## Features

- **Music generation** — text prompts and Custom Mode (lyrics, styles, title).
  Suno v5.5 (`chirp-fenix`) by default; v5, v4.5+ and v4.5 selectable per request.
- **CAPTCHA handled for you** — Suno's captcha is risk-based and version-driven
  (`/api/c/check` selects hCaptcha or Cloudflare Turnstile). The matching challenge is
  solved via [2Captcha](https://2captcha.com) — no browser needed in the common case.
- **Lyrics suite** — generate lyrics, edit them by instruction (cowrite), regenerate a
  single section (infill), and get context-aware rhyme suggestions.
- **Audio editing** — extend a song, merge an extend chain into the whole song (concat),
  crop, fade, change speed (pitch-preserving optional), reverse.
- **Upload your own audio** — local file → Suno clip with BPM/key/vocal analysis, ready
  for extend or remix.
- **Library management** — playlists (create, rename, add/remove tracks, trash), personas,
  publish/unpublish, trash/restore, lossless WAV download.
- **MCP server** — 30 tools at `/api/mcp` (streamable HTTP) for agent integrations
  (Hermes, Claude Code, Cursor, …).
- **OpenAI-compatible endpoint** — `/v1/chat/completions` for GPTs/Coze-style tool schemas.
- Automatic session keep-alive, configurable timeouts (`TIMEOUT_*` env vars), TypeScript
  interfaces for responses, input validation on all public methods.
- LGPL-3.0 licensed.

## How it works

Suno gates generation behind a CAPTCHA, but which CAPTCHA is server-driven. Before each
generation the server asks `/api/c/check`; the `captcha_version` in the response selects
the provider (`1` = hCaptcha invisible, `2` = Turnstile), and the token goes into the
generate payload as `token` + `token_provider`. Because hCaptcha token validation is
sitekey-based, a standard 2Captcha solve is accepted — when a solve is required the flow
takes ~60 seconds, most of it the CAPTCHA solve. When Suno's risk engine is satisfied with
the session, no CAPTCHA is required at all and generation starts immediately.

Generation posts to Suno's current `/api/generate/v2-web/` endpoint with the
`token_provider`, `transaction_uuid` and `metadata` fields the backend expects. Session
setup uses two-step Clerk authentication (homepage → `/create`) for reliability.

If generation ever starts returning 422 again, Suno likely rotated the hCaptcha sitekey:
re-extract it from the JS bundles on `suno.com/create` (grep the `/_next/static/chunks/`
files for `sitekey`) and update `HCAPTCHA_SITEKEY` in `src/lib/SunoApi.ts`.

## Getting Started

### 1. Obtain the cookie of your Suno account

1. Head over to [suno.com/create](https://suno.com/create) using your browser.
2. Open up the browser console: hit `F12` or access the `Developer Tools`.
3. Navigate to the `Network` tab.
4. Give the page a quick refresh.
5. Identify the latest request that includes the keyword `?__clerk_api_version`.
6. Click on it and switch over to the `Header` tab.
7. Locate the `Cookie` section, hover your mouse over it, and copy the value of the Cookie.

![get cookie](public/get-cookie-demo.gif)

### 2. Register on 2Captcha and top up your balance

[2Captcha](https://2captcha.com/about) is a paid CAPTCHA-solving service. Suno requires a
CAPTCHA token for generation, and there is currently no free way to solve hCaptcha reliably.
Each generation costs one solve (~$0.003).

[Create](https://2captcha.com/auth/register?userType=customer) an account,
[top up](https://2captcha.com/pay) your balance and
[get your API key](https://2captcha.com/enterpage#recognition).

> [!NOTE]
> If you are located in Russia or Belarus, use the [ruCaptcha](https://rucaptcha.com)
> interface instead of 2Captcha. Same service, supports payments from those countries.

### 3. Clone and configure

```bash
git clone https://github.com/glitchbunny0/suno-api.git
cd suno-api
npm install
```

Create a `.env` file:

```bash
SUNO_COOKIE=<cookie from step 1>
TWOCAPTCHA_KEY=<API key from step 2>
BROWSER=chromium
BROWSER_GHOST_CURSOR=false
BROWSER_LOCALE=en
BROWSER_HEADLESS=true
```

| Variable | Description |
|----------|-------------|
| `SUNO_COOKIE` | The `Cookie` header from step 1. |
| `TWOCAPTCHA_KEY` | Your 2Captcha API key from step 2. |
| `BROWSER` | Browser for the CAPTCHA fallback path: `chromium` or `firefox`. |
| `BROWSER_GHOST_CURSOR` | Simulate smooth mouse movements. Makes no measurable difference — `false` is fine. |
| `BROWSER_LOCALE` | Browser language; `en` or `ru` have the most 2Captcha workers. |
| `BROWSER_HEADLESS` | Run the fallback browser headless. Set `true` unless debugging. |
| `TIMEOUT_*` | Optional overrides for every internal timeout (page navigation, API calls, polling intervals, generation max wait). See `TIMEOUTS` in `src/lib/SunoApi.ts` for the full list and defaults. |

### 4. Run

```bash
npm run dev          # development
# or
npm run build && npx next start -p 3000   # production
```

Headless server without a display? Wrap it: `xvfb-run -a npx next start -p 3000`.

Docker works too (GPU acceleration disabled, slower browser fallback):

```bash
docker compose build && docker compose up
```

### 5. Verify

```bash
curl http://localhost:3000/api/get_limit
```

```json
{
  "credits_left": 2500,
  "period": "year",
  "monthly_limit": 2500,
  "monthly_usage": 0
}
```

Then generate a track:

```bash
curl -X POST http://localhost:3000/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"lo-fi hip hop loop, mellow keys, vinyl crackle","make_instrumental":true,"wait_audio":false}'
```

Expect a JSON array of clips with `status: "submitted"`. Songs take 1–3 minutes to finish
rendering; poll `/api/get?ids=<id1>,<id2>` until the status is `streaming` or `complete`.

## API Reference

**Generation**

- `/api/generate`: Generate music
- `/v1/chat/completions`: Generate music — OpenAI-compatible format
- `/api/custom_generate`: Generate music (Custom Mode: lyrics, style, title, etc.)
- `/api/extend_audio`: Extend audio length
- `/api/concat`: Generate the whole song from extensions (v2; body: `clip_id`, optional `is_infill`)
- `/api/cover`: Suno "Cover" — reimagine a clip in a new style: `POST { audio_id, tags?,
    prompt?, title?, cover_start_s?, cover_end_s?, ... }`; keeps source melody/structure,
    new tags/lyrics applied. (The webapp's "Remaster" is this same flow with unchanged
    style and a newer model.)
- `/api/video`: Music video for a clip — `POST { clip_id }` starts rendering,
    `GET ?id=<clip_id>` polls `{ status, video_url? }`
- `/api/upsample_prompt`: Enhance prompts — `POST { original_prompt }` for song
    descriptions or `POST { original_tags, user_guidance? }` for style tags

**Lyrics**

- `/api/generate_lyrics`: Generate lyrics based on prompt
- `/api/cowrite_lyrics`: Edit lyrics by instruction — `POST { instruction, selected,
    context_before?, context_after?, lyricist_id?, lyrics_model? }`
- `/api/lyrics_infill`: Regenerate one lyrics section — `POST { prompt, edit, prefix?,
    suffix?, title? }`; prefix/suffix preserved, returns stitched full_text
- `/api/rhymes`: Rhyme suggestions — `POST { word, context_line?, style?, count?,
    include_slant? }` returns `{ perfect, slant }`
- `/api/get_aligned_lyrics`: Word-level lyric timestamps
- `/api/lyricists`: Lyricist profiles (reusable writing styles for cowrite) —
    `GET` list (`?limit&cursor`) or single (`?id=X`); `POST {name, description?,
    sample_lyrics?[]}` create; `PATCH {id, name?, description?, sample_lyrics?,
    is_favorited?}` update; `DELETE {id}`. Suno auto-generates an `ai_description`
    style analysis from the samples

**Editing**

- `/api/crop`: Crop to a range or cut it out — `POST { id, start_s, end_s,
    remove_section?, title? }`; async worker, returns `action_clip_id`
- `/api/fade`: Fade-in/out — `POST { id, fade_in_time?, fade_out_time?, title? }`
- `/api/adjust_speed`: Tempo change — `POST { id, speed_multiplier, keep_pitch?, title? }`
- `/api/reverse`: Reverse audio — `POST { id, title? }` (instrumental clips only —
    Suno rejects vocals with `not_allowed_on_vocal`)

**Library**

- `/api/get`: Get music information by id (comma-separated; all music if omitted)
- `/api/get_limit`: Get quota info
- `/api/clip`: Get clip information by `?id=`
- `/api/get_wav`: Lossless audio — `GET ?id=<clip_id>` returns `{ wav_file_url }`,
    converting on first request
- `/api/set_visibility`: Publish/unpublish — `POST { id, is_public }`
- `/api/trash`: Trash clips — `POST { ids: [...] }` (`trash: false` restores)
- `/api/upload`: Upload local audio for extend/remix — `POST { file_path }` (path on the
    server). Returns `upload_id`, `clip_id` and Suno's analysis (BPM, key, vocals).
    Asserts Suno's upload terms — only upload audio you own rights to.
- `/api/generate_stems`: Make stem tracks (separate vocals and music) — legacy,
    currently untested

**Playlists & personas**

- `/api/playlist`: Playlists — `GET` list (`?page=N`) or single (`?id=X&page=N`);
  `POST {name}` create; `POST {action:'update'|'add'|'remove'|'trash', playlist_id, ...}`
  for metadata, track add/remove (`clip_ids[]`), and trash (`undo:true` restores)
- `/api/persona`: Personas — `GET ?id=X&page=N` for persona clips, `GET` (no id) to list
    your personas, `POST { root_clip_id, name?, description?, is_public? }` to create one

Only generation requires a CAPTCHA solve; all other endpoints work with just the account
session.

You can also pass cookies in the `Cookie` header of a request to override `SUNO_COOKIE` —
handy for using multiple accounts.

## MCP Server

The API doubles as an [MCP](https://modelcontextprotocol.io) server (streamable HTTP) at
`http://localhost:3000/api/mcp`, exposing 38 tools: generation, custom mode, extend,
concat, cover, music video, lyrics (generate/cowrite/infill/rhymes/aligned), lyricists,
editing (crop/fade/speed/reverse), upload, WAV, personas, playlists, visibility and trash.

Register it with any MCP client, e.g. with [Hermes](https://github.com/NousResearch/hermes-agent):

```bash
hermes mcp add suno --url http://localhost:3000/api/mcp
hermes config set mcp_servers.suno.timeout 420   # generations can take a while
```

## Examples

Runnable integration examples live in [`examples/`](examples/):

- [`examples/generate_and_poll.py`](examples/generate_and_poll.py) — generate a song and
  poll until the audio URL is ready (Python, `requests`)
- [`examples/generate_and_poll.js`](examples/generate_and_poll.js) — same flow in
  JavaScript (Node, `axios`)

## Contributing

Bug reports and PRs are welcome — especially when Suno changes something and breaks
generation again.

## License

LGPL-3.0 or later. See [LICENSE](LICENSE).

## Statement

suno-api is an unofficial open source project, intended for learning and research purposes
only. Not affiliated with Suno, Inc.

## Credits

Based on [gcui-art/suno-api](https://github.com/gcui-art/suno-api) by gcui-art and its
contributors, with improvements from the zach-fau fork and upstream PR #271
(aqeel-spec). The August 2026 generation fix was also submitted upstream as
[PR #286](https://github.com/gcui-art/suno-api/pull/286).
