-- reader highlights: quote-anchored annotations with optional notes, stored
-- as a json array on the article row and synced as part of the record.
alter table articles add column if not exists highlights jsonb;
