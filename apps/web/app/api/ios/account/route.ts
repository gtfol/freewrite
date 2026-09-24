import { iosRequest } from "@/lib/server/ios-routes";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const DELETE = (request: Request) => iosRequest(request, "account");
