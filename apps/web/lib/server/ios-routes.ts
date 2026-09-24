import { getAuth } from "./auth";
import { getPool } from "./db";
import { createIOSAuth } from "./ios-auth";

export async function iosRequest(request: Request, operation: "authorize" | "exchange" | "session" | "account") {
  const auth = getAuth();
  if (!auth) return Response.json({ error: "sign-in is unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  return createIOSAuth(getPool(), request => auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } }))(request, operation);
}
