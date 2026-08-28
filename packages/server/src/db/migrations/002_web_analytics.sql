-- ===========================================================================
-- 002_web_analytics - website behaviour, without tracking people.
--
-- What is deliberately NOT stored: no IP address, no cookie, no cross-visit
-- identity, no full referrer URL, no free text a parent typed. A session id is
-- random, lives in sessionStorage, and dies with the tab, so the same person on
-- Monday and Friday is two sessions and there is no way to link them.
--
-- That is not a limitation to route around later. On a childcare site the
-- families are the customers, and "we do not track you" has to be true.
-- ===========================================================================

-- +up

CREATE TABLE web_sessions (
  id             TEXT PRIMARY KEY,   -- random, per tab, never persisted client-side
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  landing_path   TEXT,
  -- Host only: "google.com", never the full search URL, which can carry a query.
  referrer_host  TEXT,
  utm_source     TEXT,
  utm_medium     TEXT,
  utm_campaign   TEXT,
  device         TEXT CHECK (device IN ('mobile','tablet','desktop')),
  -- Coarse, from the edge header. Country only, never a city or a coordinate.
  country        TEXT,
  pageviews      INTEGER NOT NULL DEFAULT 0,
  event_count    INTEGER NOT NULL DEFAULT 0,
  -- Time the tab was actually VISIBLE and the person was active, not wall clock.
  engaged_ms     INTEGER NOT NULL DEFAULT 0,
  -- Set when this session reached a registration, tour or waitlist request.
  converted      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_wsessions_seen    ON web_sessions(first_seen DESC);
CREATE INDEX idx_wsessions_ref     ON web_sessions(referrer_host);
CREATE INDEX idx_wsessions_conv    ON web_sessions(converted, first_seen DESC);

CREATE TABLE web_events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  path        TEXT,
  -- Allow-listed, non-identifying props only. The website sanitises before it
  -- sends; this is the second line, not the first.
  props_json  TEXT,
  engaged_ms  INTEGER,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX idx_wevents_when    ON web_events(occurred_at DESC);
CREATE INDEX idx_wevents_name    ON web_events(name, occurred_at DESC);
CREATE INDEX idx_wevents_session ON web_events(session_id);
CREATE INDEX idx_wevents_path    ON web_events(path, occurred_at DESC);

-- +down
DROP TABLE IF EXISTS web_events;
DROP TABLE IF EXISTS web_sessions;
