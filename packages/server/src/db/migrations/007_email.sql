-- ===========================================================================
-- 007_email - actually sending a draft, without ever sending one by itself.
--
-- Until now `status = 'sent'` meant "a person copied this into their own mail
-- client". This adds delivery, and the whole design question is how to add it
-- without also adding a path by which something could send on its own.
--
-- The answer is that delivery is a second, separate axis. A draft's `status`
-- records what a person decided; `delivery_state` records what the machine did
-- about it. Nothing sets delivery_state to anything but 'none' except an
-- explicit request from a signed-in human, and `requested_by` is NOT NULL for
-- exactly that reason: a queued send with nobody's name on it cannot be
-- represented in this schema.
--
-- That is the rule the whole system is built to keep. It should be enforced by
-- a constraint, not by everyone remembering.
-- ===========================================================================

-- +up

ALTER TABLE message_drafts ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'none'
  CHECK (delivery_state IN ('none','queued','sent','failed'));

-- Who pressed send. Not nullable in practice: see the trigger below, which
-- refuses a queued row that cannot name a person.
ALTER TABLE message_drafts ADD COLUMN requested_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE message_drafts ADD COLUMN requested_at TEXT;
ALTER TABLE message_drafts ADD COLUMN delivered_at TEXT;
ALTER TABLE message_drafts ADD COLUMN delivery_error TEXT;
ALTER TABLE message_drafts ADD COLUMN outbox_id TEXT REFERENCES outbox(id) ON DELETE SET NULL;

CREATE INDEX idx_drafts_delivery ON message_drafts(delivery_state, requested_at);

-- The rule, as a database guarantee rather than a habit. A draft cannot enter
-- any delivery state without naming the person who asked for it, on insert or
-- on update. An automation or an AI path that tried would abort here.
CREATE TRIGGER trg_drafts_send_needs_a_person_ins
BEFORE INSERT ON message_drafts
WHEN NEW.delivery_state <> 'none' AND NEW.requested_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a message cannot be sent without recording who sent it');
END;

CREATE TRIGGER trg_drafts_send_needs_a_person_upd
BEFORE UPDATE ON message_drafts
WHEN NEW.delivery_state <> 'none' AND NEW.requested_by IS NULL
BEGIN
  SELECT RAISE(ABORT, 'a message cannot be sent without recording who sent it');
END;

-- +down
DROP TRIGGER IF EXISTS trg_drafts_send_needs_a_person_upd;
DROP TRIGGER IF EXISTS trg_drafts_send_needs_a_person_ins;
DROP INDEX IF EXISTS idx_drafts_delivery;
ALTER TABLE message_drafts DROP COLUMN outbox_id;
ALTER TABLE message_drafts DROP COLUMN delivery_error;
ALTER TABLE message_drafts DROP COLUMN delivered_at;
ALTER TABLE message_drafts DROP COLUMN requested_at;
ALTER TABLE message_drafts DROP COLUMN requested_by;
ALTER TABLE message_drafts DROP COLUMN delivery_state;
