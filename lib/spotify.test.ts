// The song-of-the-day pick and the link round-trip. Both are pure, and both
// are places where being subtly wrong is invisible: a bad tie-break silently
// shows you the wrong song, a bad label silently breaks the markdown link.
//
//   npm test

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dayOf,
  historyFloor,
  mergePlays,
  pickSongOfDay,
  playsFrom,
  reachesDay,
  splitLabel,
  trackIdFrom,
  trackMarkdown,
  type Play,
} from "./spotify.ts";

const MIDNIGHT = Date.parse("2026-07-29T00:00:00Z");
const hour = (h: number) => MIDNIGHT + h * 3_600_000;
// Built by hand rather than through dayOf, so the tests don't move with the
// timezone the suite happens to run in.
const DAY = { start: MIDNIGHT, end: hour(24) };

function play(name: string, at: number): Play {
  return {
    playedAt: at,
    track: { id: name.padEnd(22, "x").slice(0, 22), name, artist: "Frank Ocean" },
  };
}

test("pickSongOfDay counts plays and returns the most played", () => {
  const song = pickSongOfDay(
    [play("Nights", hour(9)), play("Pyramids", hour(10)), play("Nights", hour(11))],
    DAY
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
    DAY
  );
  assert.equal(song?.track.name, "Pyramids");
  assert.equal(song?.plays, 1);
});

test("pickSongOfDay prefers play count over recency", () => {
  const song = pickSongOfDay(
    [play("Nights", hour(1)), play("Nights", hour(2)), play("Ivy", hour(23))],
    DAY
  );
  assert.equal(song?.track.name, "Nights");
});

// The window reaches back past midnight, so the day before arrives in the same
// payload. Counting it would let the previous night outvote the entry's day.
test("pickSongOfDay ignores plays from before the day started", () => {
  const song = pickSongOfDay(
    [play("Before", hour(-4)), play("Before", hour(-3)), play("During", hour(7))],
    DAY
  );
  assert.equal(song?.track.name, "During");
  assert.equal(song?.considered, 1);
});

// The reason the window has a far edge at all: writing up yesterday's entry
// this morning must not pick up anything played since. Today's four plays lose
// to yesterday's one, because today isn't the entry's day.
test("pickSongOfDay ignores plays from after the day ended", () => {
  const song = pickSongOfDay(
    [
      play("During", hour(21)),
      play("After", hour(25)),
      play("After", hour(26)),
      play("After", hour(27)),
      play("After", hour(28)),
    ],
    DAY
  );
  assert.equal(song?.track.name, "During");
  assert.equal(song?.considered, 1);
});

// Midnight belongs to the day it starts, not the one it ends.
test("pickSongOfDay puts each edge of the day on one side only", () => {
  assert.equal(pickSongOfDay([play("Start", DAY.start)], DAY)?.track.name, "Start");
  assert.equal(pickSongOfDay([play("End", DAY.end)], DAY), null);
});

test("pickSongOfDay returns null when nothing played that day", () => {
  assert.equal(pickSongOfDay([play("Before", hour(-2))], DAY), null);
  assert.equal(pickSongOfDay([], DAY), null);
});

test("dayOf spans the local day the timestamp falls in", () => {
  const noon = Date.now();
  const day = dayOf(noon);
  assert.ok(day.start <= noon && noon < day.end);
  assert.equal(new Date(day.start).getHours(), 0);
  assert.equal(new Date(day.start).getMinutes(), 0);
  assert.equal(new Date(day.end).getHours(), 0);
  // A day is 24 hours give or take the hour the clocks move.
  const span = day.end - day.start;
  assert.ok(span >= 23 * 3_600_000 && span <= 25 * 3_600_000, `span ${span}`);
});

test("dayOf gives one entry's whole day and nothing of the next", () => {
  const morning = dayOf(Date.parse("2026-07-29T09:00:00"));
  const evening = dayOf(Date.parse("2026-07-29T23:30:00"));
  assert.deepEqual(morning, evening);
  assert.equal(dayOf(morning.end).start, morning.end);
});

// The whole point of the distinction: a day older than the record is a day we
// have nothing to say about, and answering "nothing played" would be a lie
// that reads exactly like the truth.
test("reachesDay is false for a day that ended before the history starts", () => {
  assert.equal(reachesDay(hour(30), DAY), false);
});

test("reachesDay is true while any of the history falls inside the day", () => {
  assert.equal(reachesDay(hour(23), DAY), true);
  // Only the tail of the day was recorded — partial, but reachable, and
  // `considered` is what says how partial.
  assert.equal(reachesDay(hour(23.5), DAY), true);
});

// No play history at all is an answer about every day, not a record that fell
// short of one.
test("reachesDay is true when there is no history at all", () => {
  assert.equal(reachesDay(null, DAY), true);
});

// The floor is what makes an old day answerable: the archive reaches back to
// the writer's first poll, so a day the live window lost is still covered.
test("historyFloor takes the oldest of either source", () => {
  assert.equal(historyFloor(hour(2), [play("Nights", hour(20))]), hour(2));
  assert.equal(historyFloor(hour(20), [play("Nights", hour(2))]), hour(2));
});

// A writer who connected a moment ago has no archive, so the live window is
// the only floor there is.
test("historyFloor falls back to the live window when nothing is archived", () => {
  assert.equal(historyFloor(null, [play("Nights", hour(9))]), hour(9));
  assert.equal(historyFloor(null, []), null);
});

test("historyFloor stays null only when neither source has anything", () => {
  assert.equal(historyFloor(hour(5), []), hour(5));
});

// The two sources overlap by design — the archive can only be as fresh as the
// last poll, and the live window is what covers the gap since.
test("mergePlays collapses the overlap and keeps order", () => {
  const archived = [play("Nights", hour(9)), play("Ivy", hour(10))];
  const live = [play("Ivy", hour(10)), play("Pyramids", hour(11))];
  const merged = mergePlays(archived, live);
  assert.deepEqual(
    merged.map((p) => p.track.name),
    ["Nights", "Ivy", "Pyramids"]
  );
});

test("mergePlays sorts a live window that arrives newest-first", () => {
  const merged = mergePlays([], [play("Ivy", hour(11)), play("Nights", hour(9))]);
  assert.deepEqual(
    merged.map((p) => p.track.name),
    ["Nights", "Ivy"]
  );
});

test("mergePlays handles either side being empty", () => {
  const one = [play("Nights", hour(9))];
  assert.deepEqual(mergePlays(one, []), one);
  assert.deepEqual(mergePlays([], one), one);
  assert.deepEqual(mergePlays([], []), []);
});

// The reason the archive exists at all, end to end: a day the live 50 has long
// since rolled past is still answerable, and still counts plays properly.
test("a day only the archive covers still picks a song", () => {
  const archived = [
    play("Nights", hour(9)),
    play("Ivy", hour(10)),
    play("Nights", hour(11)),
  ];
  assert.equal(reachesDay(historyFloor(hour(2), []), DAY), true);
  const song = pickSongOfDay(mergePlays(archived, []), DAY);
  assert.equal(song?.track.name, "Nights");
  assert.equal(song?.plays, 2);
  assert.equal(song?.considered, 3);
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
