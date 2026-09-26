import { timingSafeEqual } from "node:crypto";

// Vercel Cron sends `Authorization: Bearer $CRON_SECRET`, which is the only
// thing standing between a cron route and the open internet — so cron routes
// refuse to run at all when that secret isn't set.
export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const offered = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  // Same length is a precondition for timingSafeEqual, and comparing the
  // lengths first leaks only the length.
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
}
