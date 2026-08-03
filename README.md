<div align="center">
  <h1 align="center">Suno AI API</h1>
  <p>Unofficial API for Suno.ai music generation — community-maintained fork with working generation.</p>
</div>

![suno-api banner](public/suno-banner.png)

> [!IMPORTANT]
> **This is a fork.** The original project, [gcui-art/suno-api](https://github.com/gcui-art/suno-api),
> is effectively unmaintained (see upstream issue #262), and its generation endpoint has been
> broken since Suno's create-page redesign (`422 token_validation_failed`, upstream issues
> #263 / #269).
>
> This fork fixes generation (August 2026) and tracks Suno's current web API.
> The fix is also submitted upstream as [PR #286](https://github.com/gcui-art/suno-api/pull/286).
> All credit for the original project goes to gcui-art and its contributors; this fork also
> incorporates improvements from the zach-fau fork and upstream PR #271 (aqeel-spec).

## What's different in this fork

- **Generation works.** CAPTCHA handling is driven by Suno's `/api/c/check` response:
  `captcha_version: 1` = hCaptcha (invisible), `captcha_version: 2` = Cloudflare Turnstile.
  The correct challenge is solved via [2Captcha](https://2captcha.com) — no browser needed in
  the common case.
- **Current generate endpoint.** Posts to `/api/generate/v2-web/` with the `token_provider`,
  `transaction_uuid` and `metadata` fields Suno's backend now expects.
- **Suno v5 by default** (`chirp-crow`, not upstream's v3.5).
- Two-step Clerk authentication (homepage → `/create`) for reliable session setup.
- Configurable timeouts via `TIMEOUT_*` environment variables.
- Input validation on all public methods, TypeScript interfaces for responses.
- Persona API endpoint (`/api/persona`).
- Ported CAPTCHA v2 browser fallback (multi-selector polling, debug snapshots, popup
  dismissal, mutex-serialized solving) from upstream PR #271.

## How it works

Suno gates generation behind a CAPTCHA, but which CAPTCHA is server-driven. Before each
generation the server asks `/api/c/check`; the `captcha_version` in the response selects the
provider, and the token goes into the generate payload as `token` + `token_provider`.
Because hCaptcha token validation is sitekey-based, a standard 2Captcha solve is accepted —
the whole flow takes ~60 seconds per generation, most of it the CAPTCHA solve.

If generation ever starts returning 422 again, Suno likely rotated the hCaptcha sitekey:
re-extract it from the JS bundles on `suno.com/create` (grep the `/_next/static/chunks/` files
for `sitekey`) and update `HCAPTCHA_SITEKEY` in `src/lib/SunoApi.ts`.

## Features

- Generate music from text prompts, with Custom Mode (lyrics, styles, title).
- Lyrics generation, audio extension, stem separation, aligned lyrics, personas.
- Automatic session keep-alive.
- OpenAI-compatible `/v1/chat/completions` endpoint for agent integrations.
- Adapts to GPTs/Coze-style tool schemas for use as an LLM plugin.
- LGPL-3.0 licensed.

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

```bash
- `/api/generate`: Generate music
- `/v1/chat/completions`: Generate music — OpenAI-compatible format
- `/api/custom_generate`: Generate music (Custom Mode: lyrics, style, title, etc.)
- `/api/generate_lyrics`: Generate lyrics based on prompt
- `/api/get`: Get music information by id (comma-separated; all music if omitted)
- `/api/get_limit`: Get quota info
- `/api/extend_audio`: Extend audio length
- `/api/generate_stems`: Make stem tracks (separate vocals and music)
- `/api/get_aligned_lyrics`: Word-level lyric timestamps
- `/api/clip`: Get clip information by `?id=`
- `/api/concat`: Generate the whole song from extensions
- `/api/persona`: Personas — `GET ?id=X&page=N` for persona clips, `GET` (no id) to list
    your personas, `POST { root_clip_id, name?, description?, is_public? }` to create one
- `/api/get_wav`: Lossless audio — `GET ?id=<clip_id>` returns `{ wav_file_url }`,
    converting on first request
- `/api/upsample_prompt`: Enhance prompts — `POST { original_prompt }` for song
    descriptions or `POST { original_tags, user_guidance? }` for style tags
- `/api/set_visibility`: Publish/unpublish — `POST { id, is_public }`
- `/api/trash`: Trash clips — `POST { ids: [...] }` (`trash: false` restores)
- `/api/upload`: Upload local audio for extend/remix — `POST { file_path }` (path on the
    server). Returns `upload_id`, `clip_id` and Suno's analysis (BPM, key, vocals).
    Asserts Suno's upload terms — only upload audio you own rights to.
```

Only generation requires a CAPTCHA solve; all other endpoints work with just the account
session.

You can also pass cookies in the `Cookie` header of a request to override `SUNO_COOKIE` —
handy for using multiple accounts.

## API Integration Code Examples

### Python

```python
import time
import requests

# replace with your suno-api URL
base_url = 'http://localhost:3000'


def generate_audio_by_prompt(payload):
    url = f"{base_url}/api/generate"
    response = requests.post(url, json=payload, headers={'Content-Type': 'application/json'})
    return response.json()


def get_audio_information(audio_ids):
    url = f"{base_url}/api/get?ids={audio_ids}"
    response = requests.get(url)
    return response.json()


def get_quota_information():
    url = f"{base_url}/api/get_limit"
    response = requests.get(url)
    return response.json()


if __name__ == '__main__':
    data = generate_audio_by_prompt({
        "prompt": "A popular heavy metal song about war, sung by a deep-voiced male singer, slowly and melodiously. The lyrics depict the sorrow of people after the war.",
        "make_instrumental": False,
        "wait_audio": False
    })

    ids = f"{data[0]['id']},{data[1]['id']}"
    print(f"ids: {ids}")

    for _ in range(60):
        data = get_audio_information(ids)
        if data[0]["status"] == 'streaming':
            print(f"{data[0]['id']} ==> {data[0]['audio_url']}")
            print(f"{data[1]['id']} ==> {data[1]['audio_url']}")
            break
        time.sleep(5)
```

### JavaScript

```js
const axios = require("axios");

// replace with your suno-api URL
const baseUrl = "http://localhost:3000";

async function generateAudioByPrompt(payload) {
  const url = `${baseUrl}/api/generate`;
  const response = await axios.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  return response.data;
}

async function getAudioInformation(audioIds) {
  const url = `${baseUrl}/api/get?ids=${audioIds}`;
  const response = await axios.get(url);
  return response.data;
}

async function main() {
  const data = await generateAudioByPrompt({
    prompt:
      "A popular heavy metal song about war, sung by a deep-voiced male singer, slowly and melodiously. The lyrics depict the sorrow of people after the war.",
    make_instrumental: false,
    wait_audio: false,
  });

  const ids = `${data[0].id},${data[1].id}`;
  console.log(`ids: ${ids}`);

  for (let i = 0; i < 60; i++) {
    const data = await getAudioInformation(ids);
    if (data[0].status === "streaming") {
      console.log(`${data[0].id} ==> ${data[0].audio_url}`);
      console.log(`${data[1].id} ==> ${data[1].audio_url}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

main();
```

## Contributing

Bug reports and PRs are welcome on this fork — especially when Suno changes something and
breaks generation again. Fixes are periodically submitted upstream, but this fork is where
they land first.

## License

LGPL-3.0 or later, inherited from the original project. See [LICENSE](LICENSE).

## Statement

suno-api is an unofficial open source project, intended for learning and research purposes
only. Not affiliated with Suno, Inc.
