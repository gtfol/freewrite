// The song-of-the-day pick and the link round-trip. Both are pure, and both
// are places where being subtly wrong is invisible: a bad tie-break silently
// shows you the wrong song, a bad label silently breaks the markdown link.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  pickSongOfDay,
  playsFrom,
  splitLabel,
  trackIdFrom,
  trackMarkdown,
  type Play,
} from "./spotify.ts";

const MIDNIGHT = Date.parse("2026-07-29T00:00:00Z");
const hour = (h: number) => MIDNIGHT + h * 3_600_000;

function play(name: string, at: number): Play {
  return {
    playedAt: at,
    track: { id: name.padEnd(22, "x").slice(0, 22), name, artist: "Frank Ocean" },
  };
}

test("pickSongOfDay counts plays and returns the most played", () => {
  const song = pickSongOfDay(
    [play("Nights", hour(9)), play("Pyramids", hour(10)), play("Nights", hour(11))],
    MIDNIGHT
  );
  assert.equal(song?.track.name, "Nights");
  assert.equal(song?.plays, 2);
  assert.equal(song?.considered, 3);
});

// The common case on a light listening day: everything played once. The pick
// falls back to the most recent, and `plays: 1` is what lets the UI say so.
test("pickSongOfDay breaks an all-single-play tie by most recent", () => {
  const song = pickSongOfDay(
    [play("Nights", hour(8)), play("Pyramids", hour(15)), play("Ivy", hour(12))],
    MIDNIGHT
  );
  assert.equal(song?.track.name, "Pyramids");
  assert.equal(song?.plays, 1);
});

test("pickSongOfDay prefers play count over recency", () => {
  const song = pickSongOfDay(
    [play("Nights", hour(1)), play("Nights", hour(2)), play("Ivy", hour(23))],
    MIDNIGHT
  );
  assert.equal(song?.track.name, "Nights");
});

// The window reaches back past midnight, so yesterday's plays arrive in the
// same payload. Counting them would let last night outvote today.
test("pickSongOfDay ignores plays from before the day started", () => {
  const song = pickSongOfDay(
    [play("Yesterday", hour(-4)), play("Yesterday", hour(-3)), play("Today", hour(7))],
    MIDNIGHT
  );
  assert.equal(song?.track.name, "Today");
  assert.equal(song?.considered, 1);
});

test("pickSongOfDay returns null when nothing played today", () => {
  assert.equal(pickSongOfDay([play("Yesterday", hour(-2))], MIDNIGHT), null);
  assert.equal(pickSongOfDay([], MIDNIGHT), null);
});

test("trackIdFrom reads every shape a track link arrives in", () => {
  const id = "7eqoqGkKwgOaWNNHx90uEZ";
  assert.equal(trackIdFrom(`https://open.spotify.com/track/${id}`), id);
  assert.equal(trackIdFrom(`https://open.spotify.com/track/${id}?si=abc123`), id);
  assert.equal(trackIdFrom(`https://open.spotify.com/intl-de/track/${id}`), id);
  assert.equal(trackIdFrom(`spotify:track:${id}`), id);
});

test("trackIdFrom rejects anything that isn't a track", () => {
  assert.equal(trackIdFrom("https://open.spotify.com/album/7eqoqGkKwgOaWNNHx90uEZ"), null);
  assert.equal(trackIdFrom("https://example.com/track/7eqoqGkKwgOaWNNHx90uEZ"), null);
  assert.equal(trackIdFrom("https://open.spotify.com/track/short"), null);
  assert.equal(trackIdFrom("just some prose"), null);
});

// A title with a bracket in it would otherwise close the label early and leave
// half the link as literal text in the entry.
test("trackMarkdown escapes brackets in a title", () => {
  const md = trackMarkdown({
    id: "7eqoqGkKwgOaWNNHx90uEZ",
    name: "Nights [Remix]",
    artist: "Frank Ocean",
  });
  assert.equal(
    md,
    "[♫ Nights \\[Remix\\] · Frank Ocean](https://open.spotify.com/track/7eqoqGkKwgOaWNNHx90uEZ)"
  );
});

test("splitLabel round-trips a label the / command wrote", () => {
  assert.deepEqual(splitLabel("♫ Nights · Frank Ocean"), {
    title: "Nights",
    sub: "Frank Ocean · Spotify",
  });
});

// A link the writer labeled themselves, or a bare URL with no label at all,
// still has to produce a usable card.
test("splitLabel copes with labels it didn't write", () => {
  assert.deepEqual(splitLabel("this song"), { title: "this song", sub: "Spotify" });
  assert.deepEqual(splitLabel(""), { title: "Open in Spotify", sub: "Spotify" });
});

test("playsFrom reads Spotify's history payload", () => {
  const plays = playsFrom({
    items: [
      {
        played_at: "2026-07-29T09:30:00.000Z",
        track: {
          id: "7eqoqGkKwgOaWNNHx90uEZ",
          name: "Nights",
          type: "track",
          artists: [{ name: "Frank Ocean" }],
        },
      },
    ],
  });
  assert.equal(plays.length, 1);
  assert.equal(plays[0].track.artist, "Frank Ocean");
  assert.equal(plays[0].playedAt, Date.parse("2026-07-29T09:30:00.000Z"));
});

test("playsFrom joins every credited artist", () => {
  const plays = playsFrom({
    items: [
      {
        played_at: "2026-07-29T09:30:00.000Z",
        track: {
          id: "7eqoqGkKwgOaWNNHx90uEZ",
          name: "Slide",
          artists: [{ name: "Calvin Harris" }, { name: "Frank Ocean" }],
        },
      },
    ],
  });
  assert.equal(plays[0].track.artist, "Calvin Harris, Frank Ocean");
});

// Podcast episodes and local files come back through the same endpoint with no
// id. Neither can be embedded, so neither can win the day.
test("playsFrom drops plays that can't be embedded", () => {
  const plays = playsFrom({
    items: [
      { played_at: "2026-07-29T09:00:00.000Z", track: { id: null, name: "An episode" } },
      { played_at: "2026-07-29T09:10:00.000Z", track: { id: "x".repeat(22), name: "Ep", type: "episode" } },
      { played_at: "not a date", track: { id: "y".repeat(22), name: "Broken" } },
      { played_at: "2026-07-29T09:20:00.000Z", track: null },
    ],
  });
  assert.deepEqual(plays, []);
});

test("playsFrom survives a payload that isn't the shape we expect", () => {
  assert.deepEqual(playsFrom(undefined), []);
  assert.deepEqual(playsFrom({}), []);
  assert.deepEqual(playsFrom({ items: "nope" }), []);
});
