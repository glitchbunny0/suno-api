import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { DEFAULT_MODEL, sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * POST /api/cover
 * Reimagine an existing clip in a new style (Suno "Cover").
 * Body: { audio_id, prompt?, tags?, negative_tags?, title?, model?, wait_audio?,
 *         cover_start_s?, cover_end_s? }
 * prompt = new lyrics (optional — omit to keep the original's),
 * tags   = new style. cover_start_s/cover_end_s limit which part of the source is used.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { audio_id, prompt, tags, negative_tags, title, model, wait_audio, cover_start_s, cover_end_s } = body;

    if (!audio_id) {
      return new NextResponse(JSON.stringify({ error: 'Audio ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const audioInfo = await (await sunoApi((await cookies()).toString()))
      .coverClip(audio_id, prompt || '', tags || '', negative_tags || '', title || '',
        model || DEFAULT_MODEL, wait_audio || false, cover_start_s, cover_end_s);

    return new NextResponse(JSON.stringify(audioInfo), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error cover audio:', error?.response?.data || error);
    return new NextResponse(JSON.stringify({
      error: error?.response?.data?.detail || error.message || 'Internal server error'
    }), {
      status: error?.response?.status || 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 200, headers: corsHeaders });
}
