import { NextResponse } from "next/server";

import {
  allowShare,
  deleteEntryShare,
  entrySnapshotFromBody,
  shareEnabled,
  updateEntryShare,
  type EntryShareMutation,
} from "@/lib/share";

export const runtime = "nodejs";

// The secret returned at creation time rides along in this header; it's the
// only thing that authorizes touching an existing link.
const TOKEN_HEADER = "x-share-token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function unavailable() {
  return NextResponse.json(
    { error: "Sharing isn't configured on this deployment" },
    { status: 503 }
  );
}

function mutationError(result: Exclude<EntryShareMutation, "ok">) {
  return result === "missing"
    ? NextResponse.json(
        { error: "This share link has expired or was deleted" },
        { status: 410 }
      )
    : NextResponse.json({ error: "Not allowed" }, { status: 403 });
}

function tokenFrom(request: Request): string | null {
  const token = request.headers.get(TOKEN_HEADER) ?? "";
  return TOKEN_PATTERN.test(token) ? token : null;
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!shareEnabled()) return unavailable();

  const { id } = await params;
  const token = tokenFrom(request);
  if (!token) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
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

    const { result, ttlSeconds } = await updateEntryShare(id, token, snapshot);
    if (result !== "ok") return mutationError(result);
    return NextResponse.json({ ttlSeconds });
  } catch {
    return NextResponse.json(
      { error: "Couldn't update the share link" },
      { status: 502 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!shareEnabled()) return unavailable();

  const { id } = await params;
  const token = tokenFrom(request);
  if (!token) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  try {
    const result = await deleteEntryShare(id, token);
    if (result !== "ok") return mutationError(result);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { error: "Couldn't delete the share link" },
      { status: 502 }
    );
  }
}
