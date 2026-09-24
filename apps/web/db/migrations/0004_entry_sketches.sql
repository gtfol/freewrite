-- writer sketches: the / command's whiteboard drawings, stored as a json array
-- on the entry row and synced as part of the record. The entry text carries
-- only a reference to each one, so the strokes stay out of the prose.
alter table entries add column if not exists sketches jsonb;
