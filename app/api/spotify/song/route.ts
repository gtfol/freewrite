import { NextResponse } from "next/server";

import { getAuth } from "@/lib/server/auth";
import {
  HISTORY_LIMIT,
  pickSongOfDay,
  playsFrom,
  type SongOfDayResponse,
} from "@/lib/spotify";

export const runtime = "nodejs";

const HISTORY_URL = `https://api.spotify.com/v1/me/player/recently-played?limit=${HISTORY_LIMIT}`;

const DAY_MS = 24 * 60 * 60 * 1000;

// Today is the writer's today, so the client sends its own midnight rather
// than the server guessing at a timezone. A week back is already far more
// history than the 50-play window can hold, so anything beyond that — or in
// the future — is a broken clock, not a timezone, and falls back to 24 hours.
function dayStart(request: Request): number {
  const since = Number(new URL(request.url).searchParams.get("since"));
  const now = Date.now();
  if (!Number.isFinite(since) || since > now || now - since > 7 * DAY_MS) {
    return now - DAY_MS;
  }
  return since;
}

function json(body: SongOfDayResponse, status = 200) {
  return NextResponse.json(body, { status });
}

// The Spotify token stays here. The browser gets a track name and an id — the
// same thing it would get off a share link — and never the credential.
export async function GET(request: Request) {
  const auth = getAuth();
  if (!auth) {
    return json(
      { state: "error", message: "Sync is not configured on this deployment" },
      503
    );
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return json({ state: "error", message: "Sign in first" }, 401);
  }

  let token: string | undefined;
  try {
    // Refreshes the access token on the way out when it has expired, and
    // writes the new one back to the account row.
    const granted = await auth.api.getAccessToken({
      body: { providerId: "spotify" },
      headers: request.headers,
    });
    token = granted?.accessToken;
  } catch (error) {
    const code = (error as { body?: { code?: string } })?.body?.code;
    return json({
      state: code === "ACCOUNT_NOT_FOUND" ? "unlinked" : "reconnect",
    });
  }
  if (!token) return json({ state: "unlinked" });

  let res: Response;
  try {
    res = await fetch(HISTORY_URL, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch {
    return json({ state: "error", message: "Couldn't reach Spotify" }, 502);
  }

  // 401 means the refreshed token was rejected anyway; 403 usually means the
  // account was linked before this app asked for the history scope. Both are
  // fixed by connecting again.
  if (res.status === 401 || res.status === 403) {
    return json({ state: "reconnect" });
  }
  if (res.status === 429) {
    return json({ state: "error", message: "Spotify is rate limiting — try again shortly" }, 429);
  }
  if (!res.ok) {
    return json({ state: "error", message: `Spotify said ${res.status}` }, 502);
  }

  const song = pickSongOfDay(playsFrom(await res.json()), dayStart(request));
  return song ? json({ state: "ok", song }) : json({ state: "empty" });
}
