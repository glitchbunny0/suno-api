import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      if (!body.id || (!body.fade_in_time && !body.fade_out_time)) {
        return new NextResponse(JSON.stringify({ error: 'Missing parameters: id and at least one of fade_in_time/fade_out_time (seconds) are required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const result = await (await sunoApi()).fadeClip(body.id, {
        fade_in_time: body.fade_in_time,
        fade_out_time: body.fade_out_time,
        title: body.title
      });

      return new NextResponse(JSON.stringify(result), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('Error fading clip:', error);

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
