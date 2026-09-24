import { iosRequest } from "@/lib/server/ios-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = (request: Request) => iosRequest(request, "session");
export const DELETE = (request: Request) => iosRequest(request, "session");
