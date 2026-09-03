-- ===========================================================================
-- 013_real_age_ranges - the centre's actual licensed ranges and capacities.
--
-- Migration 011 guessed the age bounds from the program names on the website
-- (12-18, 18-36, 36-60, 60-72, 72-144). The centre's own capacity poster says
-- something different, and it is the licence, so it wins:
--
--   Infant                12-19 months            capacity 28
--   Toddler               19-36 months            capacity 76
--   Pre-school (3-4)      3-4 years               capacity 46
--   Pre-school (4-5)      4-5 years               capacity 54
--   Kindergarten & OSC    5-6 years, grades 1-6   capacity 74
--                                                 --------------
--                                                 total    278
--
-- The boundary that mattered most was 18 versus 19 months, which is a whole
-- month of children in or out of the infant room, and 3-5 versus 3-4, which
-- turns out to hide a gap.
--
-- Room names map onto these by their program, confirmed against the real roll:
--   Blue/Purple Twinkle Stars  -> Infant
--   Yellow/Purple/Green Comet  -> Toddler
--   Blue/Purple/Green Nova     -> Pre-school (3-4)
--   Galaxy Stars Map           -> Kindergarten age
--
-- THE GAP, recorded rather than papered over: nothing in the enrolment export
-- serves 4-5 years, and eighteen children are currently that age. The licence
-- has 54 places for them. So the program is created here with its real capacity
-- and NO room, and Ages & Rooms will say "Pre-school (4-5) fits, but it has no
-- open room yet" for each of those children. That is the truth, and it is the
-- question somebody at the centre has to answer: which room takes the 4s?
--
-- Room capacities stay null. The poster gives capacity per licensed RANGE, not
-- per room, and splitting 76 toddler places across three rooms by guesswork
-- would be a number nobody entered. The progression view falls back to the
-- program's capacity when a room has none, which is the figure that actually
-- exists.
-- ===========================================================================

-- +up

UPDATE programs SET min_months = 12, max_months = 19,  capacity = 28,  age_ladder = 1 WHERE slug = 'twinkle-stars';
UPDATE programs SET min_months = 19, max_months = 36,  capacity = 76,  age_ladder = 1 WHERE slug = 'comet-stars';
UPDATE programs SET min_months = 36, max_months = 48,  capacity = 46,  age_ladder = 1 WHERE slug = 'nova-stars';
UPDATE programs SET min_months = 60, max_months = 72,  capacity = 74,  age_ladder = 1 WHERE slug = 'galaxy-stars';

-- Grades 1-6. The poster counts these places together with Kindergarten age,
-- so the 74 above covers both and this one is deliberately left unmeasured
-- rather than invented by splitting a number in half.
UPDATE programs SET min_months = 72, max_months = 144, capacity = NULL, age_ladder = 1 WHERE slug = 'cosmic-stars';

UPDATE programs SET age_label = '12-19 months'   WHERE slug = 'twinkle-stars';
UPDATE programs SET age_label = '19-36 months'   WHERE slug = 'comet-stars';
UPDATE programs SET age_label = '3-4 years'      WHERE slug = 'nova-stars';
UPDATE programs SET age_label = '5-6 years'      WHERE slug = 'galaxy-stars';
UPDATE programs SET age_label = 'Grades 1-6 (out of school care)' WHERE slug = 'cosmic-stars';

-- The missing rung. Real capacity from the licence, no room yet.
INSERT INTO programs (id, slug, name, age_label, capacity, active, sort_order, created_at,
                      min_months, max_months, age_ladder)
SELECT lower(hex(randomblob(4))) || '-preschool-4-5', 'preschool-4-5',
       'Pre-school (4-5)', '4-5 years', 54, 1, 35, datetime('now'),
       48, 60, 1
 WHERE NOT EXISTS (SELECT 1 FROM programs WHERE slug = 'preschool-4-5');

-- +down

DELETE FROM programs WHERE slug = 'preschool-4-5';

UPDATE programs SET min_months = 12, max_months = 18,  capacity = NULL WHERE slug = 'twinkle-stars';
UPDATE programs SET min_months = 18, max_months = 36,  capacity = NULL WHERE slug = 'comet-stars';
UPDATE programs SET min_months = 36, max_months = 60,  capacity = NULL WHERE slug = 'nova-stars';
UPDATE programs SET min_months = 60, max_months = 72,  capacity = NULL WHERE slug = 'galaxy-stars';
UPDATE programs SET min_months = 72, max_months = 144, capacity = NULL WHERE slug = 'cosmic-stars';
