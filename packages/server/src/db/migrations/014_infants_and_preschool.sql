-- ===========================================================================
-- 014_infants_and_preschool - two corrections from the centre itself.
--
-- Migration 013 read the capacity poster faithfully and still got two things
-- wrong, because the poster describes LICENSED RANGES and the nursery runs
-- ROOMS. Where the two do not line up, the rooms win: they are where the
-- children actually are.
--
-- 1. UNDER TWELVE MONTHS. The poster's youngest line starts at 12 months, so
--    anyone younger had "no room for this age" — and two real children, both
--    born in September 2025, were sitting in Purple Twinkle Stars the whole
--    time. The centre is allowed three under-12-month places, and they are in
--    the Twinkle rooms. So Twinkle Stars starts at 0 and is licensed for 31:
--    the poster's 28 infant places plus those 3.
--
-- 2. FOUR TO FIVE YEARS. The poster lists Pre-school 3-4 and Pre-school 4-5
--    separately, so 013 created a "Pre-school (4-5)" program with no room and
--    eighteen children with nowhere to go. They were never homeless: 4-5s are
--    in the Nova Stars rooms alongside the 3-4s. One program, 3-5 years,
--    licensed for both ranges together — 46 + 54 = 100.
--
--    That program is removed here rather than left as an empty rung, because a
--    rung nobody stands on still shows up as a suggestion nobody can act on.
--
-- 3. KINDERGARTEN AND OUT-OF-SCHOOL CARE. The poster gives these ONE line —
--    "5-6 years (Kindergarten) & Grades 1-6 (OSC)", 74 places — and the roll
--    shows why: six children aged six to nine are in Galaxy Stars Map, the
--    same room as the five-year-olds. Splitting them into two rungs made every
--    one of those six look misplaced and offered them a Cosmic Stars room that
--    does not exist. So Galaxy Stars covers 5 years to Grade 6, and Cosmic
--    Stars comes off the ladder — it stays a real program the website offers,
--    like Learning Adventures, just not a rung anybody is moved between.
--
-- Licensed places after this: 31 + 76 + 100 + 74 = 281. The poster's 278, plus
-- the three infant places it does not list.
-- ===========================================================================

-- +up

-- Infants below twelve months are in the Twinkle rooms, three of them allowed.
UPDATE programs
   SET min_months = 0, max_months = 19, capacity = 31,
       age_label = 'Under 12 months to 19 months'
 WHERE slug = 'twinkle-stars';

-- Nova Stars takes both pre-school ranges, which is where the 4-5s already are.
UPDATE programs
   SET min_months = 36, max_months = 60, capacity = 100,
       age_label = '3-5 years'
 WHERE slug = 'nova-stars';

-- Anybody parked on the empty rung goes back to Nova Stars, which is the room
-- they were physically in all along.
UPDATE children
   SET program_id = (SELECT id FROM programs WHERE slug = 'nova-stars')
 WHERE program_id = (SELECT id FROM programs WHERE slug = 'preschool-4-5');

UPDATE classrooms
   SET program_id = (SELECT id FROM programs WHERE slug = 'nova-stars')
 WHERE program_id = (SELECT id FROM programs WHERE slug = 'preschool-4-5');

DELETE FROM programs WHERE slug = 'preschool-4-5';

-- One room, one licensed range, from five years old to the end of Grade 6.
UPDATE programs
   SET min_months = 60, max_months = 144, capacity = 74,
       age_label = '5-6 years, and Grades 1-6 out of school care'
 WHERE slug = 'galaxy-stars';

-- Still offered, still on the website, but not a rung on the ladder: the
-- children it would describe are already in the Galaxy Stars room.
UPDATE programs SET age_ladder = 0 WHERE slug = 'cosmic-stars';

-- +down

INSERT INTO programs (id, slug, name, age_label, capacity, active, sort_order, created_at,
                      min_months, max_months, age_ladder)
SELECT lower(hex(randomblob(4))) || '-preschool-4-5', 'preschool-4-5',
       'Pre-school (4-5)', '4-5 years', 54, 1, 35, datetime('now'), 48, 60, 1
 WHERE NOT EXISTS (SELECT 1 FROM programs WHERE slug = 'preschool-4-5');

UPDATE programs SET min_months = 12, max_months = 19, capacity = 28,
       age_label = '12-19 months' WHERE slug = 'twinkle-stars';
UPDATE programs SET min_months = 36, max_months = 48, capacity = 46,
       age_label = '3-4 years' WHERE slug = 'nova-stars';
UPDATE programs SET min_months = 60, max_months = 72, capacity = 74,
       age_label = '5-6 years' WHERE slug = 'galaxy-stars';
UPDATE programs SET age_ladder = 1 WHERE slug = 'cosmic-stars';
