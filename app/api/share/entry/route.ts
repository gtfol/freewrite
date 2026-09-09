import { NextResponse } from "next/server";
import { parseEntryShareExpiry } from "@/lib/share-expiry";

import {
  allowShare,
  entrySnapshotFromBody,
  putEntryShare,
  shareEnabled,
} from "@/lib/share";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!shareEnabled()) {
    return NextResponse.json(
      { error: "Sharing isn't configured on this deployment" },
      { status: 503 }
    );
  }

  let body: Parameters<typeof entrySnapshotFromBody>[0] & { expiresIn?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const snapshot = entrySnapshotFromBody(body);
  if ("error" in snapshot) {
    return NextResponse.json(
      { error: snapshot.error },
      { status: snapshot.status }
    );
  }

  const expiry = parseEntryShareExpiry(body.expiresIn);
  if (expiry === false) {
    return NextResponse.json({ error: "Choose 7 days, 30 days, or Never" }, { status: 400 });
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

    const result = await putEntryShare(snapshot, expiry);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "Couldn't create a share link" },
      { status: 502 }
    );
  }
}
