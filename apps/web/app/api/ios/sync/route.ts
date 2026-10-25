import { iosRequest } from "@/lib/server/ios-routes";

export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) { return iosRequest(request, "sync"); }
