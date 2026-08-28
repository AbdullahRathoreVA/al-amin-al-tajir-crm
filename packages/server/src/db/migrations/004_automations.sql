-- ===========================================================================
-- 004_automations - rules staff can edit, instead of behaviour buried in code.
--
-- The pipeline already creates a task and an alert when a registration lands.
-- That logic is correct but invisible: nobody can see it, change the timing, or
-- turn it off. This moves it somewhere a director can read.
--
-- Every run is logged, including the ones that decided to do nothing, because
-- "why didn't it fire?" is the question people actually ask. (spec 16 / 17)
-- ===========================================================================

-- +up

CREATE TABLE automations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  -- What starts it. Event triggers fire on an event; scheduled triggers are
  -- swept on a timer and look for a condition that has become true.
  trigger     TEXT NOT NULL CHECK (trigger IN (
                'registration.submitted','registration.incomplete',
                'tour.requested','tour.completed','tour.upcoming',
                'lead.stalled','task.overdue','waitlist.joined','family.created')),
  -- JSON. Interpreted by a small fixed evaluator, never eval'd.
  conditions  TEXT NOT NULL DEFAULT '[]',
  actions     TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  -- Runs but writes nothing, so a rule can be watched before it is trusted.
  test_mode   INTEGER NOT NULL DEFAULT 0,
  -- Stops one rule stampeding the whole family list after a bad import.
  max_per_run INTEGER NOT NULL DEFAULT 50,
  built_in    INTEGER NOT NULL DEFAULT 0,
  run_count   INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_automations_trigger ON automations(trigger, enabled);

-- Every execution, including no-ops. Without the no-ops there is no way to
-- answer "why didn't it fire?", which is the question that actually gets asked.
CREATE TABLE automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  entity_type   TEXT,
  entity_id     TEXT,
  outcome       TEXT NOT NULL CHECK (outcome IN ('acted','skipped','failed','test')),
  -- Plain English. Shown directly to a person.
  reason        TEXT NOT NULL,
  actions_json  TEXT,
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_runs_automation ON automation_runs(automation_id, created_at DESC);
CREATE INDEX idx_runs_time       ON automation_runs(created_at DESC);
CREATE INDEX idx_runs_entity     ON automation_runs(entity_type, entity_id);

-- +down
DROP TABLE IF EXISTS automation_runs;
DROP TABLE IF EXISTS automations;
