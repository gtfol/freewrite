-- freewrite: auth (better-auth) + sync tables
-- fresh install: run this once in the supabase sql editor.
-- existing install: don't rerun this — apply db/migrations/*.sql in order instead.
-- every schema change lands in both places in the same pr.

create table if not exists "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null default false,
  "image" text,
  "createdAt" timestamp not null default now(),
  "updatedAt" timestamp not null default now()
);

create table if not exists "session" (
  "id" text not null primary key,
  "expiresAt" timestamp not null,
  "token" text not null unique,
  "createdAt" timestamp not null default now(),
  "updatedAt" timestamp not null default now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);

create table if not exists "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamp,
  "refreshTokenExpiresAt" timestamp,
  "scope" text,
  "password" text,
  "createdAt" timestamp not null default now(),
  "updatedAt" timestamp not null default now()
);

create table if not exists "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamp not null,
  "createdAt" timestamp default now(),
  "updatedAt" timestamp default now()
);

create sequence if not exists sync_seq;

create table if not exists entries (
  id uuid primary key,
  user_id text not null references "user" (id) on delete cascade,
  content text not null,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  seq bigint not null default nextval('sync_seq'),
  hash text not null default ''
);
create index if not exists entries_user_seq on entries (user_id, seq);

create table if not exists articles (
  id uuid primary key,
  user_id text not null references "user" (id) on delete cascade,
  url text not null,
  title text not null,
  byline text,
  site_name text,
  excerpt text,
  content text not null,
  content_original text,
  word_count integer not null,
  saved_at bigint not null,
  read_at bigint,
  via text,
  highlights jsonb,
  updated_at bigint not null,
  deleted_at bigint,
  seq bigint not null default nextval('sync_seq'),
  hash text not null default ''
);
create index if not exists articles_user_seq on articles (user_id, seq);

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

-- the play history spotify won't keep. it serves reads only from this
-- deployment, so it carries no seq/hash: nothing about it syncs to a client.
create table if not exists spotify_plays (
  user_id text not null references "user" (id) on delete cascade,
  played_at bigint not null,
  track_id text not null,
  name text not null,
  artist text not null,
  primary key (user_id, played_at)
);
create index if not exists spotify_plays_user_time
  on spotify_plays (user_id, played_at desc);
