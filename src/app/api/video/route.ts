import { NextResponse, NextRequest } from "next/server";
import { cookies } from 'next/headers'
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Music videos for clips.
 *
 * POST /api/video { clip_id } — start video generation for a clip
 * GET  /api/video?id=X        — poll generation status ({ status, video_url? })
 */
export async function GET(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) throw new Error('id query param is required');
    const api = await sunoApi((await cookies()).toString());
    const data = await api.getVideoStatus(id);
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error fetching video status:', error?.response?.data || error);
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
    if (!body.clip_id) throw new Error('clip_id is required');
    const api = await sunoApi((await cookies()).toString());
    const data = await api.generateVideo(body.clip_id);
    return new NextResponse(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (error: any) {
    console.error('Error generating video:', error?.response?.data || error);
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
