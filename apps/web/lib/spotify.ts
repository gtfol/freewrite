// Song of the day: the pure half. What a track is, how it lands in an entry,
// and how "most played that day" gets decided. No DOM, no fetch, no React —
// the route handler, the preview renderer and the tests all read from here.
//
// The day in question is the entry's, not the clock's: writing up Sunday on
// Monday morning should still get Sunday's song. Which means the window has
// two edges, and how far back it can be asked about is a real limit rather
// than a hypothetical one.
//
// The one thing worth knowing before reading further: Spotify's play history
// is a rolling window of the last 50 plays and cannot be paged past. There is
// no endpoint for "what did I play on the 3rd" and no daily range on top-tracks
// (the shortest is ~4 weeks). Fifty plays is about three hours of listening, so
// on the API alone a day's plays are whatever part of that day survives inside
// the window — and an old enough day, or a day you listened through, survives
// in none of it.
//
// So the deployment keeps its own record instead. A cron polls the window every
// half hour and writes it to `spotify_plays`, which accumulates into the history
// the API won't serve; the route reads that and merges the live window on top
// for the plays since the last poll. Everything here stays pure and works the
// same on either source — what changed is how far back the floor sits, not what
// a day means.

export const RECENTLY_PLAYED_SCOPE = "user-read-recently-played";

// Spotify caps this endpoint at 50 and won't page past it.
export const HISTORY_LIMIT = 50;

export interface SpotifyTrack {
  id: string;
  name: string;
  artist: string;
}

// One play, trimmed to what picking needs.
export interface Play {
  playedAt: number;
  track: SpotifyTrack;
}

export interface SongOfDay {
  track: SpotifyTrack;
  plays: number;
  // The day's plays we could see at all. With the window only 50 deep this is
  // the honest denominator behind `plays` — the UI uses it to stay truthful
  // about a one-play "winner".
  considered: number;
}

// One writer's day, half-open. Only the browser can work this out: the server
// has no idea what timezone an entry was written in, so both edges travel with
// the request rather than the server guessing at midnight.
export interface Day {
  start: number;
  end: number;
}

// The local day a timestamp falls in. Built by walking the calendar rather
// than adding 24 hours, so the day the clocks change is still one day.
export function dayOf(timestamp: number): Day {
  const start = new Date(timestamp);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

// The oldest moment the history covers, across both places it comes from: the
// archive the cron has built up, and the live window on top of it. Null means
// there is no history at all — a writer who has never played anything, or an
// account connected a moment ago.
export function historyFloor(archive: number | null, live: Play[]): number | null {
  let floor = archive;
  for (const play of live) {
    if (floor === null || play.playedAt < floor) floor = play.playedAt;
  }
  return floor;
}

// Whether the history reaches the far side of a day. It covers everything from
// its oldest play until now and nothing before, so a day that had already ended
// by then was never recorded at all. It yields no plays for exactly the same
// reason a quiet day does, and calling both of them "nothing played" would tell
// a writer they listened to nothing on a day we simply cannot see.
//
// No history at all is the exception: that is an answer about every day, not a
// record that fell short of one.
//
// Before the archive existed this took the live 50 and asked the same question
// of them. The floor is just further back now — it moves back to the day the
// cron first polled, instead of sitting three hours behind the present.
export function reachesDay(floor: number | null, day: Day): boolean {
  if (floor === null) return true;
  return day.end > floor;
}

// The archive and the live window overlap on purpose — the cron cannot run
// often enough to make the live call redundant, and a fresh connection has
// nothing but the live call. A play is identified by the moment it started, so
// the overlap collapses on `playedAt` and the result comes back in order.
export function mergePlays(archived: Play[], live: Play[]): Play[] {
  const byTime = new Map<number, Play>();
  for (const play of archived) byTime.set(play.playedAt, play);
  for (const play of live) byTime.set(play.playedAt, play);
  return [...byTime.values()].sort((a, b) => a.playedAt - b.playedAt);
}

// Most plays that day wins; a tie goes to whichever was played most recently.
// On a light listening day everything ties at one play and this is really "the
// last thing you played" — `plays` says so, rather than the caller guessing.
export function pickSongOfDay(plays: Play[], day: Day): SongOfDay | null {
  // Both edges matter, not just the near one: the window reaches past an old
  // entry's day in both directions, and everything since is another day's
  // listening.
  const during = plays.filter(
    (p) => p.playedAt >= day.start && p.playedAt < day.end
  );
  if (during.length === 0) return null;

  const tallies = new Map<string, { track: SpotifyTrack; plays: number; latest: number }>();
  for (const play of during) {
    const seen = tallies.get(play.track.id);
    if (seen) {
      seen.plays += 1;
      seen.latest = Math.max(seen.latest, play.playedAt);
    } else {
      tallies.set(play.track.id, {
        track: play.track,
        plays: 1,
        latest: play.playedAt,
      });
    }
  }

  let best: { track: SpotifyTrack; plays: number; latest: number } | null = null;
  for (const tally of tallies.values()) {
    if (
      !best ||
      tally.plays > best.plays ||
      (tally.plays === best.plays && tally.latest > best.latest)
    ) {
      best = tally;
    }
  }

  return { track: best!.track, plays: best!.plays, considered: during.length };
}

// Track ids are 22 base62 characters. Share links carry a ?si= tracking param
// and sometimes a locale segment (/intl-de/track/…); the desktop app copies
// the spotify:track: URI form instead.
const TRACK_URL = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})(?:[/?#]|$)/i;
const TRACK_URI = /^spotify:track:([A-Za-z0-9]{22})$/i;

export function trackIdFrom(href: string): string | null {
  const match = TRACK_URL.exec(href) ?? TRACK_URI.exec(href);
  return match ? match[1] : null;
}

export function trackUrl(id: string): string {
  return `https://open.spotify.com/track/${id}`;
}

// The compact player — 152px tall, against 352px for the full one. utm_source
// is what Spotify's own share dialog appends.
export function embedUrl(id: string): string {
  return `https://open.spotify.com/embed/track/${id}?utm_source=generator`;
}

export function trackLabel(track: SpotifyTrack): string {
  return `♫ ${track.name} · ${track.artist}`;
}

// Square brackets in a title would close the markdown label early. Nothing
// else in a track name can break a link — parens only matter inside the URL
// half, and a track id is alphanumeric.
function escapeLabel(text: string): string {
  return text.replace(/[[\]]/g, "\\$&");
}

// What the / command types for you: readable while writing, in the downloaded
// markdown, and in the chat export — and still an embed in Preview.
export function trackMarkdown(track: SpotifyTrack): string {
  return `[${escapeLabel(trackLabel(track))}](${trackUrl(track.id)})`;
}

// The label read back off a link, for the facade card. Anything that isn't in
// our own "♫ title · artist" shape (a link the writer labeled themselves, or
// a bare URL) still gets a usable card.
export function splitLabel(text: string): { title: string; sub: string } {
  const clean = text.replace(/^♫\s*/, "").trim();
  if (!clean) return { title: "Open in Spotify", sub: "Spotify" };
  const at = clean.indexOf(" · ");
  if (at === -1) return { title: clean, sub: "Spotify" };
  return {
    title: clean.slice(0, at),
    sub: `${clean.slice(at + 3)} · Spotify`,
  };
}

// Shape of the /api/spotify/song response, shared by the route and the store.
export type SongOfDayResponse =
  | { state: "ok"; song: SongOfDay }
  // Signed in, Spotify connected, but nothing played on the entry's day.
  | { state: "empty" }
  // The entry's day is older than the 50-play window reaches back. Distinct
  // from "empty" on purpose: this one is "can't know", not "nothing".
  | { state: "out-of-reach" }
  | { state: "unlinked" }
  // Connected once, but the token no longer works — revoked access, or an
  // account linked before this app started asking for the history scope.
  | { state: "reconnect" }
  | { state: "error"; message: string };

// Spotify's play-history payload, narrowed to the fields we read.
interface RecentlyPlayed {
  items?: {
    played_at?: string;
    track?: {
      id?: string | null;
      name?: string;
      type?: string;
      artists?: { name?: string }[];
    } | null;
  }[];
}

// Podcast episodes come back through the same endpoint with a null id, and a
// local file has no id either. Both are unembeddable, so they never count.
export function playsFrom(body: unknown): Play[] {
  const items = (body as RecentlyPlayed)?.items;
  if (!Array.isArray(items)) return [];
  const plays: Play[] = [];
  for (const item of items) {
    const track = item?.track;
    if (!track?.id || (track.type && track.type !== "track")) continue;
    const playedAt = Date.parse(item?.played_at ?? "");
    if (!Number.isFinite(playedAt)) continue;
    const artist = (track.artists ?? [])
      .map((a) => a?.name)
      .filter((name): name is string => Boolean(name))
      .join(", ");
    plays.push({
      playedAt,
      track: {
        id: track.id,
        name: track.name?.trim() || "Untitled",
        artist: artist || "Unknown artist",
      },
    });
  }
  return plays;
}
