-- ===========================================================================
-- 005_attendance - who is in the building, and who took them home.
--
-- This is the first module that records what happens to a child during the
-- day rather than how their family arrived, and it is the most sensitive thing
-- here so far. Two decisions are therefore baked into the schema rather than
-- left to the application:
--
--   1. An educator's view is bounded by a table, not by a WHERE clause someone
--      remembered to write. `classroom_staff` is the boundary: no assignment,
--      no children.
--
--   2. Collection is recorded as free text naming a person, because "released
--      to" is the field a licensing inspector asks about and an enum of
--      guardian ids cannot express "grandmother, arranged by phone".
--
-- Attendance rows are mutable on purpose - a check-out follows a check-in on
-- the same row. The audit trail lives in `events`, which is append-only, so
-- correcting a mistyped time leaves both the correction and the original.
-- ===========================================================================

-- +up

-- Which educators are responsible for which room. Also the permission
-- boundary: an educator sees the children in rooms listed here for them.
CREATE TABLE classroom_staff (
  id           TEXT PRIMARY KEY,
  classroom_id TEXT NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  -- 'lead' is answerable for the room; 'support' works in it; 'relief' covers.
  role         TEXT NOT NULL DEFAULT 'support'
               CHECK (role IN ('lead','support','relief')),
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_classroom_staff_pair ON classroom_staff(classroom_id, user_id);
CREATE INDEX idx_classroom_staff_user ON classroom_staff(user_id);

-- One row per child per day. UNIQUE(child_id, day) so a double check-in is a
-- constraint violation rather than two conflicting truths about one morning.
CREATE TABLE attendance (
  id             TEXT PRIMARY KEY,
  child_id       TEXT NOT NULL REFERENCES children(id)   ON DELETE CASCADE,
  classroom_id   TEXT          REFERENCES classrooms(id) ON DELETE SET NULL,
  -- Local calendar date, YYYY-MM-DD. Deliberately not derived from the
  -- timestamp: a 00:15 check-out belongs to the day that is ending.
  day            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'expected'
                 CHECK (status IN ('expected','present','absent','late','excused','left_early')),
  checked_in_at  TEXT,
  checked_out_at TEXT,
  checked_in_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  checked_out_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Who physically collected the child. Blank is not the same as unknown, so
  -- the application refuses to check a child out without it.
  released_to    TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_attendance_child_day ON attendance(child_id, day);
CREATE INDEX idx_attendance_day       ON attendance(day, status);
CREATE INDEX idx_attendance_classroom ON attendance(classroom_id, day);

-- Required supervision ratio, per program, as one adult to N children. Stored
-- rather than hard-coded because it is set by provincial regulation and
-- changes without asking us. NULL means "not configured" and the ratio panel
-- says exactly that instead of showing a reassuring number nobody entered.
CREATE TABLE ratio_rules (
  program_id     TEXT PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
  children_per_staff INTEGER NOT NULL CHECK (children_per_staff > 0),
  source         TEXT,
  updated_at     TEXT NOT NULL
);

-- +down
DROP TABLE IF EXISTS ratio_rules;
DROP TABLE IF EXISTS attendance;
DROP TABLE IF EXISTS classroom_staff;
