import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * GET  /api/playlist          — list your playlists (?page=N)
 * GET  /api/playlist?id=X     — single playlist with clips (?page=N)
 * POST /api/playlist { name } — create a playlist
 * POST /api/playlist { action: 'update', playlist_id, name?, description?, image_url? }
 * POST /api/playlist { action: 'add',    playlist_id, clip_ids: [...] }
 * POST /api/playlist { action: 'remove', playlist_id, clip_ids: [...] }
 * POST /api/playlist { action: 'trash',  playlist_id, undo?: boolean }
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('id');
    const page = Number(url.searchParams.get('page')) || 1;
    const api = await sunoApi((await cookies()).toString());
    const data = id
      ? await api.getPlaylist(id, page)
      : await api.getPlaylists(page);
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error fetching playlist(s):', error?.response?.data || error);
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
    const api = await sunoApi((await cookies()).toString());
    const { action } = body;

    let data: any;
    if (!action) {
      // Create
      data = await api.createPlaylist(body.name);
    } else if (action === 'update') {
      if (!body.playlist_id) throw new Error('playlist_id is required');
      data = await api.setPlaylistMetadata(body.playlist_id, {
        name: body.name,
        description: body.description,
        image_url: body.image_url
      });
    } else if (action === 'add') {
      if (!body.playlist_id || !Array.isArray(body.clip_ids))
        throw new Error('playlist_id and clip_ids[] are required');
      await api.addToPlaylist(body.playlist_id, body.clip_ids);
      data = { success: true };
    } else if (action === 'remove') {
      if (!body.playlist_id || !Array.isArray(body.clip_ids))
        throw new Error('playlist_id and clip_ids[] are required');
      await api.removeFromPlaylist(body.playlist_id, body.clip_ids);
      data = { success: true };
    } else if (action === 'trash') {
      if (!body.playlist_id) throw new Error('playlist_id is required');
      await api.trashPlaylist(body.playlist_id, body.undo === true);
      data = { success: true };
    } else {
      return new NextResponse(JSON.stringify({
        error: `Unknown action '${action}'. Use: update | add | remove | trash (or omit action to create).`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error in playlist POST:', error?.response?.data || error);
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
