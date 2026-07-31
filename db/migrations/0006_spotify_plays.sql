-- spotify hands out play history as a rolling 50 and will not page past it, so
-- "what did i play on the 3rd" has no answer in the api once the 3rd is more
-- than fifty plays ago — about three hours of listening. the way every app with
-- real history solves this (stats.fm, last.fm) is to stop asking and start
-- keeping: poll the window on a schedule and write it down. this table is the
-- record, and /api/cron/spotify is what fills it.
create table if not exists spotify_plays (
  user_id text not null references "user" (id) on delete cascade,
  played_at bigint not null,
  track_id text not null,
  name text not null,
  artist text not null,
  primary key (user_id, played_at)
);

-- one account plays one track at a time, so (user, played_at) is the play. that
-- is what makes polling free to overlap: consecutive windows repeat almost
-- everything they contain and the primary key drops the repeats.
--
-- and it is the only index this table needs. both reads are a range scan over
-- one writer's plays — the day lookup and the oldest-play floor — and the
-- primary key already covers (user_id, played_at) in that order. a descending
-- index for the floor would be dead weight: postgres walks a btree backwards
-- just as happily, and the planner ignores the duplicate when offered one.
