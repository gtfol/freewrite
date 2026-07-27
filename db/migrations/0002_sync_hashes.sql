-- sync v2: content hashes for change detection and reconciliation.
-- '' marks pre-hash rows; the first write from an upgraded client fills them.
alter table entries add column if not exists hash text not null default '';
alter table articles add column if not exists hash text not null default '';
