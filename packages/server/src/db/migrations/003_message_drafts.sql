-- ===========================================================================
-- 003_message_drafts - the CRM writes the follow-up, a person sends it.
--
-- This is the safe half of "let AI reply to leads by itself". The message is
-- composed from a template with the family's real details merged in; a human
-- sees the recipient and the wording and sends it. When a model arrives in
-- Phase 4 it writes the body instead of the template, and this approval step
-- stays exactly where it is.
--
-- Nothing here sends anything. There is no outbound mail in this system yet,
-- and that is deliberate: a wrong message to a parent about their child cannot
-- be taken back. (spec 297 / 300 / 301 / 313)
-- ===========================================================================

-- +up

CREATE TABLE message_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  -- Which situation this is for, so the CRM can suggest the right one.
  trigger     TEXT NOT NULL CHECK (trigger IN (
                'tour_followup','registration_incomplete','registration_received',
                'waitlist_checkin','no_response','general')),
  channel     TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  subject     TEXT,
  body        TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  built_in    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Every draft that was composed, whether or not it was sent. Two reasons: an
-- honest accept-rate for when AI takes over the wording, and an answer to
-- "what did we actually say to this family".
CREATE TABLE message_drafts (
  id           TEXT PRIMARY KEY,
  family_id    TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  guardian_id  TEXT REFERENCES guardians(id) ON DELETE SET NULL,
  lead_id      TEXT REFERENCES leads(id) ON DELETE SET NULL,
  template_id  TEXT REFERENCES message_templates(id) ON DELETE SET NULL,
  channel      TEXT NOT NULL DEFAULT 'email',
  -- Resolved at compose time and stored, so the record shows what was actually
  -- put in front of the person, not what a template would render today.
  to_address   TEXT,
  subject      TEXT,
  body         TEXT NOT NULL,
  -- 'composed'  the CRM wrote it, nobody has looked
  -- 'edited'    a person changed the wording
  -- 'sent'      a person marked it sent (by whatever means)
  -- 'discarded' a person rejected it
  status       TEXT NOT NULL DEFAULT 'composed'
               CHECK (status IN ('composed','edited','sent','discarded')),
  -- Who wrote the words. 'template' today, 'ai' in Phase 4.
  author       TEXT NOT NULL DEFAULT 'template' CHECK (author IN ('template','ai','human')),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  resolved_at  TEXT
);
CREATE INDEX idx_drafts_family ON message_drafts(family_id, created_at DESC);
CREATE INDEX idx_drafts_status ON message_drafts(status, created_at DESC);

-- +down
DROP TABLE IF EXISTS message_drafts;
DROP TABLE IF EXISTS message_templates;
