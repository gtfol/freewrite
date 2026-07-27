import { getShare, shareEnabled } from "@/lib/share";

export const runtime = "nodejs";

// Plain text on purpose: it's what LLM fetchers digest best, and serving
// client-supplied content as text (with nosniff) closes the door on hosting
// arbitrary HTML under this domain.
const TEXT_HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow, noarchive",
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  if (!shareEnabled()) {
    return new Response("Sharing isn't configured on this deployment.", {
      status: 404,
      headers: TEXT_HEADERS,
    });
  }

  try {
    const payload = await getShare(id);
    if (payload === null) {
      return new Response("This share link has expired or never existed.", {
        status: 410,
        headers: TEXT_HEADERS,
      });
    }
    return new Response(payload, { status: 200, headers: TEXT_HEADERS });
  } catch {
    return new Response("The share store is unreachable right now.", {
      status: 502,
      headers: TEXT_HEADERS,
    });
  }
}
