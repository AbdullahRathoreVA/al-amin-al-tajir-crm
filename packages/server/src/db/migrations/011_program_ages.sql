-- ===========================================================================
-- 011_program_ages - so a room knows which ages it is for.
--
-- `programs.age_label` is text for a human: "18 months - 3 years". Nothing can
-- be computed from it, so nothing in the CRM could answer the question a
-- nursery asks every single month - "who has outgrown their room?" - and the
-- answer was left to somebody remembering a birthday.
--
-- So each program gets bounds in months. `min_months` is inclusive and
-- `max_months` is exclusive, which is the only pair that tiles without gaps or
-- overlaps: a child of exactly 18 months belongs to the room that starts at 18,
-- not to the one that ends there.
--
-- Both are nullable, and null means "not set" rather than "no limit". A program
-- without bounds is simply left out of the progression view instead of being
-- guessed at - the same rule the ratio engine already follows when it reports
-- "not measured".
--
-- `age_ladder` is what stops Learning Adventures, which spans ages 2 to 5 and
-- deliberately overlaps three other rooms, from making every toddler look like
-- they are in the wrong place. It carries real bounds, it is just not a rung.
--
-- Bounds are seeded for the programs whose labels are unambiguous. Anything the
-- label does not clearly state is left null for a person to fill in.
-- ===========================================================================

-- +up

ALTER TABLE programs ADD COLUMN min_months INTEGER;
ALTER TABLE programs ADD COLUMN max_months INTEGER;

-- 1 = part of the normal progression from one room to the next.
ALTER TABLE programs ADD COLUMN age_ladder INTEGER NOT NULL DEFAULT 1;

-- Tiny Stars has no infant room, so nothing here covers under 12 months. That
-- is the centre's shape, not an omission: a child younger than the youngest
-- room has no rung to be on, and the progression view says so rather than
-- inventing one.
UPDATE programs SET min_months = 12, max_months = 18  WHERE slug = 'twinkle-stars';
UPDATE programs SET min_months = 18, max_months = 36  WHERE slug = 'comet-stars';
UPDATE programs SET min_months = 36, max_months = 60  WHERE slug = 'nova-stars';
UPDATE programs SET min_months = 60, max_months = 72  WHERE slug = 'galaxy-stars';
UPDATE programs SET min_months = 72, max_months = 144 WHERE slug = 'cosmic-stars';

-- Spans ages 2-5 on purpose and overlaps three rooms above. Real bounds, but
-- not a rung on the ladder.
UPDATE programs SET min_months = 24, max_months = 60, age_ladder = 0
 WHERE slug = 'learning-adventures';

-- +down

ALTER TABLE programs DROP COLUMN age_ladder;
ALTER TABLE programs DROP COLUMN max_months;
ALTER TABLE programs DROP COLUMN min_months;
