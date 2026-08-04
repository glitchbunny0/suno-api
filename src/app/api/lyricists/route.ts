import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Lyricists — reusable AI writing-style profiles that feed /api/cowrite_lyrics.
 *
 * GET    /api/lyricists            — list (?limit=N&cursor=...)
 * GET    /api/lyricists?id=X       — single lyricist with samples
 * POST   /api/lyricists            — create { name, description?, sample_lyrics?: [] }
 * PATCH  /api/lyricists            — update { id, name?, description?, sample_lyrics?,
 *                                    is_favorited? }
 * DELETE /api/lyricists            — delete { id } (or ?id=X)
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const api = await sunoApi((await cookies()).toString());
    const data = id
      ? await api.getLyricist(id)
      : await api.getLyricists(
          Number(url.searchParams.get('limit')) || 100,
          url.searchParams.get('cursor') || undefined
        );
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error fetching lyricist(s):', error?.response?.data || error);
    return new NextResponse(JSON.stringify({
      error: error?.response?.data?.detail || error.message || 'Internal server error'
    }), {
      status: error?.response?.status || 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.name) throw new Error('name is required');
    const api = await sunoApi((await cookies()).toString());
    const data = await api.createLyricist(body.name, {
      description: body.description,
      sample_lyrics: body.sample_lyrics
    });
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error creating lyricist:', error?.response?.data || error);
    return new NextResponse(JSON.stringify({
      error: error?.response?.data?.detail || error.message || 'Internal server error'
    }), {
      status: error?.response?.status || 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    if (!body.id) throw new Error('id is required');
    const api = await sunoApi((await cookies()).toString());
    const data = await api.updateLyricist(body.id, {
      name: body.name,
      description: body.description,
      sample_lyrics: body.sample_lyrics,
      is_favorited: body.is_favorited
    });
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error updating lyricist:', error?.response?.data || error);
    return new NextResponse(JSON.stringify({
      error: error?.response?.data?.detail || error.message || 'Internal server error'
    }), {
      status: error?.response?.status || 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    let id = url.searchParams.get('id');
    if (!id) {
      const body = await req.json().catch(() => ({}));
      id = body.id;
    }
    if (!id) throw new Error('id is required (query param or JSON body)');
    const api = await sunoApi((await cookies()).toString());
    await api.deleteLyricist(id);
    return new NextResponse(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error deleting lyricist:', error?.response?.data || error);
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
