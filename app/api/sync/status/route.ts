import { NextResponse } from "next/server";

import { authConfigured, enabledProviders } from "@/lib/server/auth";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    enabled: authConfigured(),
    providers: enabledProviders(),
  });
}
