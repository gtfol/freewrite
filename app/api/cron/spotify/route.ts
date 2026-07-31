// The half-hourly poll that turns Spotify's rolling 50 into history.
//
// Nothing here is clever: fetch each connected writer's window, write it down,
// move on. The whole design is in the fact that it runs often enough. Fifty
// plays is roughly three hours of listening, so every thirty minutes leaves a
// wide margin for a heavy day and still costs one request per writer.
//
// Scheduled by vercel.json. Vercel Cron sends `Authorization: Bearer
// $CRON_SECRET`, which is the only thing standing between this and the open
// internet — so the route refuses to run at all when that secret isn't set.

import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { getAuth } from "@/lib/server/auth";
import { connectedUserIds, recordPlays } from "@/lib/server/plays";
import { HISTORY_LIMIT, playsFrom } from "@/lib/spotify";

export const runtime = "nodejs";
export const maxDuration = 60;

// No `after` cursor on purpose. It would trim the response to the plays since
// the last poll, but it also makes correctness depend on a cursor whose
// semantics Spotify has never been crisp about, and the window is only 50 items
// wide anyway. Asking for all 50 every time and letting the primary key drop
// the overlap is both cheaper to reason about and self-healing: a poll that
// fails, or a deploy that pauses the cron for an hour, backfills itself on the
// next run rather than leaving a permanent hole.
const HISTORY_URL = `https://api.spotify.com/v1/me/player/recently-played?limit=${HISTORY_LIMIT}`;

// One writer's poll should never be able to take the whole run down with it: a
// revoked token is an ordinary state, not an outage.
const CONCURRENCY = 4;

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const offered = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  // Same length is a precondition for timingSafeEqual, and comparing the
  // lengths first leaks only the length.
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
}

async function pollOne(
  auth: NonNullable<ReturnType<typeof getAuth>>,
  userId: string
): Promise<{ recorded: number } | { error: string }> {
  let token: string | undefined;
  try {
    // Deliberately no `headers`: better-auth resolves the user from the session
    // when a request is attached and refuses the call outright when one is
    // attached but invalid. A cron has no session, so passing nothing is what
    // lets `userId` be honoured — and the refresh still happens and still gets
    // written back to the account row.
    const granted = await auth.api.getAccessToken({
      body: { providerId: "spotify", userId },
    });
    token = granted?.accessToken;
  } catch (error) {
    const code = (error as { body?: { code?: string } })?.body?.code;
    return { error: code ?? "token refresh failed" };
  }
  if (!token) return { error: "no access token" };

  const res = await fetch(HISTORY_URL, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  // Access revoked, or the account was linked before this app asked for the
  // history scope. Either way the writer has to reconnect; the record they
  // already have stays exactly as it is.
  if (res.status === 401 || res.status === 403) return { error: "reconnect" };
  if (!res.ok) return { error: `spotify ${res.status}` };

  const plays = playsFrom(await res.json());
  return { recorded: await recordPlays(userId, plays) };
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const auth = getAuth();
  if (!auth) {
    return NextResponse.json({ error: "auth is not configured" }, { status: 503 });
  }

  const userIds = await connectedUserIds();
  let recorded = 0;
  let failed = 0;

  // A fixed pool of workers pulling off one shared list, so a deployment with
  // more connected writers than the run has seconds still makes progress on the
  // ones it reaches instead of opening every request at once.
  const queue = [...userIds];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
        try {
          const result = await pollOne(auth, id);
          if ("error" in result) failed += 1;
          else recorded += result.recorded;
        } catch {
          failed += 1;
        }
      }
    })
  );

  return NextResponse.json({ polled: userIds.length, recorded, failed });
}
