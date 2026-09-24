import { NextResponse } from "next/server";

import { getAuth } from "@/lib/server/auth";
import {
  archiveFloor,
  playsOnDay,
  recordPlays,
} from "@/lib/server/plays";
import {
  type Day,
  HISTORY_LIMIT,
  historyFloor,
  mergePlays,
  pickSongOfDay,
  type Play,
  playsFrom,
  reachesDay,
  type SongOfDayResponse,
} from "@/lib/spotify";

export const runtime = "nodejs";

const HISTORY_URL = `https://api.spotify.com/v1/me/player/recently-played?limit=${HISTORY_LIMIT}`;

const DAY_MS = 24 * 60 * 60 * 1000;
// A local day is 24 hours give or take an hour, on the two days a year the
// clocks move.
const SHORTEST_DAY = 23 * 60 * 60 * 1000;
const LONGEST_DAY = 25 * 60 * 60 * 1000;

// The day belongs to the entry, and its edges belong to the writer's timezone,
// which the server can't work out — so the browser sends both and this only
// checks they describe a plausible day. A day that hasn't started yet, or one
// that isn't a day long, is a broken clock rather than a timezone, and falls
// back to the last 24 hours.
//
// How far back the day is isn't checked here: an old day is a perfectly valid
// question, and the honest answer to it comes from `reachesDay`.
function dayFrom(request: Request): Day {
  const params = new URL(request.url).searchParams;
  const start = Number(params.get("since"));
  const end = Number(params.get("until"));
  const now = Date.now();
  const span = end - start;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > now ||
    span < SHORTEST_DAY ||
    span > LONGEST_DAY
  ) {
    return { start: now - DAY_MS, end: Infinity };
  }
  return { start, end };
}

function json(body: SongOfDayResponse, status = 200) {
  return NextResponse.json(body, { status });
}

// Whether the live window can still add anything the archive doesn't have.
//
// It can, in two cases. A day that is still running, or only just over, has
// plays from after the last poll — up to half an hour of them. And a writer
// whose record is empty has just connected, so the live window is the only
// history there is. Every other day is settled: the cron saw it in full, and
// the call would be a round trip that returns other days' listening.
function needsLive(day: Day, floor: number | null, now: number): boolean {
  return floor === null || day.end > now - DAY_MS;
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

  const day = dayFrom(request);
  const userId = session.user.id;

  // The record first: for any day the cron has covered this is the whole
  // answer, and it reaches back as far as the writer has been connected rather
  // than three hours.
  const [archived, floor] = await Promise.all([
    playsOnDay(userId, day),
    archiveFloor(userId),
  ]);

  let live: Play[] = [];
  if (needsLive(day, floor, Date.now())) {
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

    live = playsFrom(await res.json());
    // Asking for the day's song is itself a poll, and a free one. It matters
    // most for the writer who connected a minute ago: it gets their first
    // plays into the record without waiting on the cron. Failing to write is
    // not worth failing the request over — the answer below doesn't depend on
    // it, and the next poll will record the same plays anyway.
    await recordPlays(userId, live).catch(() => {});
  }

  if (!reachesDay(historyFloor(floor, live), day)) {
    return json({ state: "out-of-reach" });
  }

  const song = pickSongOfDay(mergePlays(archived, live), day);
  return song ? json({ state: "ok", song }) : json({ state: "empty" });
}
