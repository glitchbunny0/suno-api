import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      if (!body.id || typeof body.is_public !== 'boolean') {
        return new NextResponse(JSON.stringify({ error: 'Missing parameters: id (string) and is_public (boolean) required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      await (await sunoApi()).setClipVisibility(body.id, body.is_public);

      return new NextResponse(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      });
    } catch (error) {
      console.error('Error setting visibility:', error);

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
