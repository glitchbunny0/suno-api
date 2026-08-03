import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      if (!Array.isArray(body.ids) || body.ids.length === 0) {
        return new NextResponse(JSON.stringify({ error: 'Missing parameter: ids (non-empty array of clip ids) required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const trash = body.trash !== false; // default: trash; pass trash:false to restore
      await (await sunoApi()).trashClips(body.ids, trash);

      return new NextResponse(JSON.stringify({ success: true, trashed: trash, ids: body.ids }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('Error trashing clips:', error);

      return new NextResponse(JSON.stringify({ error: 'Internal server error. ' + error }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    }
  } else {
    return new NextResponse('Method Not Allowed', {
      headers: {
        Allow: 'POST',
        ...corsHeaders
      },
      status: 405
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, {
    status: 200,
    headers: corsHeaders
  });
}
