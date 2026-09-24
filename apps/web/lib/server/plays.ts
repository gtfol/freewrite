// The play history Spotify won't keep, kept here instead.
//
// Reading it back is deliberately narrow: a day's plays, and the oldest moment
// the record covers. That second one is what keeps "we have no record of that
// day" honest and separate from "you played nothing that day" — see reachesDay.

import { getPool } from "@/lib/server/db";
import type { Day, Play } from "@/lib/spotify";

// `dayFrom` falls back to an open-ended day when the browser sends a broken
// clock, and Postgres cannot compare a bigint to Infinity.
const FAR_FUTURE = Number.MAX_SAFE_INTEGER;

// pg hands bigint back as a string, so every read of played_at goes through
// Number() — the same thing the sync route does with its timestamps.
export async function recordPlays(userId: string, plays: Play[]): Promise<number> {
  if (plays.length === 0) return 0;
  // Written as one unnest rather than a row per play: consecutive polls overlap
  // almost entirely, so this is mostly a no-op that shouldn't cost 50 round
  // trips to discover. The primary key drops whatever was already recorded.
  const { rowCount } = await getPool().query(
    `insert into spotify_plays (user_id, played_at, track_id, name, artist)
     select $1, * from unnest($2::bigint[], $3::text[], $4::text[], $5::text[])
     on conflict (user_id, played_at) do nothing`,
    [
      userId,
      plays.map((p) => p.playedAt),
      plays.map((p) => p.track.id),
      plays.map((p) => p.track.name),
      plays.map((p) => p.track.artist),
    ]
  );
  return rowCount ?? 0;
}

export async function playsOnDay(userId: string, day: Day): Promise<Play[]> {
  const end = Number.isFinite(day.end) ? day.end : FAR_FUTURE;
  const { rows } = await getPool().query(
    `select played_at, track_id, name, artist
       from spotify_plays
      where user_id = $1 and played_at >= $2 and played_at < $3
      order by played_at`,
    [userId, day.start, end]
  );
  return rows.map((row) => ({
    playedAt: Number(row.played_at),
    track: { id: row.track_id, name: row.name, artist: row.artist },
  }));
}

// How far back the record goes for one writer. Null when nothing has ever been
// recorded for them, which is a different thing from a record that starts after
// the day being asked about.
export async function archiveFloor(userId: string): Promise<number | null> {
  const { rows } = await getPool().query(
    `select min(played_at) as floor from spotify_plays where user_id = $1`,
    [userId]
  );
  const floor = rows[0]?.floor;
  return floor === null || floor === undefined ? null : Number(floor);
}

// Everyone the cron has to poll. Spotify can't create an account here, so this
// is always a subset of the users — the ones who ran Connect.
export async function connectedUserIds(): Promise<string[]> {
  const { rows } = await getPool().query(
    `select distinct "userId" from account where "providerId" = 'spotify'`
  );
  return rows.map((row) => row.userId as string);
}
