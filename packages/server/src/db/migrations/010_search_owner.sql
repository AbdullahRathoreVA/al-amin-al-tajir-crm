-- ===========================================================================
-- 010_search_owner - so a search result can open the record it found.
--
-- Search indexes eight kinds of thing, but only two of them have a page of
-- their own: a family and a registration. The rest - a child, a guardian, a
-- note, a lead, a tour - are only ever *shown* inside a family. The index had
-- no way to say which family, so the command bar sent every one of those hits
-- to the unfiltered families list and left the operator to find it again by
-- eye.
--
-- Which means the most natural thing anyone types - a child's first name - was
-- the one search that could not take you anywhere. That is the opposite of
-- "one click to act".
--
-- So the index carries its owning family. The column is `family_id` and not
-- `owner_id` because `tasks.owner_id` already exists and means the member of
-- staff a task belongs to; two columns of the same name meaning different
-- things is how the wrong one gets joined at two in the morning.
--
-- It is appended rather than inserted, because snippet() addresses columns by
-- position and `body` must stay at index 3.
--
-- FTS5 has no ALTER TABLE, so this is a drop and a rebuild. The table is a
-- derived cache of the operational tables and nothing is lost by emptying it,
-- but it does have to be refilled: boot calls reindexAll() when it finds an
-- empty index next to a non-empty families table. That check earns its place
-- on its own - it is also how the index recovers from a partial write.
-- ===========================================================================

-- +up

DROP TABLE IF EXISTS search_index;

CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body,
  family_id   UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- +down

DROP TABLE IF EXISTS search_index;

CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
