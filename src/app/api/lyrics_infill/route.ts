import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      if (!body.prompt || body.edit === undefined) {
        return new NextResponse(JSON.stringify({ error: 'Missing parameters: prompt and edit are required' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          }
        });
      }

      const result = await (await sunoApi()).lyricsInfill({
        prompt: body.prompt,
        edit: body.edit,
        prefix: body.prefix,
        suffix: body.suffix,
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
      console.error('Error regenerating lyrics section:', error);

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
