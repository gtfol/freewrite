import { NextResponse } from "next/server";

import { allowShare, putShare, shareEnabled } from "@/lib/share";

export const runtime = "nodejs";

const MAX_TEXT_CHARS = 600_000;
const MAX_META_CHARS = 500;

export async function GET() {
  return NextResponse.json({ enabled: shareEnabled() });
}

export async function POST(request: Request) {
  if (!shareEnabled()) {
    return NextResponse.json(
      { error: "Sharing isn't configured on this deployment" },
      { status: 503 }
    );
  }

  let body: { title?: unknown; byline?: unknown; url?: unknown; text?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const title =
    typeof body.title === "string" ? body.title.slice(0, MAX_META_CHARS).trim() : "";
  const byline =
    typeof body.byline === "string" ? body.byline.slice(0, MAX_META_CHARS).trim() : "";
  const url =
    typeof body.url === "string" ? body.url.slice(0, 2000).trim() : "";
  const text = typeof body.text === "string" ? body.text : "";

  if (!text.trim()) {
    return NextResponse.json({ error: "Nothing to share" }, { status: 400 });
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: "That article is too large to share" },
      { status: 413 }
    );
  }

  const ip = (request.headers.get("x-forwarded-for") ?? "unknown")
    .split(",")[0]
    .trim();

  try {
    if (!(await allowShare(ip))) {
      return NextResponse.json(
        { error: "Too many share links right now — try again later" },
        { status: 429 }
      );
    }

    const payload = [
      `# ${title || "Untitled article"}`,
      byline ? `by ${byline}` : null,
      url ? `Originally from: ${url}` : null,
      "",
      "(Temporary reader snapshot shared from freewrite — this link expires automatically.)",
      "",
      text,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const { id, ttlSeconds } = await putShare(payload);
    return NextResponse.json({ id, ttlSeconds });
  } catch {
    return NextResponse.json(
      { error: "Couldn't create a share link" },
      { status: 502 }
    );
  }
}
