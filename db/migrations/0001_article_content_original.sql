-- articles gained content_original (trim's restore data) after the first release.
alter table articles add column if not exists content_original text;
