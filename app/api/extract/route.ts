import { NextResponse } from "next/server";

import { extract, ExtractError } from "@/lib/extract";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { url?: unknown; archive?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  if (typeof body.url !== "string") {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }

  try {
    const article = await extract(body.url, body.archive === true);
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
