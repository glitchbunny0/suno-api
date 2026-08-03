import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      if (!body.id || typeof body.speed_multiplier !== 'number') {
        return new NextResponse(JSON.stringify({ error: 'Missing parameters: id (string) and speed_multiplier (number) are required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const result = await (await sunoApi()).adjustClipSpeed(body.id, {
        speed_multiplier: body.speed_multiplier,
        keep_pitch: body.keep_pitch,
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
      console.error('Error adjusting speed:', error);

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
