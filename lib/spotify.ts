// Song of the day: the pure half. What a track is, how it lands in an entry,
// and how "most played today" gets decided. No DOM, no fetch, no React — the
// route handler, the preview renderer and the tests all read from here.
//
// The one thing worth knowing before reading further: Spotify's play history
// is a rolling window of the last 50 plays and cannot be paged past. There is
// no endpoint for "what did I play today" and no daily range on top-tracks
// (the shortest is ~4 weeks), so today's plays are whatever part of today
// survives inside those 50 items.

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
  // Today's plays we could see at all. With the window only 50 deep this is
  // the honest denominator behind `plays` — the UI uses it to stay truthful
  // about a one-play "winner".
  considered: number;
}

// Most plays today wins; a tie goes to whichever was played most recently. On
// a light listening day everything ties at one play and this is really "the
// last thing you played" — `plays` says so, rather than the caller guessing.
export function pickSongOfDay(plays: Play[], since: number): SongOfDay | null {
  const today = plays.filter((p) => p.playedAt >= since);
  if (today.length === 0) return null;

  const tallies = new Map<string, { track: SpotifyTrack; plays: number; latest: number }>();
  for (const play of today) {
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

  return { track: best!.track, plays: best!.plays, considered: today.length };
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
  // Signed in, Spotify connected, but nothing played since midnight.
  | { state: "empty" }
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
