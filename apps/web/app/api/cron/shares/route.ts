// The hourly sweep for lapsed share links. Expired links already stop being
// served the moment they lapse; this removes what they held. Entry links keep
// their id and owner hash so a delayed request can't publish them again.
//
// Scheduled by vercel.json.

import { NextResponse } from "next/server";

import { cronAuthorized } from "@/lib/server/cron";
import { purgeExpiredShares, shareEnabled } from "@/lib/share";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!shareEnabled()) {
    return NextResponse.json({ error: "sharing is not configured" }, { status: 503 });
  }
  try {
    return NextResponse.json(await purgeExpiredShares());
  } catch (error) {
    console.error("Couldn't purge expired share links:", error);
    return NextResponse.json({ error: "Couldn't purge expired share links" }, { status: 502 });
  }
}
