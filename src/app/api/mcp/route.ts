import { createMcpHandler } from 'mcp-handler';
import { z } from 'zod';
import { sunoApi } from '@/lib/SunoApi';

export const dynamic = 'force-dynamic';

/**
 * MCP (Model Context Protocol) endpoint — Streamable HTTP transport.
 * Exposes the suno-api feature set as typed tools for AI agents.
 * Point any MCP client at http://<host>:3000/api/mcp
 */

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
});

const fail = (err: unknown): ToolResult => ({
  content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true
});

const handler = createMcpHandler(
  (server) => {
    // ── Generation ────────────────────────────────────────────────

    server.registerTool(
      'generate_music',
      {
        description:
          'Generate music from a text description. Takes ~60s for the CAPTCHA solve; ' +
          'with wait_audio=false returns submitted clips immediately, with wait_audio=true ' +
          'polls until songs are ready (1-3 min). Use get_clips to poll later.',
        inputSchema: z.object({
          prompt: z.string().describe('Song description, e.g. "lo-fi hip hop loop, mellow keys"'),
          make_instrumental: z.boolean().optional().describe('No vocals (default false)'),
          model: z.string().optional().describe('Model name, default chirp-crow (Suno v5)'),
          wait_audio: z.boolean().optional().describe('Wait for songs to finish rendering (default false)')
        })
      },
      async ({ prompt, make_instrumental, model, wait_audio }) => {
        try {
          const api = await sunoApi();
          return ok(await api.generate(prompt, make_instrumental ?? false, model, wait_audio ?? false));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'custom_generate_music',
      {
        description:
          'Generate music in Custom Mode with your own lyrics, style tags and title. ' +
          'Same timing as generate_music.',
        inputSchema: z.object({
          prompt: z.string().describe('Lyrics (with <Verse>/<Chorus> structure tags for best results)'),
          tags: z.string().describe('Style tags, e.g. "melancholic synthwave, 90 BPM"'),
          title: z.string().describe('Song title'),
          make_instrumental: z.boolean().optional(),
          negative_tags: z.string().optional().describe('Styles to avoid'),
          model: z.string().optional(),
          wait_audio: z.boolean().optional()
        })
      },
      async ({ prompt, tags, title, make_instrumental, negative_tags, model, wait_audio }) => {
        try {
          const api = await sunoApi();
          return ok(await api.custom_generate(prompt, tags, title, make_instrumental ?? false, model, wait_audio ?? false, negative_tags));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'generate_lyrics',
      {
        description: 'Generate lyrics (and a title + style suggestion) from a prompt.',
        inputSchema: z.object({
          prompt: z.string().describe('What the lyrics should be about')
        })
      },
      async ({ prompt }) => {
        try {
          const api = await sunoApi();
          return ok({ lyrics: await api.generateLyrics(prompt) });
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'cowrite_lyrics',
      {
        description:
          'Edit lyrics with an instruction, e.g. "make the chorus more aggressive". ' +
          'Pass the lyric fragment in selected; add context_before/context_after so the ' +
          'edit fits the surrounding song. Returns edited_lyrics.',
        inputSchema: z.object({
          instruction: z.string().describe('What to change, e.g. "darker imagery, keep the rhyme scheme"'),
          selected: z.string().describe('The lyric text to edit'),
          context_before: z.string().optional().describe('Lyrics before the selection'),
          context_after: z.string().optional().describe('Lyrics after the selection'),
          lyricist_id: z.string().optional().describe('Lyricist persona id (simple mode)'),
          lyrics_model: z.string().optional().describe('Lyrics model (context mode, default "default")')
        })
      },
      async ({ instruction, selected, context_before, context_after, lyricist_id, lyrics_model }) => {
        try {
          const api = await sunoApi();
          return ok(await api.cowriteLyrics({ instruction, selected, context_before, context_after, lyricist_id, lyrics_model }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'lyrics_infill',
      {
        description:
          'Regenerate one section of lyrics while keeping the rest. prefix/suffix are ' +
          'preserved verbatim; the edit section is rewritten following the prompt. ' +
          'Returns generated_lyrics plus the stitched full_text.',
        inputSchema: z.object({
          prompt: z.string().describe('What the new section should be, e.g. "a bridge about letting go"'),
          edit: z.string().describe('The lyric section to replace ("" to append after prefix)'),
          prefix: z.string().optional().describe('Lyrics before the section (kept as-is)'),
          suffix: z.string().optional().describe('Lyrics after the section (kept as-is)'),
          title: z.string().optional()
        })
      },
      async ({ prompt, edit, prefix, suffix, title }) => {
        try {
          const api = await sunoApi();
          return ok(await api.lyricsInfill({ prompt, edit, prefix, suffix, title }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'get_rhymes',
      {
        description:
          'Rhyme suggestions for a word — perfect and slant rhymes, optionally aware ' +
          'of the lyric line and genre style they should fit.',
        inputSchema: z.object({
          word: z.string().describe('Word to rhyme (min 2 chars)'),
          context_line: z.string().optional().describe('The lyric line the rhyme should fit'),
          style: z.string().optional().describe('Genre/style context'),
          count: z.number().optional().describe('Max suggestions (default 16)'),
          include_slant: z.boolean().optional().describe('Include near/slant rhymes (default true)')
        })
      },
      async ({ word, context_line, style, count, include_slant }) => {
        try {
          const api = await sunoApi();
          return ok(await api.getRhymes({ word, context_line, style, count, include_slant }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'crop_clip',
      {
        description:
          'Crop a clip to a time range — or with remove_section=true, cut that range out ' +
          'and keep the rest. Async worker, takes up to ~2 min. Returns the new action_clip_id.',
        inputSchema: z.object({
          clip_id: z.string(),
          start_s: z.number().describe('Range start in seconds'),
          end_s: z.number().describe('Range end in seconds'),
          remove_section: z.boolean().optional().describe('Cut the range OUT instead of keeping it (default false)'),
          title: z.string().optional()
        })
      },
      async ({ clip_id, start_s, end_s, remove_section, title }) => {
        try {
          const api = await sunoApi();
          return ok(await api.cropClip(clip_id, { start_s, end_s, remove_section, title }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'fade_clip',
      {
        description:
          'Apply fade-in and/or fade-out to a clip. Async worker, up to ~2 min. ' +
          'Returns the new action_clip_id.',
        inputSchema: z.object({
          clip_id: z.string(),
          fade_in_time: z.number().optional().describe('Fade-in seconds'),
          fade_out_time: z.number().optional().describe('Fade-out seconds'),
          title: z.string().optional()
        })
      },
      async ({ clip_id, fade_in_time, fade_out_time, title }) => {
        try {
          const api = await sunoApi();
          return ok(await api.fadeClip(clip_id, { fade_in_time, fade_out_time, title }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'adjust_speed',
      {
        description: 'Change a clip\'s speed, optionally preserving pitch. Returns the new clip.',
        inputSchema: z.object({
          clip_id: z.string(),
          speed_multiplier: z.number().describe('e.g. 0.5 half-time, 1.5, 2 double-time'),
          keep_pitch: z.boolean().optional().describe('Preserve pitch (default false)'),
          title: z.string().optional()
        })
      },
      async ({ clip_id, speed_multiplier, keep_pitch, title }) => {
        try {
          const api = await sunoApi();
          return ok(await api.adjustClipSpeed(clip_id, { speed_multiplier, keep_pitch, title }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'extend_audio',
      {
        description: 'Extend an existing clip from a given timestamp (in seconds). Requires a CAPTCHA solve (~60s).',
        inputSchema: z.object({
          clip_id: z.string().describe('ID of the clip to extend'),
          continue_at: z.number().describe('Timestamp in seconds where the extension starts'),
          prompt: z.string().optional().describe('Lyrics for the extension (custom mode)'),
          tags: z.string().optional(),
          title: z.string().optional(),
          negative_tags: z.string().optional(),
          model: z.string().optional(),
          wait_audio: z.boolean().optional()
        })
      },
      async ({ clip_id, continue_at, prompt, tags, title, negative_tags, model, wait_audio }) => {
        try {
          const api = await sunoApi();
          return ok(await api.extendAudio(clip_id, prompt ?? '', continue_at, tags ?? '', negative_tags ?? '', title ?? '', model, wait_audio));
        } catch (e) { return fail(e); }
      }
    );

    // ── Prompt helpers ────────────────────────────────────────────

    server.registerTool(
      'upsample_prompt',
      {
        description:
          'Enhance a short prompt or style tags using Suno\'s own upsampler. ' +
          'Provide original_prompt for song descriptions or original_tags for style tags. ' +
          'Great before generate_music when the idea is vague.',
        inputSchema: z.object({
          original_prompt: z.string().optional().describe('Song description to enhance'),
          original_tags: z.string().optional().describe('Style tags to enhance'),
          user_guidance: z.string().optional().describe('Direction for the tags enhancement, e.g. "make it darker"')
        })
      },
      async ({ original_prompt, original_tags, user_guidance }) => {
        try {
          const api = await sunoApi();
          return ok(await api.upsamplePrompt({ original_prompt, original_tags, user_guidance }));
        } catch (e) { return fail(e); }
      }
    );

    // ── Library ───────────────────────────────────────────────────

    server.registerTool(
      'get_clips',
      {
        description: 'Get clip info and status. Omit ids for the recent feed. Statuses: submitted -> streaming/complete (or error).',
        inputSchema: z.object({
          ids: z.array(z.string()).optional().describe('Clip IDs; omit for the full recent feed')
        })
      },
      async ({ ids }) => {
        try {
          const api = await sunoApi();
          return ok(await api.get(ids));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'get_clip',
      {
        description: 'Get detailed metadata for a single clip.',
        inputSchema: z.object({
          clip_id: z.string()
        })
      },
      async ({ clip_id }) => {
        try {
          const api = await sunoApi();
          return ok(await api.getClip(clip_id));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'get_wav_url',
      {
        description:
          'Get a lossless WAV download URL for a clip. Triggers conversion on first ' +
          'request — may take up to 2 minutes.',
        inputSchema: z.object({
          clip_id: z.string()
        })
      },
      async ({ clip_id }) => {
        try {
          const api = await sunoApi();
          return ok({ wav_file_url: await api.getWavUrl(clip_id) });
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'get_aligned_lyrics',
      {
        description: 'Get word-level lyric timestamps for a clip.',
        inputSchema: z.object({
          clip_id: z.string()
        })
      },
      async ({ clip_id }) => {
        try {
          const api = await sunoApi();
          return ok(await api.getLyricAlignment(clip_id));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'set_clip_visibility',
      {
        description: 'Publish or unpublish a clip on the Suno profile.',
        inputSchema: z.object({
          clip_id: z.string(),
          is_public: z.boolean()
        })
      },
      async ({ clip_id, is_public }) => {
        try {
          const api = await sunoApi();
          await api.setClipVisibility(clip_id, is_public);
          return ok({ success: true, clip_id, is_public });
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'trash_clips',
      {
        description: 'Move clips to trash (or restore with trash=false). Trashed clips disappear from the feed.',
        inputSchema: z.object({
          clip_ids: z.array(z.string()).describe('Clip IDs to trash/restore'),
          trash: z.boolean().optional().describe('false to restore (default true)')
        })
      },
      async ({ clip_ids, trash }) => {
        try {
          const api = await sunoApi();
          await api.trashClips(clip_ids, trash ?? true);
          return ok({ success: true, trashed: trash ?? true, clip_ids });
        } catch (e) { return fail(e); }
      }
    );

    // ── Personas ──────────────────────────────────────────────────

    server.registerTool(
      'list_personas',
      {
        description: 'List the account\'s personas (reusable vocal identities), paginated.',
        inputSchema: z.object({
          page: z.number().optional()
        })
      },
      async ({ page }) => {
        try {
          const api = await sunoApi();
          return ok(await api.getPersonas(page ?? 1));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'create_persona',
      {
        description:
          'Create a persona (reusable vocal identity) from a clip\'s vocals. ' +
          'Suno allows exactly one persona per clip (error already_exists_for_clip).',
        inputSchema: z.object({
          root_clip_id: z.string().describe('Clip to take the voice from'),
          name: z.string().optional(),
          description: z.string().optional(),
          is_public: z.boolean().optional()
        })
      },
      async ({ root_clip_id, name, description, is_public }) => {
        try {
          const api = await sunoApi();
          return ok(await api.createPersona({ root_clip_id, name, description, is_public }));
        } catch (e) { return fail(e); }
      }
    );

    // ── Uploads & account ─────────────────────────────────────────

    server.registerTool(
      'upload_audio',
      {
        description:
          'Upload a local audio file (path on the API server) for extend/remix/covers. ' +
          'Returns upload_id, clip_id and Suno\'s analysis (BPM, key, vocals). ' +
          'Only upload audio you own rights to — Suno\'s upload terms are asserted.',
        inputSchema: z.object({
          file_path: z.string().describe('Absolute path to the audio file on the server'),
          upload_type: z.string().optional().describe('default "file_upload"'),
          is_stem_mix: z.boolean().optional()
        })
      },
      async ({ file_path, upload_type, is_stem_mix }) => {
        try {
          const api = await sunoApi();
          return ok(await api.uploadAudio(file_path, { uploadType: upload_type, isStemMix: is_stem_mix }));
        } catch (e) { return fail(e); }
      }
    );

    server.registerTool(
      'get_credits',
      {
        description: 'Get the Suno account\'s credit balance and usage.',
        inputSchema: z.object({})
      },
      async () => {
        try {
          const api = await sunoApi();
          return ok(await api.getCredits());
        } catch (e) { return fail(e); }
      }
    );
  },
  {
    serverInfo: {
      name: 'suno-api',
      version: '1.0.0'
    }
  }
);

export { handler as GET, handler as POST, handler as DELETE };
