-- share links move from upstash redis into this database. redis archived the
-- store after a quiet stretch and every link went with it; postgres is already
-- here for sign-in and sync, so shares live next to everything else.
--
-- a published entry. anyone with the id can read the snapshot; only the holder
-- of the management token (kept in the author's browser, stored here as a
-- sha-256 hash) can update, re-time or delete it. revoking or expiring a link
-- clears its snapshot but keeps the row, so a delayed request can never
-- recreate an id that was already retired. expires_at null means never.
create table if not exists entry_shares (
  id text primary key,
  token_hash text not null,
  snapshot jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

-- the reader's temporary chat snapshots: plain text, gone after half an hour.
create table if not exists reader_shares (
  id text primary key,
  payload text not null,
  expires_at timestamptz not null
);

-- new-link rate limit: a fixed one-hour window per client address.
create table if not exists share_rate_limits (
  ip text primary key,
  window_start timestamptz not null,
  count integer not null
);

-- reads go through the app's own connection, which owns these tables and so
-- bypasses row level security. enabling it with no policies keeps supabase's
-- public data api from listing unlisted links or management hashes.
alter table entry_shares enable row level security;
alter table reader_shares enable row level security;
alter table share_rate_limits enable row level security;

-- every lookup is by primary key; /api/cron/shares scans for lapsed rows once
-- an hour, which at this size needs no index of its own.
