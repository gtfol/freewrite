import { NextResponse } from "next/server";

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

  let body: Parameters<typeof entrySnapshotFromBody>[0];
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

    const { id, token, ttlSeconds } = await putEntryShare(snapshot);
    return NextResponse.json({ id, token, ttlSeconds });
  } catch {
    return NextResponse.json(
      { error: "Couldn't create a share link" },
      { status: 502 }
    );
  }
}
