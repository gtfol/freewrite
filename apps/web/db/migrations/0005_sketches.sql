-- whiteboard drawings become records of their own, synced like entries and
-- articles. they used to be a jsonb column on the entry that made them; they are
-- resolved by the ![sketch](sketch:id) reference in a text now, wherever that
-- reference ends up, so one can be copied from one entry into another and no
-- single entry owns its lifetime.
create table if not exists sketches (
  id text primary key,
  user_id text not null references "user" (id) on delete cascade,
  w integer not null,
  h integer not null,
  bg text not null,
  strokes jsonb not null,
  updated_at bigint not null,
  deleted_at bigint,
  seq bigint not null default nextval('sync_seq'),
  hash text not null default ''
);
create index if not exists sketches_user_seq on sketches (user_id, seq);

-- 0004's column is dead: drawings that arrived through it are re-adopted from
-- the entry on first load and pushed as records. dropping it is safe once every
-- client a deployment serves is past this migration, and harmless to defer.
-- alter table entries drop column if exists sketches;
