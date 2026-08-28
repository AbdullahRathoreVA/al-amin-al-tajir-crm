-- ===========================================================================
-- 001_foundation - Phase 1 core + registration ingestion.
--
-- Conventions, applied everywhere:
--   * ids are TEXT uuid4. Portable, mergeable, no sequence collisions if these
--     databases are ever synced between devices. (spec 157)
--   * timestamps are TEXT ISO-8601 in UTC. Sortable as text, no tz bugs.
--   * every operational record carries source / source_id / created_* /
--     updated_* so it can always answer "where did this come from". (spec 200)
--   * privacy flags are columns, not conventions, so they can be enforced by
--     query rather than by remembering. (spec 108)
-- ===========================================================================

-- +up

-- --------------------------------------------------------------- identity
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','director','admissions','educator','accounting','readonly')),
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at);

-- --------------------------------------------------------------- programs
CREATE TABLE programs (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  age_label  TEXT,
  capacity   INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE classrooms (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  program_id TEXT REFERENCES programs(id) ON DELETE SET NULL,
  capacity   INTEGER,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- --------------------------------------------------------------- families
CREATE TABLE families (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'prospective'
              CHECK (status IN ('prospective','touring','applying','waitlisted','enrolled','alumni','lost')),
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  source_id   TEXT,
  local_only  INTEGER NOT NULL DEFAULT 0,
  no_ai       INTEGER NOT NULL DEFAULT 0,
  no_sync     INTEGER NOT NULL DEFAULT 0,
  dup_of      TEXT REFERENCES families(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  created_by  TEXT,
  updated_by  TEXT
);
CREATE INDEX idx_families_status ON families(status);
CREATE INDEX idx_families_owner  ON families(owner_id);
CREATE INDEX idx_families_dup    ON families(dup_of) WHERE dup_of IS NOT NULL;

CREATE TABLE guardians (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  relationship  TEXT,
  email         TEXT,
  phone         TEXT,
  email_norm    TEXT,
  phone_norm    TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  is_emergency  INTEGER NOT NULL DEFAULT 0,
  can_pickup    INTEGER NOT NULL DEFAULT 0,
  contact_pref  TEXT CHECK (contact_pref IN ('email','phone','either')),
  opted_out     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_guardians_family ON guardians(family_id);
CREATE INDEX idx_guardians_email  ON guardians(email_norm) WHERE email_norm IS NOT NULL;
CREATE INDEX idx_guardians_phone  ON guardians(phone_norm) WHERE phone_norm IS NOT NULL;

CREATE TABLE children (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT,
  date_of_birth TEXT,
  age_band      TEXT,
  program_id    TEXT REFERENCES programs(id) ON DELETE SET NULL,
  classroom_id  TEXT REFERENCES classrooms(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'prospective'
                CHECK (status IN ('prospective','waitlisted','offered','enrolled','withdrawn')),
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_children_family  ON children(family_id);
CREATE INDEX idx_children_program ON children(program_id);

-- ------------------------------------------------------------------ leads
CREATE TABLE lead_stages (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_open    INTEGER NOT NULL DEFAULT 1,
  is_won     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE leads (
  id                 TEXT PRIMARY KEY,
  family_id          TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  stage_id           TEXT NOT NULL REFERENCES lead_stages(id),
  source             TEXT NOT NULL DEFAULT 'manual',
  source_id          TEXT,
  program_interest   TEXT,
  age_band           TEXT,
  desired_start      TEXT,
  owner_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  next_action        TEXT,
  next_action_due    TEXT,
  next_action_reason TEXT,
  last_contact_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  created_by         TEXT,
  updated_by         TEXT
);
CREATE INDEX idx_leads_stage  ON leads(stage_id);
CREATE INDEX idx_leads_family ON leads(family_id);
CREATE INDEX idx_leads_due    ON leads(next_action_due) WHERE next_action_due IS NOT NULL;

-- ------------------------------------------------------------------ tours
CREATE TABLE tours (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested','scheduled','confirmed','completed','no-show','cancelled','rescheduled')),
  scheduled_for TEXT,
  completed_at  TEXT,
  owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  notes         TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_tours_when   ON tours(scheduled_for);
CREATE INDEX idx_tours_status ON tours(status);
CREATE INDEX idx_tours_family ON tours(family_id);

-- ---------------------------------------------------------- registrations
CREATE TABLE registrations (
  id              TEXT PRIMARY KEY,
  family_id       TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id        TEXT REFERENCES children(id) ON DELETE SET NULL,
  lead_id         TEXT REFERENCES leads(id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'started'
                  CHECK (status IN ('started','submitted','reviewing','incomplete','approved','declined','withdrawn')),
  program_id      TEXT REFERENCES programs(id) ON DELETE SET NULL,
  desired_start   TEXT,
  completed_steps INTEGER,
  total_steps     INTEGER,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  source          TEXT NOT NULL DEFAULT 'manual',
  source_id       TEXT,
  submitted_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_reg_family ON registrations(family_id);
CREATE INDEX idx_reg_status ON registrations(status);

CREATE TABLE waitlist (
  id            TEXT PRIMARY KEY,
  family_id     TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  child_id      TEXT REFERENCES children(id) ON DELETE SET NULL,
  program_id    TEXT REFERENCES programs(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','accepted','declined','removed')),
  desired_start TEXT,
  added_at      TEXT NOT NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_waitlist_program ON waitlist(program_id, status);

-- ------------------------------------------------------------------ tasks
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT,
  owner_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('critical','high','normal','low')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','doing','done','cancelled')),
  due_at       TEXT,
  related_type TEXT,
  related_id   TEXT,
  source       TEXT NOT NULL DEFAULT 'manual',
  reason       TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_tasks_open    ON tasks(status, due_at);
CREATE INDEX idx_tasks_owner   ON tasks(owner_id, status);
CREATE INDEX idx_tasks_related ON tasks(related_type, related_id);

CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  body        TEXT NOT NULL,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_notes_entity ON notes(entity_type, entity_id, created_at DESC);

-- ------------------------------------------------------- event store / audit
-- Append-only. Nothing in the application is permitted to UPDATE or DELETE a
-- row here; the triggers below make that a database guarantee, not a habit.
CREATE TABLE events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  id          TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  actor_type  TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user','system','integration','ai')),
  actor_id    TEXT,
  source      TEXT NOT NULL DEFAULT 'manual',
  summary     TEXT,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_events_entity ON events(entity_type, entity_id, seq DESC);
CREATE INDEX idx_events_time   ON events(created_at DESC);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events is append-only'); END;

-- Who looked at what. Separate from events: reads are not changes, but reading
-- a child record is still something that must be answerable later. (spec 166)
CREATE TABLE access_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_access_time ON access_log(created_at DESC);

-- ------------------------------------------------------------- ingestion
-- The idempotency ledger. A repeated eventId returns the FIRST result rather
-- than doing the work twice. This is what makes "submit twice" safe. (spec 31)
CREATE TABLE ingest_events (
  event_id     TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  source       TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('received','processed','failed','rejected')),
  result_json  TEXT,
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  received_at  TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX idx_ingest_status ON ingest_events(status, received_at DESC);

-- Failed outbound work (Sheets, email, notifications) parks here so a human can
-- look at it, instead of vanishing into a log. (spec 191/192)
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  channel       TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_outbox_pending ON outbox(status, next_retry_at);

-- ------------------------------------------------------------ notifications
CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  tier          TEXT NOT NULL DEFAULT 'normal' CHECK (tier IN ('critical','high','normal','digest','log')),
  title         TEXT NOT NULL,
  body          TEXT,
  link_type     TEXT,
  link_id       TEXT,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  dedupe_key    TEXT,
  state         TEXT NOT NULL DEFAULT 'unread' CHECK (state IN ('unread','read','acted','dismissed','snoozed')),
  snoozed_until TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_notif_state ON notifications(user_id, state, created_at DESC);
CREATE UNIQUE INDEX idx_notif_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ----------------------------------------------------------------- search
-- Denormalised FTS index. Rebuilt through reindex(); no triggers, because the
-- write paths already know what changed and triggers would fire mid-transaction
-- on partially-written rows.
CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- +down
DROP TABLE IF EXISTS search_index;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS ingest_events;
DROP TABLE IF EXISTS access_log;
DROP TRIGGER IF EXISTS events_no_update;
DROP TRIGGER IF EXISTS events_no_delete;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS notes;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS waitlist;
DROP TABLE IF EXISTS registrations;
DROP TABLE IF EXISTS tours;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS lead_stages;
DROP TABLE IF EXISTS children;
DROP TABLE IF EXISTS guardians;
DROP TABLE IF EXISTS families;
DROP TABLE IF EXISTS classrooms;
DROP TABLE IF EXISTS programs;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
