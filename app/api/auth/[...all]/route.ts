import { NextResponse } from "next/server";

import { getAuth } from "@/lib/server/auth";

export const runtime = "nodejs";

function handle(request: Request) {
  const auth = getAuth();
  if (!auth) {
    return NextResponse.json(
      { error: "Sync is not configured on this deployment" },
      { status: 503 }
    );
  }
  return auth.handler(request);
}

export { handle as GET, handle as POST };
