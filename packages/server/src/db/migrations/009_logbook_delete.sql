-- ===========================================================================
-- 009_logbook_delete - removing an entry without losing the fact of it.
--
-- People mistype. An entry logged twice, or logged against the wrong day, has
-- to be able to go away, and "edit it until it is right" is not an answer when
-- the whole row was a mistake.
--
-- But this is a ledger. A row that vanishes with no trace is how a total
-- silently stops matching the receipts, and "I'm sure I entered that" becomes
-- unanswerable. So a delete here marks the row and hides it everywhere that
-- counts - lists, totals, search, the spreadsheet - while the row itself stays
-- put and the event log records who removed it and what it said.
--
-- Which also makes undo trivial, and undo is what people actually want about
-- four seconds after pressing delete.
-- ===========================================================================

-- +up

ALTER TABLE logbook_entries ADD COLUMN deleted_at TEXT;
ALTER TABLE logbook_entries ADD COLUMN deleted_by TEXT REFERENCES users(id) ON DELETE SET NULL;

-- Every read filters on this, so it is worth an index rather than a scan.
CREATE INDEX idx_logbook_live ON logbook_entries(deleted_at, happened_on DESC);

-- +down
DROP INDEX IF EXISTS idx_logbook_live;
ALTER TABLE logbook_entries DROP COLUMN deleted_by;
ALTER TABLE logbook_entries DROP COLUMN deleted_at;
