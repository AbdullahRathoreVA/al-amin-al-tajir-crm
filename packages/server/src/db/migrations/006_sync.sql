-- ===========================================================================
-- 006_sync - somewhere for outbound rows to actually go.
--
-- `outbox` has been collecting rows since the first commit and nothing has
-- ever drained it, so every queued row sat at 'pending' forever and the health
-- check warned about a backlog that had no destination to go to. That is the
-- same crying-wolf failure as the backup check: a warning nobody can act on
-- trains people to ignore warnings they can.
--
-- A target is the missing half. With no enabled target for a channel, its
-- queued rows are waiting rather than failing, and /system can say which.
--
-- Deliberately NOT in here: any credential. The refresh token lives in the
-- platform's secret store and is read from the environment. A token in a table
-- is a token in every backup, and the backups are copied around.
-- ===========================================================================

-- +up

CREATE TABLE sync_targets (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  label         TEXT NOT NULL,
  -- For Sheets: the spreadsheet id and the tab within it. Nullable because a
  -- target can be created and configured before it is pointed anywhere.
  external_id   TEXT,
  tab_name      TEXT,
  -- Column mapping, so a sheet's shape can change without a code change.
  mapping_json  TEXT NOT NULL DEFAULT '{}',
  enabled       INTEGER NOT NULL DEFAULT 0,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_sync_targets_channel ON sync_targets(channel);

-- One row per attempt to drain the queue, including the attempts that decided
-- to do nothing. "Why didn't it sync?" is the question people actually ask,
-- and it cannot be answered from a log that only records successes.
CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  outcome       TEXT NOT NULL
                CHECK (outcome IN ('sent','nothing_queued','not_connected','failed','skipped')),
  considered    INTEGER NOT NULL DEFAULT 0,
  sent          INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  failed        INTEGER NOT NULL DEFAULT 0,
  detail        TEXT
);
CREATE INDEX idx_sync_runs_when ON sync_runs(channel, started_at DESC);

-- Which family an outbox row is about, so `families.no_sync` can be honoured
-- by the query that selects rows to send rather than by someone remembering.
-- Nullable: not every queued row is about a family.
ALTER TABLE outbox ADD COLUMN family_id TEXT REFERENCES families(id) ON DELETE SET NULL;
CREATE INDEX idx_outbox_family ON outbox(family_id);

-- +down
DROP INDEX IF EXISTS idx_outbox_family;
ALTER TABLE outbox DROP COLUMN family_id;
DROP TABLE IF EXISTS sync_runs;
DROP TABLE IF EXISTS sync_targets;
