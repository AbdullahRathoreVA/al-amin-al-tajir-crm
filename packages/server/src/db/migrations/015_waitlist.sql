-- ===========================================================================
-- 015_waitlist - offering a place, and never going silent.
--
-- The table has existed since the beginning and holds a status, a program and
-- an added_at. What it could not do is the part a nursery actually needs: make
-- an offer, put a deadline on it, and prove nobody has been forgotten.
--
-- The research on childcare waitlists is unanimous about the failure mode, and
-- it is not losing the list. It is going quiet: a family joins, hears nothing
-- for four months, and has enrolled elsewhere by the time somebody calls. So
-- the columns here are mostly about CONTACT, not about ordering.
--
-- What is deliberately NOT stored:
--
--   * Position. It is computed from added_at within a program every time it is
--     asked for. A stored position is wrong the moment anybody is removed from
--     the middle of the list, and a number that is quietly wrong is worse than
--     no number.
--
--   * Estimated wait. The CRM cannot know when a place will free up, and an
--     estimate shown to staff becomes a promise made to a parent. "Fourth in
--     line, two places free" is a fact. "About four months" is a guess wearing
--     a fact's clothes.
--
--   * Sibling priority. Whether a sibling jumps the queue is the centre's
--     policy and not a database's opinion. Whether a family HAS a child
--     already enrolled is a fact the CRM can work out, so it is shown, and the
--     person deciding can see they are making the decision.
--
-- Alberta permits waitlist fees (British Columbia banned them in 2024; Alberta
-- did not follow). `fee_paid_at` records that one was taken, because a refund
-- on enrolment is a promise somebody has to keep. No amount, and no payment
-- handling: this system does not touch money.
-- ===========================================================================

-- +up

-- When an offer was made, by whom, and by when the family must answer.
ALTER TABLE waitlist ADD COLUMN offered_at      TEXT;
ALTER TABLE waitlist ADD COLUMN offer_expires_at TEXT;
ALTER TABLE waitlist ADD COLUMN offered_by      TEXT REFERENCES users(id) ON DELETE SET NULL;

-- The answer, and why. A decline with no reason teaches nothing.
ALTER TABLE waitlist ADD COLUMN responded_at    TEXT;
ALTER TABLE waitlist ADD COLUMN outcome_reason  TEXT;

-- The anti-silence columns. `last_contacted_at` is set by any deliberate
-- contact; the sweep uses it to raise a check-in task rather than trusting
-- anybody to remember.
ALTER TABLE waitlist ADD COLUMN last_contacted_at TEXT;
ALTER TABLE waitlist ADD COLUMN confirmed_at      TEXT;

-- Full-time families are commonly offered first. Recorded so the decision is
-- visible, never applied on its own.
ALTER TABLE waitlist ADD COLUMN care_type       TEXT
  CHECK (care_type IS NULL OR care_type IN ('full-time', 'part-time'));

-- A fee was taken. Refundable on enrolment is the usual arrangement here, and
-- that is a promise, so it is on the record.
ALTER TABLE waitlist ADD COLUMN fee_paid_at     TEXT;

-- Ordering reads added_at within a program constantly, and the staleness sweep
-- reads last_contacted_at across the whole list.
CREATE INDEX idx_waitlist_order   ON waitlist(program_id, status, added_at);
CREATE INDEX idx_waitlist_contact ON waitlist(status, last_contacted_at);

-- An offer without a deadline is how a place sits reserved for a family that
-- has already gone somewhere else. Either both are set or neither is.
CREATE TRIGGER waitlist_offer_needs_deadline
BEFORE UPDATE ON waitlist
FOR EACH ROW
WHEN (NEW.offered_at IS NULL) <> (NEW.offer_expires_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'An offer needs both the date it was made and the date it runs out');
END;

-- +down

DROP TRIGGER IF EXISTS waitlist_offer_needs_deadline;
DROP INDEX IF EXISTS idx_waitlist_contact;
DROP INDEX IF EXISTS idx_waitlist_order;
ALTER TABLE waitlist DROP COLUMN fee_paid_at;
ALTER TABLE waitlist DROP COLUMN care_type;
ALTER TABLE waitlist DROP COLUMN confirmed_at;
ALTER TABLE waitlist DROP COLUMN last_contacted_at;
ALTER TABLE waitlist DROP COLUMN outcome_reason;
ALTER TABLE waitlist DROP COLUMN responded_at;
ALTER TABLE waitlist DROP COLUMN offered_by;
ALTER TABLE waitlist DROP COLUMN offer_expires_at;
ALTER TABLE waitlist DROP COLUMN offered_at;
