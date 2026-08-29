-- ===========================================================================
-- 008_logbook - saying what you did, and getting a spreadsheet back.
--
-- The director's day produces facts that currently live in a shoebox: what was
-- bought, from where, for which room, what got fixed, what ran out. This is a
-- place to say those out loud and have them stay said.
--
-- Two things are deliberate.
--
-- `raw_text` keeps exactly what the person said, verbatim, next to whatever was
-- parsed out of it. When the parse is wrong - and it will sometimes be wrong,
-- because it is reading English - the original sentence is still there to
-- correct it from. Storing only the parsed fields would make a bad parse
-- permanent and invisible.
--
-- Money is INTEGER cents, never a float. $84.32 in binary floating point is not
-- $84.32, and a column of those summed over a year is off by real money.
-- ===========================================================================

-- +up

CREATE TABLE logbook_entries (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL DEFAULT 'note'
                CHECK (kind IN ('purchase','supply','task','note')),
  -- The day it happened, which is not always the day it was written down.
  happened_on   TEXT NOT NULL,
  summary       TEXT NOT NULL,
  vendor        TEXT,
  amount_cents  INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  currency      TEXT NOT NULL DEFAULT 'CAD',
  category      TEXT,
  classroom_id  TEXT REFERENCES classrooms(id) ON DELETE SET NULL,
  -- Exactly what was said or typed, kept whatever the parser made of it.
  raw_text      TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'typed' CHECK (source IN ('typed','voice')),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_logbook_when     ON logbook_entries(happened_on DESC);
CREATE INDEX idx_logbook_kind     ON logbook_entries(kind, happened_on DESC);
CREATE INDEX idx_logbook_category ON logbook_entries(category, happened_on DESC);
CREATE INDEX idx_logbook_vendor   ON logbook_entries(vendor);

-- Full text over what was said, so "what did I buy at Costco" finds it. Kept
-- separate from the main search index: the logbook is the director's own
-- notebook and has no business appearing in a search for a family.
CREATE VIRTUAL TABLE logbook_fts USING fts5(
  entry_id UNINDEXED,
  body,
  tokenize = 'porter unicode61'
);

-- +down
DROP TABLE IF EXISTS logbook_fts;
DROP TABLE IF EXISTS logbook_entries;
