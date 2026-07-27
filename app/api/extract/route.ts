import { NextResponse } from "next/server";

import { extract, ExtractError } from "@/lib/extract";
import type { ExtractSource } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const SOURCES: ExtractSource[] = ["direct", "archive", "render"];

export async function POST(request: Request) {
  let body: { url?: unknown; source?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof body.url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  const source = SOURCES.includes(body.source as ExtractSource)
    ? (body.source as ExtractSource)
    : "direct";

  try {
    const article = await extract(body.url, source);
    return NextResponse.json(article);
  } catch (error) {
    if (error instanceof ExtractError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: "Something went wrong parsing that page" },
      { status: 500 }
    );
  }
}
