/**
 * The registration path, end to end, against a real SQLite database in a temp
 * directory. No mocks: the thing under test is the interaction between
 * validation, matching, transactions and the event store, and a mock would
 * simply agree with whatever I assumed.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHmac } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'crm-test-'));
process.env.CRM_DATA_DIR = TMP;
process.env.CRM_MODE = 'demo';
process.env.CRM_SESSION_SECRET = 'test-secret-not-a-real-one';
process.env.CRM_INGEST_SECRET = 'test-ingest-secret';

// Imported after the env is set, because config reads it at module load.
const { connect, close, one, many } = await import('../packages/server/src/db/index.ts');
const { migrateUp } = await import('../packages/server/src/db/migrate.ts');
const { seedReference } = await import('../packages/server/src/seed/demo.ts');
const { ingest } = await import('../packages/server/src/ingest/pipeline.ts');
const { validateEnvelope, validateRegistration } = await import('../packages/shared/src/contract.ts');
const { reindexAll, search, searchIndexNeedsRebuild, familyForRelated } =
  await import('../packages/server/src/core/search.ts');
const { hashPassword, verifyPassword, can, createUser, login, userForToken } =
  await import('../packages/server/src/core/auth.ts');
const { verifySignature } = await import('../packages/server/src/http.ts');
const { attention, dataHealth } = await import('../packages/server/src/core/queries.ts');
const { checkLoginAllowed, recordLoginFailure, recordLoginSuccess, resetLoginLimits } =
  await import('../packages/server/src/core/ratelimit.ts');
const { assessRegistration } = await import('../packages/server/src/core/completeness.ts');
const { seedTemplates, composeDraft, suggestTemplate, saveDraft } =
  await import('../packages/server/src/core/drafts.ts');
const { parseCsv, guessMapping, preview: previewImport, commitImport } =
  await import('../packages/server/src/core/csv.ts');
const { splitName } = await import('../packages/server/src/core/util.ts');
const { buildWorkbook } = await import('../packages/server/src/core/xlsx.ts');
const { readXlsx, readSheet, looksLikeXlsx, fromExcelSerial } =
  await import('../packages/server/src/core/xlsx-read.ts');
const { parseTabular } = await import('../packages/server/src/core/csv.ts');
const { refreshAgeBands, outgrown, upcomingBirthdays, progressionSummary, placementPlan } =
  await import('../packages/server/src/core/progression.ts');
const { familiesWorkbook, admissionsWorkbook, deFormula, exportCounts } =
  await import('../packages/server/src/core/exports.ts');
const { HELP, HELP_SECTIONS, searchHelp, topicsAsContext } =
  await import('../packages/server/src/core/help.ts');
const { changeOwnPassword, resetPasswordFor, setUserStatus, ROLE_NAMES,
        createUser: createUserAuth } = await import('../packages/server/src/core/auth.ts');
const { addChild, addGuardian, updateChild, updateGuardian, insertFamily,
        ageBandFor, ageLabel, monthsBetween } =
  await import('../packages/server/src/core/people.ts');
const { createBackup, listBackups, testRestore, pruneBackups } =
  await import('../packages/server/src/core/backup.ts');
const { seedAutomations, listAutomations, runAutomation, runsFor, disableAll } =
  await import('../packages/server/src/core/automations.ts');
const { factsForFamily, ruleSummary, summariseFamily, dailyBrief, aiStatus } =
  await import('../packages/server/src/core/ai.ts');
const { visibleClassroomIds, register, mark, checkOut, assignStaff, unassignStaff,
        roomStandings, createClassroom, updateClassroom, assignChild, unplacedChildren,
        setRatio, clearRatio, assignableStaff } = await import('../packages/server/src/core/attendance.ts');
const { timelineFor } = await import('../packages/server/src/core/events.ts');
const { registerTransport, upsertTarget, targetFor, queue, due, suppressed, runChannel,
        recentRuns: syncRuns, channelStatus, backoffMs, MAX_ATTEMPTS, mappingFor, toRow,
        pluck } = await import('../packages/server/src/core/sync.ts');
const { sheetsTransport } = await import('../packages/server/src/core/transports/sheets.ts');
const { emailTransport } = await import('../packages/server/src/core/transports/email.ts');
const { requestSend, reconcileDeliveries } = await import('../packages/server/src/core/drafts.ts');
const { familyTimeline } = await import('../packages/server/src/core/events.ts');
const actorFor = (u: { id: string }) => ({ type: 'user' as const, id: u.id, source: 'manual' });
const { parseMoney, parseDay, parseVendor, parseCategory, parseUtterance, gapsIn,
        record: logRecord, update: logUpdate, recall: logRecall, totals: logTotals,
        workbook: logWorkbook, list: logList, remove: logRemove, restore: logRestore,
        removed: logRemoved, splitUtterance } = await import('../packages/server/src/core/logbook.ts');

before(async () => {
  await connect();
  migrateUp();
  seedReference();
});
after(() => { close(); rmSync(TMP, { recursive: true, force: true }); });

const envelope = (type: string, data: unknown, eventId: string = randomUUID()) => ({
  eventId, type, version: 1, occurredAt: new Date().toISOString(), source: 'website', data,
});

const registration = (over: Record<string, unknown> = {}) => ({
  guardian: { fullName: 'Dana Whitfield', email: 'dana@example.invalid', phone: '416-555-0101', relationship: 'Parent' },
  child: { firstName: 'Rosa', ageBand: '3-5 years' },
  programInterest: 'Nova Stars',
  completedSteps: 5, totalSteps: 5,
  ...over,
});

const countRows = (sql: string, ...p: string[]) => Number(one<{ n: number }>(sql, ...p)?.n ?? 0);
const execSql = (sql: string, ...p: string[]) => { one(sql, ...p); };

/**
 * ingest() returns a union now that analytics shares the entry point. Every
 * family-shaped test wants the family branch, so narrow once here and fail
 * loudly rather than letting `undefined` masquerade as a passing assertion.
 */
type FamilyIngest = Extract<ReturnType<typeof ingest>, { createdFamily: boolean }>;
function asFamily(r: ReturnType<typeof ingest>): FamilyIngest {
  assert.ok('createdFamily' in r, `expected a family result, got ${JSON.stringify(r)}`);
  return r as FamilyIngest;
}

// ---------------------------------------------------------------- validation

describe('contract validation', () => {
  test('accepts a well-formed registration', () => {
    const r = validateRegistration(registration());
    assert.equal(r.ok, true);
  });

  test('rejects a guardian with no way to contact them', () => {
    const r = validateRegistration(registration({ guardian: { fullName: 'No Contact' } }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors.map((e) => e.message).join(' '), /email address or a phone number/);
  });

  test('rejects a malformed email rather than storing it', () => {
    const r = validateRegistration(registration({
      guardian: { fullName: 'Bad Email', email: 'not-an-email', phone: '416-555-0102' },
    }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.path === 'guardian.email'));
  });

  test('strips control characters from free text', () => {
    const dirty = 'Hello' + String.fromCharCode(0) + String.fromCharCode(7) + 'World';
    const r = validateRegistration(registration({ notes: dirty }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.notes, 'HelloWorld');
  });

  test('keeps the line breaks a parent typed in free text', () => {
    // Regression: the control-character stripper used to eat \n along with
    // everything else, silently flattening a multi-paragraph message into one
    // run-on blob. Only caught by reading a real submission back out.
    const typed = 'We visited last week.\n\nDoes the settling-in day come first?';
    const r = validateRegistration(registration({ notes: typed }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.notes, typed, 'paragraph breaks must survive');
  });

  test('normalises CRLF and caps runaway blank lines', () => {
    const r = validateRegistration(registration({ notes: 'One\r\n\r\n\r\n\r\nTwo' }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.notes, 'One\n\nTwo');
  });

  test('a name still cannot contain a newline', () => {
    const r = validateRegistration(registration({
      guardian: { fullName: 'Real Name\nInjected Line', email: 'x@example.invalid' },
    }));
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.value.guardian.fullName, 'Real NameInjected Line',
      'single-line fields must not keep breaks');
  });

  test('rejects an envelope from a newer contract version', () => {
    const r = validateEnvelope({ ...envelope('registration.created', registration()), version: 99 });
    assert.equal(r.ok, false);
  });

  test('rejects a non-UUID eventId, because it is the idempotency key', () => {
    const r = validateEnvelope(envelope('registration.created', registration(), 'not-a-uuid'));
    assert.equal(r.ok, false);
  });

  test('declares voice events but refuses to process them', () => {
    const r = validateEnvelope(envelope('call.received', {}));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0]!.message, /not implemented yet/);
  });
});

// --------------------------------------------------------------- idempotency

describe('registration ingestion', () => {
  test('creates family, child, lead and registration from one event', () => {
    const env = validateEnvelope(envelope('registration.created', registration()));
    assert.equal(env.ok, true);
    if (!env.ok) return;

    const r = asFamily(ingest(env.value));
    assert.equal(r.status, 'processed');
    assert.equal(r.createdFamily, true);
    assert.ok(r.familyId && r.childId && r.leadId && r.registrationId);

    const fam = one<{ name: string; status: string; source: string }>(
      'SELECT name, status, source FROM families WHERE id = ?', r.familyId);
    assert.equal(fam?.name, 'Whitfield family');
    assert.equal(fam?.status, 'applying');
    assert.equal(fam?.source, 'website');

    const child = one<{ first_name: string }>('SELECT first_name FROM children WHERE id = ?', r.childId!);
    assert.equal(child?.first_name, 'Rosa');

    const reg = one<{ status: string }>('SELECT status FROM registrations WHERE id = ?', r.registrationId!);
    assert.equal(reg?.status, 'submitted');
  });

  test('SPEC 330: the same eventId twice produces no duplicate', () => {
    const eventId = randomUUID();
    const data = registration({
      guardian: { fullName: 'Marcus Reid', email: 'marcus@example.invalid', phone: '416-555-0199' },
      child: { firstName: 'Ivy', ageBand: '3-5 years' },
    });
    const env = validateEnvelope(envelope('registration.created', data, eventId));
    assert.equal(env.ok, true);
    if (!env.ok) return;

    const before = countRows('SELECT COUNT(*) n FROM families');
    const first = asFamily(ingest(env.value));
    const afterFirst = countRows('SELECT COUNT(*) n FROM families');

    const second = asFamily(ingest(env.value));
    const afterSecond = countRows('SELECT COUNT(*) n FROM families');

    assert.equal(first.status, 'processed');
    assert.equal(second.status, 'duplicate', 'a replayed event must report as duplicate');
    assert.equal(afterFirst, before + 1, 'the first send creates exactly one family');
    assert.equal(afterSecond, afterFirst, 'the replay must create nothing');
    assert.equal(second.familyId, first.familyId, 'the replay returns the original ids');
    assert.equal(second.registrationId, first.registrationId);

    assert.equal(countRows('SELECT COUNT(*) n FROM registrations WHERE family_id = ?', first.familyId), 1);
    assert.equal(countRows('SELECT COUNT(*) n FROM children WHERE family_id = ?', first.familyId), 1);
  });

  test('a different event from the same email joins the existing family', () => {
    const email = `shared-${randomUUID().slice(0, 8)}@example.invalid`;
    const first = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Nadia Cole', email, phone: '416-555-0123' },
      child: { firstName: 'Otto', ageBand: '3-5 years' },
    })));
    assert.equal(first.ok, true); if (!first.ok) return;
    const a = asFamily(ingest(first.value));

    // Same guardian email, a second child. This is a sibling, not a duplicate.
    const second = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Nadia Cole', email, phone: '416-555-0123' },
      child: { firstName: 'Petra', ageBand: 'Under 12 months' },
    })));
    assert.equal(second.ok, true); if (!second.ok) return;
    const b = asFamily(ingest(second.value));

    assert.equal(b.createdFamily, false, 'an exact email match must link, not create');
    assert.equal(b.familyId, a.familyId);
    assert.equal(countRows('SELECT COUNT(*) n FROM children WHERE family_id = ?', a.familyId), 2,
      'both siblings are recorded under one family');
    assert.equal(countRows('SELECT COUNT(*) n FROM guardians WHERE family_id = ?', a.familyId), 1,
      'the guardian is not duplicated');
  });

  test('a surname-only match creates a separate family and flags it for review', () => {
    const one1 = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Tobias Lindqvist', email: 'tobias@example.invalid', phone: '416-555-0301' },
      child: { firstName: 'Elin', ageBand: '3-5 years' },
    })));
    assert.equal(one1.ok, true); if (!one1.ok) return;
    const a = asFamily(ingest(one1.value));

    // Same surname, different email AND different phone: not enough to merge.
    const two = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Annika Lindqvist', email: 'annika@example.invalid', phone: '416-555-0302' },
      child: { firstName: 'Nils', ageBand: '5-6 years' },
    })));
    assert.equal(two.ok, true); if (!two.ok) return;
    const b = asFamily(ingest(two.value));

    assert.equal(b.createdFamily, true, 'a weak match must never auto-merge');
    assert.notEqual(b.familyId, a.familyId);
    assert.ok(b.needsReview, 'the near-match must be surfaced for a human');
    assert.ok(b.needsReview!.candidates[0]!.reasons.some((r) => /surname/.test(r)),
      'the reason shown to staff must name the actual signal');

    assert.equal(
      countRows(`SELECT COUNT(*) n FROM tasks WHERE related_id = ? AND title LIKE 'Possible duplicate%'`, b.familyId),
      1, 'a review task is created');
  });

  test('an unfinished registration is stored as incomplete with a follow-up', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Priya Anand', email: 'priya.a@example.invalid', phone: '416-555-0404' },
      child: { firstName: 'Kiran', ageBand: '12-18 months' },
      completedSteps: 2, totalSteps: 5,
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    const reg = one<{ status: string }>('SELECT status FROM registrations WHERE id = ?', r.registrationId!);
    assert.equal(reg?.status, 'incomplete');

    const lead = one<{ next_action: string; next_action_reason: string }>(
      'SELECT next_action, next_action_reason FROM leads WHERE id = ?', r.leadId!);
    assert.ok(lead?.next_action, 'an incomplete registration must leave a next action');
    assert.match(lead!.next_action_reason, /step 2 of 5/);
  });

  test('every ingested change is recorded in the append-only event log', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Ola Berg', email: 'ola@example.invalid', phone: '416-555-0505' },
      child: { firstName: 'Sven', ageBand: '5-6 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    const events = many<{ summary: string }>(
      'SELECT summary FROM events WHERE entity_id = ? OR entity_id = ?', r.familyId, r.registrationId!);
    assert.ok(events.length >= 2, 'family creation and registration are both logged');
    assert.ok(events.some((e) => /Sven/.test(e.summary)), 'the summary names the child, for a human reader');
  });

  test('the event log physically rejects updates and deletes', () => {
    assert.throws(() => one('UPDATE events SET summary = ? WHERE seq = 1', 'tampered'), /append-only/);
    assert.throws(() => one('DELETE FROM events WHERE seq = 1'), /append-only/);
  });
});

// ------------------------------------------------------------- tour requests

describe('tour requests', () => {
  test('a tour request is recorded as requested, never as booked', () => {
    const env = validateEnvelope(envelope('tour.requested', {
      guardian: { fullName: 'Iris Kaplan', email: 'iris@example.invalid', phone: '416-555-0606' },
      child: { firstName: 'Milo', ageBand: '3-5 years' },
      preferredDates: ['2026-09-14', '2026-09-15'],
    }));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    const tour = one<{ status: string; notes: string }>('SELECT status, notes FROM tours WHERE id = ?', r.tourId!);
    assert.equal(tour?.status, 'requested', 'a parent preference is not a confirmed booking');
    assert.match(tour!.notes, /preferred dates/i, 'the preference is preserved for staff');

    assert.equal(
      countRows(`SELECT COUNT(*) n FROM tasks WHERE related_id = ? AND status = 'open'`, r.tourId!), 1,
      'a tour request creates the task to confirm a time');
  });
});

// -------------------------------------------------------------------- search

describe('search', () => {
  test('finds a family by guardian surname', () => {
    reindexAll();
    const hits = search('Whitfield');
    assert.ok(hits.length > 0);
    assert.ok(hits.some((h) => h.entity_type === 'family'));
  });

  test('matches on a prefix, so partial typing works', () => {
    reindexAll();
    assert.ok(search('Whitf').length > 0);
  });

  test('FTS operators in user input are neutralised, not executed', () => {
    // The danger is a crafted query throwing (500 to the user) or being parsed
    // as an FTS expression. Both are prevented by quoting every term, which
    // turns operators into ordinary words - so a hit here is correct, not a bug.
    assert.doesNotThrow(() => search('AND OR ") NEAR('));
    assert.doesNotThrow(() => search('"""""'));
    assert.doesNotThrow(() => search('* * *'));

    // Pure punctuation has no searchable term left, so there is nothing to find.
    assert.deepEqual(search('*()"'), []);
    assert.deepEqual(search('!!'), []);

    // "NEAR" is matched as the literal word, not as the FTS NEAR operator: a
    // real operator would have thrown on this malformed usage.
    assert.doesNotThrow(() => search('NEAR(Whitfield Lindqvist'));
  });

  // The point of these: a child's first name is the most natural thing anyone
  // types, and until the index carried an owning family it was the one search
  // whose result could not be opened.
  test("a child's name resolves to the family that child is in", () => {
    reindexAll();
    const family = one<{ id: string }>("SELECT id FROM families WHERE name LIKE '%Whitfield%'");
    assert.ok(family, 'expected the Whitfield family from the ingestion tests');

    const hit = search('Rosa').find((h) => h.entity_type === 'child');
    assert.ok(hit, 'expected a child hit for Rosa');
    assert.equal(hit.family_id, family.id);
  });

  test('a guardian hit carries their family too', () => {
    reindexAll();
    const family = one<{ id: string }>("SELECT id FROM families WHERE name LIKE '%Whitfield%'");
    const hit = search('Dana').find((h) => h.entity_type === 'guardian');
    assert.ok(hit, 'expected a guardian hit for Dana');
    assert.equal(hit.family_id, family!.id);
  });

  test('nothing that belongs to a family is indexed without it', () => {
    reindexAll();
    // A task may legitimately be about nothing. Everything else having a null
    // family is the bug this guards against, and it is invisible in the UI
    // until someone searches and lands on an unfiltered list.
    const orphans = many<{ entity_type: string; entity_id: string; family_id: string | null }>(
      `SELECT entity_type, entity_id, family_id FROM search_index
        WHERE family_id IS NULL AND entity_type NOT IN ('task', 'note')`);
    assert.deepEqual(orphans, [], `these would open nowhere: ${JSON.stringify(orphans)}`);
  });

  test('a polymorphic reference to something unknown resolves to null, not a guess', () => {
    assert.equal(familyForRelated('spaceship', 'anything'), null);
    assert.equal(familyForRelated(null, null), null);
    assert.equal(familyForRelated('child', 'no-such-child'), null);
  });

  test('an emptied index is detected and rebuilt rather than looking like no data', () => {
    execSql('DELETE FROM search_index');
    assert.equal(searchIndexNeedsRebuild(), true);
    assert.deepEqual(search('Whitfield'), [], 'precondition: the index really is empty');

    assert.ok(reindexAll() > 0);
    assert.equal(searchIndexNeedsRebuild(), false);
    assert.ok(search('Whitfield').length > 0);
  });
});


// ------------------------------------------------------------ completeness

describe('registration completeness', () => {
  test('a website registration is incomplete, and says exactly why', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Selma Bright', email: 'selma@example.invalid', phone: '416-555-0808' },
      child: { firstName: 'Otis', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    const c = assessRegistration(r.registrationId!);
    assert.ok(c, 'the registration should be assessable');
    assert.equal(c!.status, 'incomplete');
    assert.ok(c!.requiredMissing > 0);

    const fields = c!.gaps.map((g) => g.field);
    // A website form deliberately does not ask for these, so a submitted
    // registration is always incomplete until a person fills the rest in.
    assert.ok(fields.includes('child.date_of_birth'), 'DOB must be flagged');
    assert.ok(fields.includes('emergency_contact'), 'a second contact must be flagged');
    assert.ok(fields.includes('authorized_pickup'), 'pickup authorisation must be flagged');

    for (const g of c!.gaps) {
      assert.ok(g.why.length > 10, 'gap ' + g.field + ' must explain itself');
      assert.ok(g.where, 'gap ' + g.field + ' must say where to fix it');
    }
  });

  test('the score counts only required fields, so advice does not dilute it', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Ada Nkemelu', email: 'ada.n@example.invalid', phone: '416-555-0909' },
      child: { firstName: 'Chike', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));
    const c = assessRegistration(r.registrationId!)!;

    assert.ok(c.percent >= 0 && c.percent <= 100, 'percent out of range: ' + c.percent);
    const rec = c.gaps.filter((g) => g.severity === 'recommended').map((g) => g.field);
    assert.ok(rec.includes('child.last_name') || rec.includes('guardian.last_name'),
      'a missing surname is advice, not a blocker');
  });

  test('an unknown registration returns null rather than an empty assessment', () => {
    assert.equal(assessRegistration('does-not-exist'), null);
  });
});

// ----------------------------------------------------------------- drafts

describe('message drafts', () => {
  test('composes a message with the family details filled in', () => {
    seedTemplates();
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Marta Kovac', email: 'marta@example.invalid', phone: '416-555-0111' },
      child: { firstName: 'Zora', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    const draft = composeDraft(r.familyId, 'tpl_registration_received', 'Priya Raman');
    assert.equal(draft.blocked, false);
    assert.equal(draft.to, 'marta@example.invalid');
    assert.ok(draft.body.includes('Marta'), 'the guardian is addressed by name');
    assert.ok(draft.body.includes('Zora'), 'the child is named');
    assert.ok(draft.body.includes('Priya Raman'), 'it is signed by the person sending it');
    assert.ok(!draft.body.includes('{{'),
      'no placeholder may survive into a parent-facing message');
  });

  test('refuses to compose for a family nobody can be reached at', () => {
    const familyId = randomUUID();
    const now = new Date().toISOString();
    execSql(
      'INSERT INTO families (id, name, status, source, created_at, updated_at) ' +
      "VALUES (?, 'Unreachable family', 'prospective', 'manual', ?, ?)",
      familyId, now, now);

    const draft = composeDraft(familyId, 'tpl_no_response', 'Someone');
    assert.equal(draft.blocked, true, 'a family with no guardian must be blocked');
    assert.ok(draft.warnings.length > 0);
    assert.equal(draft.body, '', 'a blocked draft must not render a body');
  });

  test('an opted-out guardian blocks the draft, it does not merely warn', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Quiet Person', email: 'quiet@example.invalid', phone: '416-555-0222' },
      child: { firstName: 'Wren', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));
    execSql('UPDATE guardians SET opted_out = 1 WHERE family_id = ?', r.familyId);

    const draft = composeDraft(r.familyId, 'tpl_no_response', 'Someone');
    assert.equal(draft.blocked, true, 'consent is not a warning to click past');
    assert.ok(draft.warnings.join(' ').toLowerCase().includes('opted out'));
  });

  test('warns when a family has siblings, because the draft names only one', () => {
    const email = 'sibs-' + randomUUID().slice(0, 8) + '@example.invalid';
    for (const name of ['Elif', 'Deniz']) {
      const env = validateEnvelope(envelope('registration.created', registration({
        guardian: { fullName: 'Yusuf Demir', email, phone: '416-555-0333' },
        child: { firstName: name, ageBand: '3-5 years' },
      })));
      assert.equal(env.ok, true); if (!env.ok) return;
      ingest(env.value);
    }
    const fam = one<{ id: string }>(
      'SELECT family_id AS id FROM guardians WHERE email_norm = ?', email)!;
    const draft = composeDraft(fam.id, 'tpl_no_response', 'Someone');
    assert.equal(draft.blocked, false);
    assert.ok(draft.warnings.some((w) => /2 children/.test(w)),
      'expected a sibling warning, got: ' + JSON.stringify(draft.warnings));
  });

  test('suggests the template that matches what is actually happening', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Half Done', email: 'half@example.invalid', phone: '416-555-0444' },
      child: { firstName: 'Pip', ageBand: '3-5 years' },
      completedSteps: 2, totalSteps: 5,
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));
    assert.equal(suggestTemplate(r.familyId), 'tpl_registration_incomplete');
  });

  test('marking a draft sent counts as contact, so the nagging stops', () => {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Contacted Soon', email: 'soon@example.invalid', phone: '416-555-0555' },
      child: { firstName: 'Ines', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    const before = one<{ last_contact_at: string | null }>(
      'SELECT last_contact_at FROM leads WHERE id = ?', r.leadId!);
    assert.equal(before?.last_contact_at, null);

    const draft = composeDraft(r.familyId, 'tpl_registration_received', 'Priya Raman');
    saveDraft(r.familyId, draft, { type: 'user', id: null }, 'sent');

    const after = one<{ last_contact_at: string | null }>(
      'SELECT last_contact_at FROM leads WHERE id = ?', r.leadId!);
    assert.ok(after?.last_contact_at, 'sending must reset the follow-up clock');
  });
});


// -------------------------------------------------------------- csv import

describe('csv parsing', () => {
  test('handles what Excel actually produces', () => {
    // BOM, quoted commas, doubled quotes, an embedded newline, CRLF, a blank
    // line. Every one of these has silently corrupted somebody's import.
    const csv = '\uFEFFname,note,email\r\n'
      + '"Smith, Jane","She said ""soon""",jane@example.invalid\r\n'
      + '\r\n'
      + '"Two\nLines",plain,two@example.invalid\r\n';
    const p = parseCsv(csv);

    assert.deepEqual(p.headers, ['name', 'note', 'email'], 'the BOM must not stick to the first header');
    assert.equal(p.rows.length, 2, 'the blank line is skipped');
    assert.equal(p.rows[0]![0], 'Smith, Jane', 'a quoted comma is one field');
    assert.equal(p.rows[0]![1], 'She said "soon"', 'doubled quotes become one');
    assert.equal(p.rows[1]![0], 'Two\nLines', 'an embedded newline survives');
  });

  test('guesses columns from the header names spreadsheets really use', () => {
    const p = parseCsv('Parent Name,E-Mail,Mobile,Child\'s Name,DOB\nA,b@c.invalid,416-555-0100,Kid,2022-01-05\n');
    const m = guessMapping(p.headers);
    assert.equal(m.guardianName, 0);
    assert.equal(m.guardianEmail, 1);
    assert.equal(m.guardianPhone, 2);
    assert.equal(m.childFirstName, 3);
    assert.equal(m.childDob, 4);
  });

  test('never maps two fields to the same column', () => {
    const p = parseCsv('name,email\nA,b@c.invalid\n');
    const m = guessMapping(p.headers);
    const used = Object.values(m);
    assert.equal(new Set(used).size, used.length, 'each column is claimed once');
  });
});

describe('csv import', () => {
  const HEAD = 'Parent Name,Email,Phone,Child Name,DOB\n';

  test('previews without writing anything', () => {
    const before = countRows('SELECT COUNT(*) n FROM families');
    const csv = HEAD + 'Nadia Farouk,nadia.imp@example.invalid,416-555-0700,Amir,2021-03-14\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));

    assert.equal(view.totalRows, 1);
    assert.equal(view.willCreate, 1);
    assert.equal(view.willSkip, 0);
    assert.equal(countRows('SELECT COUNT(*) n FROM families'), before,
      'previewing must not write a single row');
  });

  test('a named child with no contact details is imported, with a warning', () => {
    // This used to be an error, and it cost 134 real children: Lillio's
    // enrolment export is a roster with no parents in it at all. A roll of
    // children who already attend is not an enquiry list, and refusing it
    // guards against a problem the centre does not have. The gap is surfaced
    // instead, and shows up in the data-quality view.
    const csv = HEAD + 'No Contact Person,,,Kid,\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));
    assert.equal(view.willSkip, 0);
    assert.equal(view.willCreate, 1);
    assert.ok(view.issues.some((i) => i.severity === 'warning' && /add a guardian/i.test(i.message)));
  });

  test('a row with neither a child nor a contact is still refused', () => {
    // Nothing to record at all. This is the case the old rule was really for.
    const csv = HEAD + 'Nobody Useful,,,,\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));
    assert.equal(view.willSkip, 1);
    assert.ok(view.issues.some((i) => i.severity === 'error'));
  });

  test('an ambiguous date is left blank rather than guessed', () => {
    // 03/04/2022 is March 4th to an American and April 3rd to a Canadian. A
    // wrong DOB puts a child in the wrong room and the wrong ratio.
    const csv = HEAD + 'Ambiguous Date,amb@example.invalid,416-555-0701,Kid,03/04/2022\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));
    assert.ok(view.issues.some((i) => /day\/month or month\/day/.test(i.message)),
      'the ambiguity must be surfaced, not resolved by coin flip');
  });

  test('an unambiguous date is read correctly', () => {
    const csv = HEAD + 'Clear Date,clear@example.invalid,416-555-0702,Kid,25/12/2021\n';
    const p = parseCsv(csv);
    const result = commitImport(p, guessMapping(p.headers), { type: 'user', id: null }, 'test.csv');
    assert.equal(result.created, 1);
    const child = one<{ date_of_birth: string }>(
      "SELECT date_of_birth FROM children WHERE first_name = 'Kid' AND date_of_birth IS NOT NULL ORDER BY created_at DESC LIMIT 1");
    assert.equal(child?.date_of_birth, '2021-12-25', '25 can only be a day');
  });

  test('imports, and a second run of the same file updates rather than duplicates', () => {
    const csv = HEAD + 'Rafael Duarte,rafael.imp@example.invalid,416-555-0703,Bruna,2020-06-01\n';
    const p = parseCsv(csv);
    const map = guessMapping(p.headers);

    const first = commitImport(p, map, { type: 'user', id: null }, 'families.csv');
    assert.equal(first.created, 1);
    const afterFirst = countRows('SELECT COUNT(*) n FROM families');

    const second = commitImport(parseCsv(csv), map, { type: 'user', id: null }, 'families.csv');
    assert.equal(second.created, 0, 'the same email must not create a second family');
    assert.equal(second.updated, 1);
    assert.equal(countRows('SELECT COUNT(*) n FROM families'), afterFirst);

    assert.equal(countRows(
      "SELECT COUNT(*) n FROM children WHERE first_name = 'Bruna'"), 1,
      'the child must not be duplicated either');
  });

  test('flags a duplicate inside the file itself', () => {
    const csv = HEAD
      + 'Same Person,dup.imp@example.invalid,416-555-0704,First,\n'
      + 'Same Person,dup.imp@example.invalid,416-555-0704,Second,\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));
    assert.ok(view.issues.some((i) => /Same contact as row 2/.test(i.message)),
      'a repeated contact within one file must be called out');
  });


  test('two rows sharing a contact become ONE family, as the preview promised', () => {
    // Regression. resolveRows only sees the database, so both rows looked new
    // and both created a family, while the preview said they would be merged.
    // The commit contradicting its own preview is worse than either behaviour.
    const email = 'batchdupe-' + randomUUID().slice(0, 8) + '@example.invalid';
    const csv = 'Parent Name,Email,Phone,Child Name,DOB\n'
      + 'Priya Sharma,' + email + ',780-555-0900,Arjun,2020-07-22\n'
      + 'Priya Sharma,' + email + ',780-555-0900,Meera,2023-01-09\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));
    assert.equal(view.willCreate, 1, 'the preview must promise one family');

    const result = commitImport(parseCsv(csv), guessMapping(p.headers),
      { type: 'user', id: null }, 'siblings.csv');
    assert.equal(result.created, 1, 'the commit must keep that promise');

    const fams = many<{ id: string }>(
      'SELECT DISTINCT family_id AS id FROM guardians WHERE email_norm = ?', email);
    assert.equal(fams.length, 1, 'exactly one family for one email');
    assert.equal(countRows('SELECT COUNT(*) n FROM children WHERE family_id = ?', fams[0]!.id), 2,
      'both children land under it as siblings');
  });

  test('reads "Last, First" the way spreadsheets actually export names', () => {
    // Regression: splitting on whitespace turned "Okafor, Ngozi" into
    // first="Okafor," last="Ngozi", filing the family under the given name.
    const csv = 'Parent Name,Email,Phone,Child Name,DOB\n'
      + '"Okafor, Ngozi",ngozi-' + randomUUID().slice(0, 6) + '@example.invalid,780-555-0901,Chidi,2021-03-14\n';
    const p = parseCsv(csv);
    commitImport(p, guessMapping(p.headers), { type: 'user', id: null }, 'lastfirst.csv');

    const fam = one<{ name: string }>(
      "SELECT name FROM families WHERE source = 'excel' ORDER BY created_at DESC LIMIT 1");
    assert.equal(fam?.name, 'Okafor family', 'the surname is the family name, not the given name');

    const g = one<{ first_name: string; last_name: string }>(
      "SELECT first_name, last_name FROM guardians ORDER BY created_at DESC LIMIT 1");
    assert.equal(g?.first_name, 'Ngozi');
    assert.equal(g?.last_name, 'Okafor');
  });

  test('a plain "First Last" name still works', () => {
    assert.deepEqual(splitName('Ngozi Okafor'), { first: 'Ngozi', last: 'Okafor' });
    assert.deepEqual(splitName('Okafor, Ngozi'), { first: 'Ngozi', last: 'Okafor' });
    assert.deepEqual(splitName('Cher'), { first: 'Cher', last: null });
    assert.deepEqual(splitName('Okafor,'), { first: 'Okafor', last: null });
  });

  test('every imported record says where it came from', () => {
    const csv = HEAD + 'Traceable Person,trace.imp@example.invalid,416-555-0705,Tess,\n';
    const p = parseCsv(csv);
    const result = commitImport(p, guessMapping(p.headers), { type: 'user', id: null }, 'march-list.csv');

    const fam = one<{ id: string; source: string }>(
      `SELECT f.id, f.source FROM families f JOIN guardians g ON g.family_id = f.id
        WHERE g.email_norm = 'trace.imp@example.invalid'`)!;
    assert.equal(fam.source, 'excel');

    const ev = one<{ summary: string }>(
      "SELECT summary FROM events WHERE entity_id = ? AND type = 'created'", fam.id);
    assert.match(ev!.summary, /march-list\.csv/, 'the file name is on the record');
    assert.match(ev!.summary, new RegExp(result.batchId.slice(0, 8)), 'the batch id is on the record');
  });
});


// ---------------------------------------------------------------- backups

describe('backups', () => {
  test('a backup opens, passes integrity, and holds the same rows', () => {
    // The failure this guards against is a backup that exists as a file and is
    // unopenable when it is finally needed. VACUUM INTO rather than copying is
    // what makes that true; this asserts it.
    const r = createBackup();
    assert.ok(r.sizeBytes > 0, 'the file is not empty');
    assert.equal(r.verify.integrity, 'ok');
    assert.equal(r.verify.ok, true, r.verify.problems.join('; '));

    for (const [table, n] of Object.entries(r.verify.counts)) {
      assert.equal(n, r.verify.liveCounts[table],
        table + ': backup has ' + n + ', live has ' + r.verify.liveCounts[table]);
    }
    assert.ok(r.verify.counts.families !== undefined, 'families are checked');
    assert.ok(r.verify.counts.events !== undefined, 'the event log is checked');
  });

  test('a rehearsed restore opens the file as a separate database', async () => {
    createBackup();
    const newest = listBackups()[0]!;
    const result = await testRestore(newest.file);
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(result.integrity, 'ok');
    assert.ok(result.counts.families! >= 0);
  });

  test('rehearsing a restore of something that is not there fails loudly', async () => {
    await assert.rejects(() => testRestore('crm-does-not-exist.db'), /No such backup/);
  });

  test('pruning keeps the newest and removes the rest', () => {
    for (let i = 0; i < 3; i++) createBackup();
    const before = listBackups().length;
    assert.ok(before >= 3, 'several backups exist');

    const removed = pruneBackups(2);
    const after = listBackups();
    assert.equal(after.length, 2, 'exactly the requested number is kept');
    assert.equal(removed.length, before - 2);

    // The survivors must be the NEWEST, not an arbitrary two.
    assert.ok(after[0]!.takenAt >= after[1]!.takenAt, 'sorted newest first');
  });

  test('backups are listed newest first, with a real age', () => {
    createBackup();
    const all = listBackups();
    assert.ok(all.length > 0);
    assert.ok(all[0]!.ageHours >= 0 && all[0]!.ageHours < 1, 'a fresh backup is not hours old');
    assert.match(all[0]!.file, /^crm-.*\.db$/);
  });
});


// ------------------------------------------------------------ automations

describe('automation engine', () => {
  test('seeds the rules that used to be buried in the pipeline', () => {
    seedAutomations();
    const all = listAutomations();
    assert.ok(all.length >= 4, 'the built-in rules exist');
    for (const a of all) {
      assert.ok(a.name.length > 3, 'every rule has a readable name');
      assert.ok(Array.isArray(a.actions) && a.actions.length > 0, a.name + ' does something');
      assert.ok(a.max_per_run > 0, a.name + ' has a cap');
    }
  });

  test('fires on a stalled lead and records WHY it fired', () => {
    seedAutomations();
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Silent Family', email: 'silent.auto@example.invalid', phone: '416-555-0990' },
      child: { firstName: 'Quiet', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));

    // Age the lead past the five-day threshold and clear the task the pipeline
    // already made, so the rule is the only thing that could act.
    const old = new Date(Date.now() - 10 * 864e5).toISOString();
    execSql('UPDATE leads SET last_contact_at = ?, created_at = ? WHERE id = ?', old, old, r.leadId!);
    execSql("UPDATE tasks SET status = 'done' WHERE related_id IN (?, ?)", r.familyId, r.registrationId!);

    const rule = listAutomations().find((a) => a.id === 'auto_stalled_lead')!;
    const summary = runAutomation(rule);
    assert.ok(summary.acted >= 1, 'the rule should act on a lead untouched for ten days');

    const runs = runsFor('auto_stalled_lead', 50);
    const acted = runs.filter((x) => x.outcome === 'acted');
    assert.ok(acted.length >= 1);
    assert.ok(String(acted[0]!.reason).length > 5, 'the run says why in plain English');

    const created = one<{ n: number }>(
      "SELECT COUNT(*) n FROM tasks WHERE related_id = ? AND source = 'automation'", r.leadId!);
    assert.ok(Number(created?.n ?? 0) >= 1, 'a task was actually created');
  });

  test('records the runs that did NOTHING, and why', () => {
    // "Why didn't it fire?" is the question people actually ask, and it is
    // unanswerable if only successes are logged.
    seedAutomations();
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Fresh Lead', email: 'fresh.auto@example.invalid', phone: '416-555-0991' },
      child: { firstName: 'New', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    ingest(env.value);

    const rule = listAutomations().find((a) => a.id === 'auto_stalled_lead')!;
    runAutomation(rule);

    const skipped = runsFor('auto_stalled_lead', 100).filter((x) => x.outcome === 'skipped');
    assert.ok(skipped.length >= 1, 'a fresh lead produces a skipped run, not silence');
    assert.match(String(skipped[0]!.reason), /only \d+h since|already an open task/,
      'the skip reason is specific, not "conditions not met"');
  });

  test('test mode runs everything and writes nothing', () => {
    seedAutomations();
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Dry Run', email: 'dryrun.auto@example.invalid', phone: '416-555-0992' },
      child: { firstName: 'Test', ageBand: '3-5 years' },
    })));
    assert.equal(env.ok, true); if (!env.ok) return;
    const r = asFamily(ingest(env.value));
    const old = new Date(Date.now() - 10 * 864e5).toISOString();
    execSql('UPDATE leads SET last_contact_at = ?, created_at = ? WHERE id = ?', old, old, r.leadId!);
    execSql("UPDATE tasks SET status = 'done' WHERE related_id IN (?, ?)", r.familyId, r.registrationId!);

    const tasksBefore = countRows("SELECT COUNT(*) n FROM tasks WHERE source = 'automation'");
    const rule = { ...listAutomations().find((a) => a.id === 'auto_stalled_lead')!, test_mode: 1 };
    runAutomation(rule);
    const tasksAfter = countRows("SELECT COUNT(*) n FROM tasks WHERE source = 'automation'");

    assert.equal(tasksAfter, tasksBefore, 'test mode must not create anything');
    const testRuns = runsFor(rule.id, 100).filter((x) => x.outcome === 'test');
    assert.ok(testRuns.length >= 1, 'but it still records what it would have done');
    assert.match(String(testRuns[0]!.reason), /Would have run/);
  });

  test('a rule cannot stampede: max_per_run is a hard cap', () => {
    seedAutomations();
    const rule = { ...listAutomations().find((a) => a.id === 'auto_stalled_lead')!, max_per_run: 1 };
    const summary = runAutomation(rule);
    assert.ok(summary.acted + summary.skipped + summary.failed <= 1,
      'one bad import must not generate a thousand tasks');
  });

  test('the kill switch stops everything at once', () => {
    seedAutomations();
    const n = disableAll();
    assert.ok(n >= 1, 'it disabled the rules that were running');
    assert.equal(listAutomations().filter((a) => a.enabled).length, 0, 'nothing is left enabled');
    // Put them back for any later test.
    execSql('UPDATE automations SET enabled = 1 WHERE built_in = 1');
  });
});


// ------------------------------------------------------------------- ai

describe('ai layer', () => {
  const owner = { id: 'u-owner', email: 'o@x', name: 'Owner', role: 'owner',
    status: 'active', created_at: '', last_login_at: null } as const;
  const educator = { ...owner, id: 'u-edu', role: 'educator' } as const;

  function familyWithEverything() {
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: { fullName: 'Amina Diallo', email: 'amina.ai@example.invalid', phone: '416-555-0801' },
      child: { firstName: 'Fatou', ageBand: '3-5 years', dateOfBirth: '2021-05-04' },
    })));
    assert.equal(env.ok, true);
    if (!env.ok) throw new Error('setup failed');
    return asFamily(ingest(env.value));
  }

  test('the CRM summarises with no AI configured at all', async () => {
    const r = familyWithEverything();
    const s = await summariseFamily(r.familyId, owner as never);
    assert.ok(s);
    assert.equal(s!.source, 'rules', 'no provider means the rules answer');
    assert.equal(s!.insight, null, 'and there is no invented insight');
    assert.ok(s!.facts.length >= 3, 'the rules summary is genuinely useful on its own');
    assert.ok(s!.facts.some((f) => /Fatou/.test(f)), 'it names the child');
  });

  test('SPEC 27: an educator cannot obtain a date of birth through AI', () => {
    const r = familyWithEverything();

    const asOwner = factsForFamily(r.familyId, owner as never)!;
    const asEducator = factsForFamily(r.familyId, educator as never)!;

    assert.ok(asOwner.children[0]!.dateOfBirth, 'an owner may see it directly');
    assert.equal(asEducator.children[0]!.dateOfBirth, undefined,
      'an educator must not, and the field is absent rather than empty');

    // The whole payload, as a string: a nested leak would slip past a key check.
    assert.ok(!JSON.stringify(asEducator).includes('2021-05-04'),
      'the date must not appear anywhere in what AI would receive');
  });

  test('contact details are reduced to whether they exist', () => {
    const r = familyWithEverything();
    const facts = factsForFamily(r.familyId, owner as never)!;
    const blob = JSON.stringify(facts);

    assert.equal(facts.guardians[0]!.hasEmail, true, 'presence is reported');
    assert.equal(facts.guardians[0]!.hasPhone, true);
    assert.ok(!blob.includes('amina.ai@example.invalid'), 'the address itself is never sent');
    assert.ok(!blob.includes('416-555-0801'), 'nor the phone number');
  });

  test('note bodies never reach the AI view', () => {
    const r = familyWithEverything();
    execSql(
      "INSERT INTO notes (id, entity_type, entity_id, body, created_at) VALUES (?, 'family', ?, ?, ?)",
      randomUUID(), r.familyId, 'Candid staff observation that should stay internal', new Date().toISOString());

    const facts = factsForFamily(r.familyId, owner as never)!;
    assert.equal(facts.noteCount, 1, 'the count is useful');
    assert.ok(!JSON.stringify(facts).includes('Candid staff observation'),
      'but what staff actually wrote is not sent anywhere');
  });

  test('a family marked no-AI is withheld entirely', async () => {
    const r = familyWithEverything();
    execSql('UPDATE families SET no_ai = 1 WHERE id = ?', r.familyId);

    const facts = factsForFamily(r.familyId, owner as never)!;
    assert.ok(facts.withheld, 'the flag on the record wins');
    assert.equal(facts.children.length, 0, 'nothing about the children is assembled');
    assert.equal(facts.guardians.length, 0);

    const s = await summariseFamily(r.familyId, owner as never);
    assert.equal(s!.facts.length, 0, 'and no summary is produced');
    assert.ok(s!.withheld);
  });

  test('local-only is treated the same as no-AI', () => {
    const r = familyWithEverything();
    execSql('UPDATE families SET local_only = 1 WHERE id = ?', r.familyId);
    assert.ok(factsForFamily(r.familyId, owner as never)!.withheld);
  });

  test('the daily brief counts real rows and never invents any', async () => {
    const b = await dailyBrief(owner as never);
    assert.ok(Array.isArray(b.facts) && b.facts.length > 0);
    assert.equal(b.source, 'rules');
    assert.equal(b.insight, null);
    for (const f of b.facts) {
      assert.ok(!/\bmight\b|\bprobably\b|\blikely\b/i.test(f),
        'a fact line must not hedge: ' + f);
    }
  });

  test('status is honest about there being no provider', async () => {
    const st = await aiStatus();
    assert.equal(st.configured, false);
    assert.equal(st.reachable, false);
    assert.match(st.detail, /works without/i, 'it says the CRM is fine without one');
  });

  test('the rules summary flags a family nobody can contact', () => {
    const familyId = randomUUID();
    const now = new Date().toISOString();
    execSql(
      "INSERT INTO families (id, name, status, source, created_at, updated_at) VALUES (?, 'Silent family', 'prospective', 'manual', ?, ?)",
      familyId, now, now);
    const lines = ruleSummary(factsForFamily(familyId, owner as never)!);
    assert.ok(lines.some((l) => /no way to contact/i.test(l)));
    assert.ok(lines.some((l) => /No child is recorded/i.test(l)));
  });
});

// ------------------------------------------------------------------ security

describe('security', () => {
  test('passwords verify correctly and reject wrong input', () => {
    const h = hashPassword('correct horse battery staple');
    assert.ok(verifyPassword('correct horse battery staple', h));
    assert.equal(verifyPassword('wrong password', h), false);
  });

  test('the same password hashes differently each time (salted)', () => {
    assert.notEqual(hashPassword('same'), hashPassword('same'));
  });

  test('a valid HMAC signature passes and a tampered body fails', () => {
    const secret = 'test-ingest-secret';
    const body = JSON.stringify({ hello: 'world' });
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    assert.ok(verifySignature(body, sig, secret));
    assert.ok(verifySignature(body, `sha256=${sig}`, secret));
    assert.equal(verifySignature(body + ' ', sig, secret), false, 'a changed body must invalidate the signature');
    assert.equal(verifySignature(body, sig, 'wrong-secret'), false);
    assert.equal(verifySignature(body, undefined, secret), false);
  });

  test('repeated wrong passwords lock the account out', () => {
    resetLoginLimits();
    const who = 'victim@example.invalid';
    const from = '203.0.113.9';

    // The first few are free: a person who mistypes must not be punished.
    for (let i = 0; i < 5; i++) {
      assert.equal(checkLoginAllowed(who, from).allowed, true, `attempt ${i + 1} should be allowed`);
      recordLoginFailure(who, from);
    }
    recordLoginFailure(who, from);

    const verdict = checkLoginAllowed(who, from);
    assert.equal(verdict.allowed, false, 'the account must be locked after sustained failures');
    assert.ok(verdict.retryAfterSeconds > 0, 'the caller is told how long to wait');
  });

  test('getting the password right eventually does not leave you locked out', () => {
    resetLoginLimits();
    const from = '203.0.113.10';
    for (let i = 0; i < 6; i++) recordLoginFailure('a@example.invalid', from);
    recordLoginSuccess('a@example.invalid', from);
    assert.equal(checkLoginAllowed('a@example.invalid', from).allowed, true,
      'a success must lift the lock on both the account and the address it came from');
  });

  test('one address cannot sweep many accounts', () => {
    resetLoginLimits();
    const from = '203.0.113.11';
    for (let i = 0; i < 60; i++) recordLoginFailure(`user${i}@example.invalid`, from);
    assert.equal(checkLoginAllowed('never-tried@example.invalid', from).allowed, false,
      'the address is blocked even for an account it has not touched');
  });

  test('one colleague fumbling their password does not lock out the office', () => {
    // Every staff member shares one office address. Caught by actually hammering
    // the endpoint: the escalating lock used to apply to the address too, so one
    // person mistyping locked out everyone sitting next to them.
    resetLoginLimits();
    const office = '203.0.113.12';
    for (let i = 0; i < 8; i++) recordLoginFailure('butterfingers@example.invalid', office);

    assert.equal(checkLoginAllowed('butterfingers@example.invalid', office).allowed, false,
      'the account that failed is locked');
    assert.equal(checkLoginAllowed('colleague@example.invalid', office).allowed, true,
      'everyone else at the same address can still sign in');
  });

  test('a password hash never leaves the auth module', () => {
    // Regression, and it was live before it was caught. userForToken did
    // `SELECT u.*`, so /auth/me handed every signed-in browser the scrypt hash
    // of that user's password. TypeScript could not see it: the row was typed
    // as `User`, which has no password_hash, so the annotation was a lie about
    // what SQL returned. Only reading a real response found it.
    const email = `leak-${randomUUID().slice(0, 8)}@example.invalid`;
    createUser(email, 'Leak Check', 'owner', 'a-long-enough-password');

    const session = login(email, 'a-long-enough-password');
    assert.ok(session, 'the test user should be able to sign in');

    // Everything the API hands back about a user, checked as serialised JSON:
    // a nested field would slip past a key-by-key check.
    const fromLogin = JSON.stringify(session!.user);
    const fromToken = JSON.stringify(userForToken(session!.token));

    for (const [where, blob] of [['login', fromLogin], ['userForToken', fromToken]] as const) {
      assert.ok(!blob.includes('password_hash'), `${where} leaked the password_hash key`);
      assert.ok(!blob.includes('scrypt$'), `${where} leaked the hash itself`);
    }
  });

  test('roles cannot exceed their capabilities', () => {
    assert.equal(can({ role: 'educator' }, 'data:export'), false, 'an educator cannot export the family list');
    assert.equal(can({ role: 'educator' }, 'child:read_sensitive'), false, 'an educator does not get dates of birth');
    assert.equal(can({ role: 'readonly' }, 'family:write'), false);
    assert.equal(can({ role: 'admissions' }, 'user:manage'), false);
    assert.equal(can({ role: 'owner' }, 'user:manage'), true);
    assert.equal(can(null, 'family:read'), false, 'signed out means no capabilities at all');
  });
});


// ----------------------------------------------------------------- reporting

describe('honest reporting', () => {
  test('attention only lists items that actually have a count', () => {
    for (const item of attention()) {
      assert.ok(item.count > 0, `"${item.label}" was listed with a count of ${item.count}`);
      assert.ok(item.link, 'every attention item must link somewhere specific');
    }
  });

  test('data health reports a measured score, with the issues behind it', () => {
    const h = dataHealth();
    assert.equal(h.measured, true, 'there are families, so it is measurable');
    assert.ok(h.score !== null && h.score >= 0 && h.score <= 100);
    for (const i of h.issues) assert.ok(i.count > 0);
  });
});


// ------------------------------------------------------- destructive tooling

/**
 * On 2026-08-28 a real registration arrived from the website at 23:10:26. At
 * 23:11:21 `prod:harden --force` matched its guardian address against
 * `%@example.invalid` and deleted the family, the child, the lead, both
 * registrations and the guardian. Only the append-only event log survived to
 * show they had ever been there, and the orphaned review task in the attention
 * radar still pointed at a registration that returned "No such registration".
 *
 * Note the fixture at the top of this file already uses an @example.invalid
 * address, because that is what a test address looks like. That is precisely
 * the trap: the pattern says "synthetic" and the ingest ledger says "a parent
 * pressed submit", and the ledger is the one telling the truth.
 */
describe('prod:harden cannot delete real family data', () => {
  test('a website registration survives, whatever address the parent typed', async () => {
    const { harden } = await import('../packages/server/src/seed/production.ts');

    const eventId = randomUUID();
    const env = validateEnvelope(envelope('registration.created', registration({
      guardian: {
        fullName: 'Marguerite Okonkwo-Bell',
        email: 'marguerite@example.invalid',   // the exact pattern harden hunts for
        phone: '780-555-0163',
        relationship: 'Parent',
      },
      child: { firstName: 'Adaeze', ageBand: '3-5 years' },
    }), eventId));
    assert.ok(env.ok, 'the fixture must be a valid envelope');
    const result = ingest(env.value) as { familyId: string };
    const familyId = result.familyId;
    assert.ok(familyId);

    const regBefore = one<{ id: string }>('SELECT id FROM registrations WHERE family_id = ?', familyId);
    assert.ok(regBefore, 'the registration should exist before harden runs');

    harden(true);

    const family = one<{ id: string }>('SELECT id FROM families WHERE id = ?', familyId);
    assert.ok(family, 'harden deleted a family that a real parent submitted');

    const regAfter = one<{ id: string }>('SELECT id FROM registrations WHERE id = ?', regBefore.id);
    assert.ok(regAfter, 'harden deleted a registration that a real parent submitted');

    const guardian = one<{ id: string }>(
      `SELECT id FROM guardians WHERE family_id = ? AND email = 'marguerite@example.invalid'`, familyId);
    assert.ok(guardian, 'the guardian went with it');
  });

  test('it still removes genuinely seeded data, and takes a backup before it does', async () => {
    const { harden } = await import('../packages/server/src/seed/production.ts');
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');

    // A seeded family looks exactly like a website one except for the detail
    // that matters: no inbound event ever created it, so source_id is NULL.
    const fakeId = randomUUID();
    const now = new Date().toISOString();
    dbRun(`INSERT INTO families (id, name, status, source, source_id, created_at, updated_at)
           VALUES (?,?,'prospective','website',NULL,?,?)`, fakeId, 'Fabricated family', now, now);
    dbRun(`INSERT INTO guardians (id, family_id, first_name, last_name, email, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?)`,
      randomUUID(), fakeId, 'Nobody', 'Real', 'nobody@example.invalid', now, now);

    const backupsBefore = listBackups().length;
    harden(true);

    assert.equal(
      one<{ id: string }>('SELECT id FROM families WHERE id = ?', fakeId), undefined,
      'harden must still remove data that no inbound event ever created');
    assert.ok(listBackups().length > backupsBefore,
      'harden must take a backup before it deletes anything');
  });

  test('a deleted record reports that it was deleted, not that it never existed', async () => {
    const { historyOf } = await import('../packages/server/src/core/events.ts');

    // The registration deleted in the incident above.
    assert.equal(historyOf('registration', randomUUID()), null,
      'an id that was never real has no history');

    const known = one<{ entity_id: string }>(
      `SELECT entity_id FROM events WHERE entity_type = 'registration' LIMIT 1`);
    assert.ok(known);
    const h = historyOf('registration', known.entity_id);
    assert.ok(h && h.created, 'the append-only log outlives the row and can say when it existed');
  });
});


// ------------------------------------------------------- attendance & rooms

/**
 * The register is the first module that records what happens to a child during
 * the day, so the tests that matter most are the ones about who can see it.
 *
 * The boundary is `classroom_staff`, not a WHERE clause someone remembered to
 * write, and these assert it from the outside: an educator with no room sees
 * nobody, an educator with one room sees exactly that room, and neither can be
 * talked into seeing a date of birth.
 */
describe('attendance', () => {
  let room: string, otherRoom: string;
  let teacher: Awaited<ReturnType<typeof createUser>>;
  let director: Awaited<ReturnType<typeof createUser>>;
  let mine: string, theirs: string;
  const DAY = '2026-08-29';

  before(async () => {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const now = new Date().toISOString();

    room = randomUUID(); otherRoom = randomUUID();
    dbRun('INSERT INTO classrooms (id, name, program_id, capacity, active, created_at) VALUES (?,?,NULL,12,1,?)',
      room, 'Sunflower Room', now);
    dbRun('INSERT INTO classrooms (id, name, program_id, capacity, active, created_at) VALUES (?,?,NULL,12,1,?)',
      otherRoom, 'Bluebell Room', now);

    const fam = randomUUID();
    dbRun('INSERT INTO families (id, name, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      fam, 'Adeyemi-Cardoso family', 'enrolled', 'manual', now, now);

    mine = randomUUID(); theirs = randomUUID();
    const child = 'INSERT INTO children (id, family_id, first_name, date_of_birth, age_band, classroom_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)';
    dbRun(child, mine, fam, 'Folasade', '2022-04-11', '3-5 years', room, 'enrolled', now, now);
    dbRun(child, theirs, fam, 'Oluwaseun', '2021-09-02', '3-5 years', otherRoom, 'enrolled', now, now);

    teacher = createUser('teacher-att@test.local', 'Ngozi Abiodun', 'educator', 'test-pw-1234');
    director = createUser('director-att@test.local', 'Halvard Nyqvist', 'director', 'test-pw-1234');
  });

  const actor = (u: { id: string }) => ({ type: 'user' as const, id: u.id, source: 'manual' });

  test('an educator assigned to no room sees nobody', () => {
    assert.deepEqual(visibleClassroomIds(teacher), []);
    assert.equal(register(teacher, DAY).length, 0,
      'an unassigned educator must not fall through to seeing every child');
  });

  test('a director is not scoped, and sees both rooms', () => {
    assert.equal(visibleClassroomIds(director), null,
      'null means unscoped and must not be confused with an empty list');
    const ids = register(director, DAY).map((r) => r.child_id);
    assert.ok(ids.includes(mine) && ids.includes(theirs));
  });

  test('assigning a room widens the educator to exactly that room', () => {
    assignStaff(room, teacher.id, 'lead', actor(director));
    const rows = register(teacher, DAY);
    assert.deepEqual(rows.map((r) => r.child_id), [mine],
      'the educator should see their room and only their room');
  });

  test('an educator still cannot see a date of birth', () => {
    const [row] = register(teacher, DAY);
    assert.ok(row, 'the educator can see the child');
    assert.equal('date_of_birth' in row, false,
      'the column must be absent, not blanked (spec 27)');
    const [seen] = register(director, DAY, room);
    assert.ok(seen);
    assert.equal(seen.date_of_birth, '2022-04-11', 'a director still gets it');
  });

  test('an educator cannot mark a child in a room they are not assigned to', () => {
    assert.throws(
      () => mark(teacher, actor(teacher), { childId: theirs, day: DAY, status: 'present' }),
      /not in a room you are assigned to/);
  });

  test('a child not yet marked shows as expected, not missing', () => {
    const [row] = register(teacher, DAY);
    assert.ok(row);
    assert.equal(row.status, 'expected',
      'a register that only lists children someone already ticked is not a register');
  });

  test('checking in records who did it, and lands in the append-only log', () => {
    mark(teacher, actor(teacher), { childId: mine, day: DAY, status: 'present' });
    const [row] = register(teacher, DAY);
    assert.ok(row);
    assert.equal(row.status, 'present');
    assert.ok(row.checked_in_at, 'the time is recorded');

    const events = timelineFor('child', mine, 20);
    assert.ok(events.some((e) => e.type === 'attendance_marked'),
      'the change is in the event log, which cannot be rewritten');
  });

  test('a child cannot be checked out without naming who collected them', () => {
    assert.throws(
      () => checkOut(teacher, actor(teacher), mine, DAY, '   '),
      /who collected the child/);
  });

  test('checking out records the name, and refuses to happen twice', () => {
    const row = checkOut(teacher, actor(teacher), mine, DAY, 'Grandmother, arranged by phone');
    assert.equal(row.released_to, 'Grandmother, arranged by phone');
    assert.ok(row.checked_out_at);

    assert.throws(
      () => checkOut(teacher, actor(teacher), mine, DAY, 'Someone else'),
      /already collected/,
      'a second check-out would overwrite the record of who actually took the child');
  });

  test('a room with no configured ratio says so rather than showing a number', () => {
    const [standing] = roomStandings(teacher, DAY);
    assert.ok(standing);
    assert.equal(standing.measured, false);
    assert.equal(standing.withinRatio, null, 'no invented verdict');
    assert.match(standing.note ?? '', /not measured/);
  });

  test('a configured ratio with nobody assigned is still not measurable', async () => {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const now = new Date().toISOString();
    const prog = randomUUID();
    const empty = randomUUID();
    dbRun('INSERT INTO programs (id, slug, name, active, sort_order, created_at) VALUES (?,?,?,1,99,?)',
      prog, 'ratio-' + prog.slice(0, 8), 'Ratio Test Program', now);
    dbRun('INSERT INTO ratio_rules (program_id, children_per_staff, source, updated_at) VALUES (?,?,?,?)',
      prog, 8, 'test', now);
    dbRun('INSERT INTO classrooms (id, name, program_id, capacity, active, created_at) VALUES (?,?,?,10,1,?)',
      empty, 'Unstaffed Room', prog, now);

    const standing = roomStandings(director, DAY).find((r) => r.classroomId === empty);
    assert.ok(standing);
    assert.equal(standing.measured, false, 'dividing by zero staff is not a ratio');
    assert.equal(standing.requiredPerStaff, 8, 'the rule is still reported');
    assert.match(standing.note ?? '', /Nobody is assigned/);
  });

  test('removing the assignment closes the educator back down to nobody', () => {
    assert.equal(unassignStaff(room, teacher.id, actor(director)), true);
    assert.equal(register(teacher, DAY).length, 0,
      'access must end when the assignment does');
  });
});


// ------------------------------------------------------------ outbound sync

/**
 * The interesting failures in a sync are all in the retry logic, so these run
 * against a fake transport rather than Google. A test that needs a spreadsheet
 * to be reachable is a test nobody runs, and the retry path is exactly the part
 * that only gets exercised on a bad day.
 */
describe('outbound sync', () => {
  const CHANNEL = 'test-channel';
  let syncFamily: string, quietFamily: string;
  let behaviour: 'ok' | 'throw' = 'ok';
  let ready: string | null = null;
  let lastBatch: unknown[] = [];

  before(async () => {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const now = new Date().toISOString();

    syncFamily = randomUUID(); quietFamily = randomUUID();
    dbRun('INSERT INTO families (id, name, status, source, no_sync, created_at, updated_at) VALUES (?,?,?,?,0,?,?)',
      syncFamily, 'Okonjo-Ferrante family', 'enrolled', 'manual', now, now);
    dbRun('INSERT INTO families (id, name, status, source, no_sync, created_at, updated_at) VALUES (?,?,?,?,1,?,?)',
      quietFamily, 'Private family', 'enrolled', 'manual', now, now);

    registerTransport({
      channel: CHANNEL,
      notReadyReason: () => ready,
      async send(_target, rows) {
        lastBatch = rows;
        if (behaviour === 'throw') throw new Error('the far end said no');
        return { sent: rows.length };
      },
    });
    upsertTarget(CHANNEL, { label: 'Test target', externalId: 'sheet-1', enabled: true });
  });

  test('a family marked "never sync" is excluded by the query, not by a later check', () => {
    queue(CHANNEL, { hello: 'world' }, syncFamily);
    queue(CHANNEL, { secret: 'do not send' }, quietFamily);

    const rows = due(CHANNEL, new Date().toISOString());
    assert.equal(rows.length, 1, 'only the family that allows syncing is due');
    assert.equal(rows[0]?.family_id, syncFamily);
    assert.equal(suppressed(CHANNEL), 1, 'and the opted-out one is reported, not silently dropped');
  });

  test('a run that sends marks the rows sent and stamps the target', async () => {
    behaviour = 'ok';
    const result = await runChannel(CHANNEL);
    assert.equal(result.outcome, 'sent');
    assert.equal(result.sent, 1);
    assert.equal(result.skipped, 1, 'the opted-out row is reported as skipped');
    assert.equal(lastBatch.length, 1, 'the batch is one request, not one per row');

    assert.equal(due(CHANNEL, new Date().toISOString()).length, 0, 'nothing left due');
    assert.ok(targetFor(CHANNEL)?.last_sync_at, 'the target records when it last synced');
  });

  test('an empty queue is still recorded, because "why didn\'t it sync?" is the question asked', async () => {
    const before = syncRuns(CHANNEL, 50).length;
    const result = await runChannel(CHANNEL);
    assert.equal(result.outcome, 'nothing_queued');
    assert.equal(syncRuns(CHANNEL, 50).length, before + 1,
      'a log that records only successes cannot explain a silence');
  });

  test('not connected is its own outcome, never a failure', async () => {
    ready = 'Nobody has connected this yet.';
    queue(CHANNEL, { hello: 'again' }, syncFamily);

    const result = await runChannel(CHANNEL);
    assert.equal(result.outcome, 'not_connected');
    assert.equal(result.failed, 0, 'a setup step must not light up as an incident');

    const status = channelStatus(CHANNEL);
    assert.equal(status.connected, false);
    assert.equal(status.notConnectedReason, 'Nobody has connected this yet.');
    assert.ok(Number(status.pending) > 0, 'the row is still queued, waiting');
    ready = null;
  });

  test('a failing send backs off, then gives up rather than retrying forever', async () => {
    behaviour = 'throw';
    const { one: dbOne } = await import('../packages/server/src/db/index.ts');

    let last: Awaited<ReturnType<typeof runChannel>> | null = null;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // now far in the future so the backoff never holds the row back here;
      // the point under test is the attempt count, not the clock.
      last = await runChannel(CHANNEL, { now: '2099-01-01T00:00:00.000Z' });
    }
    assert.equal(last?.outcome, 'failed');

    const row = dbOne<{ status: string; attempts: number; last_error: string }>(
      `SELECT status, attempts, last_error FROM outbox
        WHERE channel = ? AND family_id = ? ORDER BY created_at DESC LIMIT 1`, CHANNEL, syncFamily);
    assert.equal(row?.status, 'dead', 'a bounded retry, then a person looks at it');
    assert.equal(row?.attempts, MAX_ATTEMPTS);
    assert.match(row?.last_error ?? '', /the far end said no/);
    behaviour = 'ok';
  });

  test('backoff grows, is jittered, and is capped', () => {
    // Same attempt count, different randomness, must not collide: without the
    // jitter every row from one burst retries in the same instant.
    assert.notEqual(backoffMs(3, () => 0), backoffMs(3, () => 1));
    assert.ok(backoffMs(1, () => 0.5) < backoffMs(5, () => 0.5), 'it grows');
    assert.ok(backoffMs(99, () => 1) <= 3_600_000, 'capped so a recovery is picked up');
    assert.ok(backoffMs(3, () => 0) >= 2 ** 3 * 1000 * 0.5, 'never collapses to zero');
  });

  test('mapping renders a missing field as blank, not the string "undefined"', () => {
    const mapping = mappingFor(null);
    const row = toRow({ guardian: { fullName: 'Ines Vukovic' }, programInterest: 'Nova Stars' }, mapping);
    assert.ok(row.includes('Ines Vukovic'));
    assert.ok(row.includes('Nova Stars'));
    assert.equal(row.some((cell) => cell === 'undefined' || cell === 'null'), false,
      'a gap in a parent record must not read as the word undefined');
    assert.equal(pluck({ a: { b: null } }, 'a.b.c'), '', 'walking off the end is blank');
  });

  test('the Sheets transport refuses to pretend it is connected', () => {
    // No Google credentials exist in the test environment, which is the point.
    const reason = sheetsTransport.notReadyReason(null);
    assert.ok(reason, 'it must report why, not silently do nothing');
    assert.match(reason, /GOOGLE_CLIENT_ID|not connected/i);
  });
});


// --------------------------------------------------------------- sending mail

/**
 * The rule the whole system is built to keep is that the CRM drafts and a
 * person sends. These are the tests that would catch it being broken — not the
 * happy path, which is easy, but every route by which something might send on
 * its own.
 */
describe('sending a message needs a person', () => {
  let family: string, guardian: string, optedOutGuardian: string;
  let sender: Awaited<ReturnType<typeof createUser>>;

  before(async () => {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const now = new Date().toISOString();

    family = randomUUID();
    dbRun('INSERT INTO families (id, name, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      family, 'Bergqvist-Oyelaran family', 'enrolled', 'manual', now, now);

    guardian = randomUUID(); optedOutGuardian = randomUUID();
    const g = 'INSERT INTO guardians (id, family_id, first_name, email, opted_out, is_primary, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)';
    dbRun(g, guardian, family, 'Annika', 'annika@example.invalid', 0, 1, now, now);
    dbRun(g, optedOutGuardian, family, 'Tunde', 'tunde@example.invalid', 1, 0, now, now);

    sender = createUser('sender@test.local', 'Priyanka Deshmukh', 'director', 'test-pw-1234');
  });

  const draftRow = (over: Record<string, unknown> = {}) => {
    const id = randomUUID();
    const now = new Date().toISOString();
    return { id, now, over };
  };

  async function makeDraft(guardianId: string | null, to: string | null) {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const id = randomUUID();
    const now = new Date().toISOString();
    dbRun(`INSERT INTO message_drafts (id, family_id, guardian_id, channel, to_address, subject,
             body, status, author, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id, family, guardianId, 'email', to, 'About your visit',
      'We are looking forward to meeting you.', 'composed', 'template', now);
    return id;
  }

  test('an automation cannot send, however it is called', async () => {
    const id = await makeDraft(guardian, 'annika@example.invalid');
    // This is the actor an automation or a scheduled rule runs as.
    assert.throws(
      () => requestSend(id, sender, { type: 'system', id: null, source: 'automation' }),
      /Only a signed-in person/);
  });

  test('the AI layer cannot send either', async () => {
    const id = await makeDraft(guardian, 'annika@example.invalid');
    assert.throws(
      () => requestSend(id, sender, { type: 'ai', id: null, source: 'ai' }),
      /Only a signed-in person/);
  });

  test('the database refuses a delivery that cannot name a person', async () => {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const id = await makeDraft(guardian, 'annika@example.invalid');
    // Straight past the application, the way a future bug would.
    assert.throws(
      () => dbRun(`UPDATE message_drafts SET delivery_state = 'queued' WHERE id = ?`, id),
      /without recording who sent it/,
      'the rule must survive somebody bypassing core/drafts.ts');
  });

  test('a guardian who opted out is refused', async () => {
    const id = await makeDraft(optedOutGuardian, 'tunde@example.invalid');
    assert.throws(() => requestSend(id, sender, actorFor(sender)), /opted out/);
  });

  test('a draft with no address is refused rather than queued to nowhere', async () => {
    const id = await makeDraft(guardian, null);
    assert.throws(() => requestSend(id, sender, actorFor(sender)), /no email address/);
  });

  test('a person sending queues it, names them, and records it in the event log', async () => {
    const { one: dbOne } = await import('../packages/server/src/db/index.ts');
    const id = await makeDraft(guardian, 'annika@example.invalid');

    const result = requestSend(id, sender, actorFor(sender));
    assert.equal(result.delivery_state, 'queued');
    assert.equal(result.requested_by, sender.id);
    assert.ok(result.outbox_id, 'it is queued, not sent inline: a slow provider must not fail the click');

    const queued = dbOne<{ channel: string; family_id: string }>(
      'SELECT channel, family_id FROM outbox WHERE id = ?', String(result.outbox_id));
    assert.equal(queued?.channel, 'email');
    assert.equal(queued?.family_id, family, 'so "never sync" can be honoured by the query');

    const events = familyTimeline(family, 20);
    const sent = events.find((e) => e.type === 'message_queued');
    assert.ok(sent, 'the send is in the append-only log');
    assert.match(sent.summary ?? '', /Priyanka Deshmukh/,
      'the log names the person, not "the system"');
  });

  test('the same draft cannot be sent twice', async () => {
    const id = await makeDraft(guardian, 'annika@example.invalid');
    requestSend(id, sender, actorFor(sender));
    assert.throws(() => requestSend(id, sender, actorFor(sender)), /already queued/);
  });

  test('email reports itself as not connected rather than quietly dropping messages', () => {
    const reason = emailTransport.notReadyReason(null);
    assert.ok(reason, 'no credentials exist in the test environment, and it must say so');
    assert.match(reason, /EMAIL_API_URL|not connected/i);

    // The queued drafts above are still queued, waiting — not lost, not failed.
    const status = channelStatus('email');
    assert.equal(status.connected, false);
    assert.ok(Number(status.pending) > 0, 'the messages wait for a provider rather than vanishing');
  });

  test('reconciliation marks a draft sent only when the queue actually sent it', async () => {
    const { run: dbRun, one: dbOne } = await import('../packages/server/src/db/index.ts');
    const id = await makeDraft(guardian, 'annika@example.invalid');
    const draft = requestSend(id, sender, actorFor(sender));

    // Nothing has sent it yet, so nothing should claim it did.
    reconcileDeliveries();
    assert.equal(
      dbOne<{ delivery_state: string }>('SELECT delivery_state FROM message_drafts WHERE id = ?', id)
        ?.delivery_state, 'queued');

    dbRun(`UPDATE outbox SET status = 'sent', updated_at = ? WHERE id = ?`,
      new Date().toISOString(), String(draft.outbox_id));
    reconcileDeliveries();

    const after = dbOne<{ delivery_state: string; status: string; delivered_at: string }>(
      'SELECT delivery_state, status, delivered_at FROM message_drafts WHERE id = ?', id);
    assert.equal(after?.delivery_state, 'sent');
    assert.equal(after?.status, 'sent');
    assert.ok(after?.delivered_at);
  });

  test('a draft the queue gave up on is marked failed, with the reason', async () => {
    const { run: dbRun, one: dbOne } = await import('../packages/server/src/db/index.ts');
    const id = await makeDraft(guardian, 'annika@example.invalid');
    const draft = requestSend(id, sender, actorFor(sender));

    dbRun(`UPDATE outbox SET status = 'dead', last_error = ?, updated_at = ? WHERE id = ?`,
      'mailbox does not exist', new Date().toISOString(), String(draft.outbox_id));
    reconcileDeliveries();

    const after = dbOne<{ delivery_state: string; delivery_error: string; status: string }>(
      'SELECT delivery_state, delivery_error, status FROM message_drafts WHERE id = ?', id);
    assert.equal(after?.delivery_state, 'failed');
    assert.match(after?.delivery_error ?? '', /mailbox does not exist/);
    assert.notEqual(after?.status, 'sent', 'a failed delivery must never read as sent');
  });
});


// -------------------------------------------------------------------- logbook

/**
 * The parsing is done by rule rather than by a model, so it can be pinned down
 * exactly — which is the whole reason it is done by rule. These are the cases
 * that decide whether a ledger is right or quietly wrong.
 */
describe('logbook parsing', () => {
  const TODAY = '2026-08-29'; // a Saturday

  test('money is read as integer cents, never a float', () => {
    assert.equal(parseMoney('I spent $84.32 at Costco'), 8432);
    assert.equal(parseMoney('paid 84.32 dollars'), 8432);
    assert.equal(parseMoney('$1,284.50 of furniture'), 128450);
    assert.equal(parseMoney('it was $40'), 4000);
    assert.equal(parseMoney('84.32'), 8432);
    // 0.1 + 0.2 problems do not get to touch a year of spending.
    assert.equal(Number.isInteger(parseMoney('$0.10')!), true);
    assert.equal(parseMoney('$0.10')! + parseMoney('$0.20')!, 30);
  });

  test('a bare count is not money', () => {
    assert.equal(parseMoney('picked up 2 boxes of gloves'), null,
      'reading "2 boxes" as $2.00 would be worse than reading nothing');
    assert.equal(parseMoney('sorted the 3 cots'), null);
  });

  test('dates are resolved against the caller\'s today, not the server\'s', () => {
    assert.equal(parseDay('bought milk today', TODAY), '2026-08-29');
    assert.equal(parseDay('got it yesterday', TODAY), '2026-08-28');
    assert.equal(parseDay('3 days ago', TODAY), '2026-08-26');
    assert.equal(parseDay('on 2026-07-04 we bought paint', TODAY), '2026-07-04');
  });

  test('a named weekday means the one that already happened', () => {
    // TODAY is a Saturday. "Tuesday" must be the Tuesday just gone.
    assert.equal(parseDay('we got it on Tuesday', TODAY), '2026-08-25');
    // And "Saturday" on a Saturday means a week ago, not today — a logbook
    // records what was done, so it never resolves to a future or ambiguous day.
    assert.equal(parseDay('last Saturday', TODAY), '2026-08-22');
  });

  test('a month and day in the future belongs to last year', () => {
    assert.equal(parseDay('on Dec 3', TODAY), '2025-12-03',
      'December is not yet reached in 2026, so it must mean 2025');
    assert.equal(parseDay('Aug 12', TODAY), '2026-08-12');
  });

  test('an unreadable date is null, so it becomes a question rather than today', () => {
    assert.equal(parseDay('bought some milk', TODAY), null,
      'silently defaulting to today puts a purchase on the wrong day');
  });

  test('the vendor and category come out of an ordinary sentence', () => {
    assert.equal(parseVendor('I bought milk from Costco this morning'), 'Costco');
    assert.equal(parseVendor('picked it up at the Dollar Store'), 'Dollar Store');
    assert.equal(parseCategory('milk, fruit and snacks'), 'Food');
    assert.equal(parseCategory('paint and glue for the craft table'), 'Craft supplies');
    assert.equal(parseCategory('something unusual'), null,
      'no confident category is better than a wrong one');
  });

  test('a whole sentence parses end to end', () => {
    const d = parseUtterance(
      'I bought $84.32 of milk and fruit from Costco yesterday', TODAY);
    assert.equal(d.kind, 'purchase');
    assert.equal(d.amountCents, 8432);
    assert.equal(d.vendor, 'Costco');
    assert.equal(d.happenedOn, '2026-08-28');
    assert.equal(d.category, 'Food');
    assert.equal(d.rawText, 'I bought $84.32 of milk and fruit from Costco yesterday');
    assert.equal(d.summary, undefined,
      'the description is the one part a rule should not invent');
  });

  test('gaps are questions a person can answer, and are computed by rule', () => {
    const d = parseUtterance('bought some things', TODAY);
    const gaps = gapsIn(d);
    const fields = gaps.map((g) => g.field);
    assert.ok(fields.includes('summary'));
    assert.ok(fields.includes('happenedOn'));
    assert.ok(fields.includes('amountCents'), 'a purchase needs an amount');
    assert.ok(fields.includes('vendor'), 'a purchase needs a supplier');
    for (const g of gaps) assert.match(g.question, /\?$/, 'every gap is asked as a question');
  });

  test('a note does not demand an amount or a supplier', () => {
    const d = parseUtterance('fixed the gate latch today', TODAY);
    assert.equal(d.kind, 'task');
    const fields = gapsIn({ ...d, summary: 'Fixed the gate latch' }).map((g) => g.field);
    assert.deepEqual(fields, [], 'a job that is done needs nothing else');
  });
});

describe('logbook recording and export', () => {
  const TODAY = '2026-08-29';
  let actor: { type: 'user'; id: string | null; source: string };
  let logger: Awaited<ReturnType<typeof createUser>>;

  before(() => {
    logger = createUser('logger@test.local', 'Ifeoma Castellanos', 'director', 'test-pw-1234');
    actor = { type: 'user', id: logger.id, source: 'manual' };
  });

  test('an incomplete entry is refused rather than saved half-written', () => {
    const d = parseUtterance('bought some things', TODAY);
    assert.throws(() => logRecord(d, actor), /Still missing/);
  });

  test('a complete entry saves, keeps what was said, and hits the event log', () => {
    const said = 'I bought $84.32 of milk and fruit from Costco yesterday';
    const d = parseUtterance(said, TODAY);
    const saved = logRecord({ ...d, summary: 'Milk and fruit' }, actor);

    assert.equal(saved.amount_cents, 8432);
    assert.equal(saved.vendor, 'Costco');
    assert.equal(saved.happened_on, '2026-08-28');
    assert.equal(saved.raw_text, said,
      'the original sentence survives whatever the parser made of it');

    const events = timelineFor('logbook', String(saved.id), 5);
    assert.ok(events.some((e) => e.type === 'created'));
  });

  test('recall finds it by what was said, not only by the tidy fields', () => {
    const hits = logRecall('costco');
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.vendor, 'Costco');
    // A search box full of FTS operators must not 500.
    assert.doesNotThrow(() => logRecall('"*(){} ^costco'));
  });

  test('totals say "not measured" for an empty range instead of a confident zero', () => {
    const empty = logTotals({ from: '1999-01-01', to: '1999-12-31' });
    assert.equal(empty.measured, false);
    assert.equal(empty.spentCents, null,
      '$0.00 reads as "you spent nothing", which is a different claim');

    const real = logTotals({});
    assert.equal(real.measured, true);
    assert.ok(Number(real.spentCents) >= 8432);
  });

  test('a correction keeps the original in the append-only log', () => {
    const d = parseUtterance('bought $10.00 of glue from Michaels today', TODAY);
    const saved = logRecord({ ...d, summary: 'Glue' }, actor);
    const fixed = logUpdate(String(saved.id), { amountCents: 1250 }, actor);
    assert.equal(fixed.amount_cents, 1250);

    const events = timelineFor('logbook', String(saved.id), 10);
    const edit = events.find((e) => e.type === 'updated');
    assert.ok(edit, 'the correction is recorded');
    assert.match(edit.before_json ?? '', /1000/, 'and so is what it used to say');
  });

  test('the workbook is a real xlsx, with a sheet per cut', () => {
    const buf = logWorkbook({});
    assert.ok(buf.length > 1000);
    // PK\x03\x04 — it is a zip, which is what xlsx is.
    assert.equal(buf.subarray(0, 4).toString('binary'), 'PK');

    const text = buf.toString('binary');
    assert.ok(text.includes('[Content_Types].xml'), 'the OPC content types part is present');
    assert.ok(text.includes('xl/worksheets/sheet4.xml'), 'all four sheets are in the package');
  });

  test('a cell full of XML metacharacters does not corrupt the file', () => {
    const nasty = 'Paint & brushes <for> "art" & craft ';
    const d = parseUtterance('bought $5.00 of things from Michaels today', TODAY);
    logRecord({ ...d, summary: nasty }, actor);

    const buf = logWorkbook({});
    assert.equal(buf.subarray(0, 4).toString('binary'), 'PK',
      'an ampersand in a description must not produce a workbook Excel refuses to open');
    assert.ok(buf.length > 1000);
  });
});


describe('removing a logbook entry', () => {
  const TODAY = '2026-08-29';
  let actor: { type: 'user'; id: string | null; source: string };
  let entryId: string;

  before(() => {
    const u = createUser('binner@test.local', 'Halima Sørensen', 'director', 'test-pw-1234');
    actor = { type: 'user', id: u.id, source: 'manual' };
  });

  test('a removed entry leaves the list, the search and the totals', () => {
    const before = logTotals({});
    const saved = logRecord(
      { ...parseUtterance('bought $30.00 of tape from Staples today', TODAY), summary: 'Masking tape' },
      actor);
    entryId = String(saved.id);

    const withIt = logTotals({});
    assert.equal(Number(withIt.spentCents), Number(before.spentCents) + 3000);
    assert.ok(logRecall('masking').length >= 1, 'findable while it is in the book');

    logRemove(entryId, actor);

    const after = logTotals({});
    assert.equal(Number(after.spentCents), Number(before.spentCents),
      'a total that still counted a removed row is the whole failure this guards against');
    assert.equal(logList({}).some((e) => e.id === entryId), false, 'gone from the list');
    assert.equal(logRecall('masking').length, 0, 'and out of the search index');
  });

  test('the row is still there, and the event log says who removed it', () => {
    const events = timelineFor('logbook', entryId, 10);
    const gone = events.find((e) => e.type === 'deleted');
    assert.ok(gone, 'the removal is recorded');
    assert.match(gone.summary ?? '', /Masking tape/,
      'and the log says what it said, not just that something went');
    assert.match(gone.before_json ?? '', /3000/, 'including the amount it was carrying');
  });

  test('it shows up in the bin rather than only being regretted', () => {
    const bin = logRemoved();
    const found = bin.find((e) => e.id === entryId);
    assert.ok(found, 'a removed entry is findable');
    assert.equal(found.deleted_by_name, 'Halima Sørensen');
  });

  test('the spreadsheet stops counting it too', () => {
    const buf = logWorkbook({});
    assert.equal(buf.subarray(0, 2).toString('binary'), 'PK');
    assert.equal(buf.toString('binary').includes('Masking tape'), false,
      'an export that still carried a removed row would contradict the screen');
  });

  test('restoring puts it back, in the list and the total', () => {
    const before = logTotals({});
    logRestore(entryId, actor);
    const after = logTotals({});
    assert.equal(Number(after.spentCents), Number(before.spentCents) + 3000);
    assert.ok(logList({}).some((e) => e.id === entryId), 'back in the list');
    assert.ok(logRecall('masking').length >= 1, 'and back in the search index');
  });

  test('removing twice, or restoring what is not removed, is refused clearly', () => {
    assert.throws(() => logRestore(entryId, actor), /not removed/);
    logRemove(entryId, actor);
    assert.throws(() => logRemove(entryId, actor), /already removed/);
    assert.throws(() => logRemove(randomUUID(), actor), /No such logbook entry/);
    logRestore(entryId, actor); // leave the book as we found it
  });
});


/**
 * The register shipped correct and unusable: nothing created a room, placed a
 * child in one, or set a ratio, so the screen could only ever be empty. This
 * walks the whole journey a director actually has to make, because that is the
 * thing that was never checked.
 */
describe('getting the register working from nothing', () => {
  const DAY = '2026-08-30';
  let director: Awaited<ReturnType<typeof createUser>>;
  let teacher: Awaited<ReturnType<typeof createUser>>;
  let programId: string;
  let roomId: string;
  let childId: string;

  const actor = (u: { id: string }) => ({ type: 'user' as const, id: u.id, source: 'manual' });

  before(async () => {
    const { one: dbOne, run: dbRun } = await import('../packages/server/src/db/index.ts');
    const now = new Date().toISOString();
    director = createUser('setup-dir@test.local', 'Wanjiru Halvorsen', 'director', 'test-pw-1234');
    teacher = createUser('setup-edu@test.local', 'Emeka Lindgren', 'educator', 'test-pw-1234');

    programId = randomUUID();
    dbRun(`INSERT INTO programs (id, slug, name, active, sort_order, created_at)
           VALUES (?,?,?,1,50,?)`, programId, `setup-${programId.slice(0, 8)}`, 'Setup Program', now);

    const fam = randomUUID();
    dbRun('INSERT INTO families (id, name, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      fam, 'Bhattacharya-Lund family', 'enrolled', 'manual', now, now);
    childId = randomUUID();
    dbRun(`INSERT INTO children (id, family_id, first_name, age_band, status, created_at, updated_at)
           VALUES (?,?,?,?,'prospective',?,?)`, childId, fam, 'Ravi', '3-5 years', now, now);
    assert.ok(dbOne('SELECT id FROM children WHERE id = ?', childId));
  });

  test('a child with no room shows up on the list of who still needs one', () => {
    const waiting = unplacedChildren();
    assert.ok(waiting.some((c) => c.id === childId),
      'otherwise nobody knows there is anything to do');
  });

  test('a room needs a name, and a sensible capacity', () => {
    assert.throws(() => createClassroom('   ', {}, actor(director)), /needs a name/);
    assert.throws(() => createClassroom('Willow', { capacity: 0 }, actor(director)), /whole number/);
    assert.throws(() => createClassroom('Willow', { capacity: 2.5 }, actor(director)), /whole number/);
  });

  test('creating a room records it, and the log says so', () => {
    const room = createClassroom('Willow Room', { programId, capacity: 12 }, actor(director));
    roomId = String(room.id);
    assert.equal(room.name, 'Willow Room');
    assert.equal(room.capacity, 12);
    assert.ok(timelineFor('classroom', roomId, 5).some((e) => e.type === 'created'));
  });

  test('placing a child sets the room and the enrolment together', () => {
    // Separately would be a trap: the register only lists enrolled children, so
    // a child placed but not enrolled is invisible and looks like a failure.
    const after = assignChild(childId, { classroomId: roomId, status: 'enrolled' }, actor(director));
    assert.equal(after.classroom_id, roomId);
    assert.equal(after.status, 'enrolled');
    assert.equal(unplacedChildren().some((c) => c.id === childId), false, 'off the waiting list');
  });

  test('the register is no longer empty, which is the whole point', () => {
    const rows = register(director, DAY);
    assert.ok(rows.some((r) => r.child_id === childId),
      'this is the assertion that would have caught shipping it unusable');
  });

  test('a closed room refuses new children rather than hiding them', () => {
    const closed = createClassroom('Closed Room', {}, actor(director));
    updateClassroom(String(closed.id), { active: false }, actor(director));
    assert.throws(
      () => assignChild(childId, { classroomId: String(closed.id) }, actor(director)),
      /room is closed/);
  });

  test('a ratio must be one adult to a whole number of children', () => {
    assert.throws(() => setRatio(programId, 0, null, actor(director)), /whole number/);
    assert.throws(() => setRatio(programId, 4.5, null, actor(director)), /whole number/);
    assert.throws(() => setRatio(randomUUID(), 4, null, actor(director)), /No such program/);
  });

  test('before a ratio exists the room says so; after, it is measured', () => {
    const before = roomStandings(director, DAY).find((r) => r.classroomId === roomId);
    assert.ok(before);
    assert.equal(before.measured, false, 'no rule means not measured, never a green tick');

    setRatio(programId, 8, 'Alberta child care regulation (illustrative)', actor(director));
    assignStaff(roomId, teacher.id, 'lead', actor(director));

    const after = roomStandings(director, DAY).find((r) => r.classroomId === roomId);
    assert.ok(after);
    assert.equal(after.measured, true);
    assert.equal(after.requiredPerStaff, 8);
    assert.equal(after.withinRatio, true, 'nobody checked in yet, so one educator is plenty');
  });

  test('removing the ratio returns the room to not measured', () => {
    assert.equal(clearRatio(programId, actor(director)), true);
    const after = roomStandings(director, DAY).find((r) => r.classroomId === roomId);
    assert.equal(after?.measured, false);
    assert.equal(after?.withinRatio, null, 'and no verdict is invented in its place');
    assert.equal(clearRatio(programId, actor(director)), false, 'clearing twice is not an error');
  });

  test('the educator assigned to the room can now see the child, and still no birthday', () => {
    const rows = register(teacher, DAY);
    assert.deepEqual(rows.map((r) => r.child_id), [childId]);
    assert.equal('date_of_birth' in rows[0]!, false,
      'the set-up path must not have opened a hole in the permission rule');
  });
});

describe('who can be put in a room', () => {
  test('only people who would work with children, and only active ones', async () => {
    const { run: dbRun } = await import('../packages/server/src/db/index.ts');
    const money = createUser('bookkeeper@test.local', 'Nadia Fournier', 'accounting', 'test-pw-1234');
    const viewer = createUser('viewer@test.local', 'Otto Reinholt', 'readonly', 'test-pw-1234');
    const gone = createUser('left@test.local', 'Delphine Aubert', 'educator', 'test-pw-1234');
    dbRun(`UPDATE users SET status = 'suspended' WHERE id = ?`, gone.id);

    const list = assignableStaff();
    const ids = list.map((p) => p.id);

    assert.equal(ids.includes(money.id), false,
      'putting accounting in a room would hand them a register to mark');
    assert.equal(ids.includes(viewer.id), false);
    assert.equal(ids.includes(gone.id), false, 'somebody suspended is not staff');
    assert.ok(list.length > 0, 'and the people who should be there still are');
    assert.equal(list.some((p) => 'email' in p), false,
      'assigning a room does not require knowing how to contact them');
  });
});

// ------------------------------------------------------------ manual entry
//
// The CRM could only ever be filled from the public website or a spreadsheet.
// A daycare enrols children over the phone and at the door, so these cover the
// path a person actually uses.

describe('adding a family by hand', () => {
  const STAFF = { type: 'user' as const, id: null, source: 'manual' };

  test('a child added by hand is searchable, and opens their family', () => {
    const familyId = insertFamily('Sandoval family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Mateo', ageBand: '3-5 years' }, STAFF);

    const row = one<{ family_id: string; first_name: string; status: string }>(
      'SELECT family_id, first_name, status FROM children WHERE id = ?', childId);
    assert.equal(row?.family_id, familyId);
    assert.equal(row?.status, 'prospective');

    const hit = search('Mateo').find((h) => h.entity_type === 'child');
    assert.ok(hit, 'a hand-added child must be findable straight away');
    assert.equal(hit.family_id, familyId, 'and must open the family, not a list');
  });

  test('the family row is reindexed too, so the surname finds it', () => {
    const familyId = insertFamily('Bergstrom family', 'manual', null, STAFF);
    addGuardian(familyId, { fullName: 'Annika Bergstrom', email: 'annika@example.invalid' }, STAFF);
    assert.ok(search('Bergstrom').some((h) => h.entity_id === familyId));
  });

  test('every hand-made record lands in the append-only log', () => {
    const familyId = insertFamily('Okafor family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Zuri' }, STAFF);
    const events = many<{ type: string; summary: string }>(
      "SELECT type, summary FROM events WHERE entity_id = ?", childId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'created');
    assert.match(events[0]!.summary, /Zuri/);
  });

  test('a person may correct a value the website may only fill', () => {
    // The inbound path COALESCEs so a re-submitted form cannot blank a detail
    // staff fixed. A person typing is doing the fixing, so they overwrite.
    const familyId = insertFamily('Haddad family', 'manual', null, STAFF);
    const gid = addGuardian(familyId, { fullName: 'Rami Haddad', phone: '780-555-0111' }, STAFF);

    updateGuardian(gid, { phone: '780-555-0999' }, STAFF);
    const after = one<{ phone: string; phone_norm: string }>(
      'SELECT phone, phone_norm FROM guardians WHERE id = ?', gid);
    assert.equal(after?.phone, '780-555-0999');
    // The normalised column has to move with it or dedupe silently rots.
    assert.ok(after?.phone_norm?.includes('7805550999'));
  });

  test('promoting a guardian to primary demotes the previous one', () => {
    const familyId = insertFamily('Iversen family', 'manual', null, STAFF);
    const first = addGuardian(familyId, { fullName: 'Nora Iversen', email: 'nora@example.invalid' }, STAFF);
    const second = addGuardian(familyId, { fullName: 'Jonas Iversen', email: 'jonas@example.invalid' }, STAFF);

    updateGuardian(second, { isPrimary: true }, STAFF);
    const primaries = many<{ id: string }>(
      'SELECT id FROM guardians WHERE family_id = ? AND is_primary = 1', familyId);
    assert.deepEqual(primaries.map((p) => p.id), [second]);
    assert.notEqual(first, second);
  });

  test('editing the date of birth re-derives the age band', () => {
    const familyId = insertFamily('Petrov family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Lena', ageBand: 'Under 12 months' }, STAFF);

    const fourYearsAgo = new Date();
    fourYearsAgo.setFullYear(fourYearsAgo.getFullYear() - 4);
    updateChild(childId, { dateOfBirth: fourYearsAgo.toISOString().slice(0, 10) }, STAFF);

    const after = one<{ age_band: string }>('SELECT age_band FROM children WHERE id = ?', childId);
    assert.equal(after?.age_band, '3-5 years',
      'a stale band next to a real birthday is how a child ends up in the wrong room');
  });

  test('an explicit band still wins over the derived one', () => {
    const familyId = insertFamily('Nakagawa family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Haru' }, STAFF);
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);

    updateChild(childId, {
      dateOfBirth: twoYearsAgo.toISOString().slice(0, 10),
      ageBand: '3-5 years',
    }, STAFF);
    const after = one<{ age_band: string }>('SELECT age_band FROM children WHERE id = ?', childId);
    assert.equal(after?.age_band, '3-5 years');
  });
});

describe('working out an age band from a birthday', () => {
  const on = (isoBirth: string, isoWhen: string) => ageBandFor(isoBirth, new Date(isoWhen));

  test('the boundaries land on the right side', () => {
    // A child is 11 months old until the day they are 12 months old.
    assert.equal(on('2026-01-15', '2026-12-14'), 'Under 12 months');
    assert.equal(on('2026-01-15', '2027-01-15'), '12-18 months');
    assert.equal(on('2026-01-15', '2027-07-15'), '18 months - 3 years');
    assert.equal(on('2026-01-15', '2029-01-15'), '3-5 years');
    assert.equal(on('2026-01-15', '2031-01-15'), '5-6 years');
    assert.equal(on('2026-01-15', '2032-01-15'), '6-12 years');
  });

  test('a child too old for any band is null, not squeezed into the last one', () => {
    assert.equal(on('2026-01-15', '2040-01-15'), null);
  });

  test('nothing to go on, or a date in the future, is null rather than a guess', () => {
    assert.equal(ageBandFor(null), null);
    assert.equal(ageBandFor(undefined), null);
    assert.equal(ageBandFor('not a date'), null);
    assert.equal(on('2030-01-15', '2026-01-15'), null);
  });

  test('the age reads the way a person would say it', () => {
    assert.equal(ageLabel('2026-01-15', new Date('2026-07-15')), '6 months');
    assert.equal(ageLabel('2026-01-15', new Date('2027-01-15')), '12 months');
    assert.equal(ageLabel('2026-01-15', new Date('2029-01-15')), '3 years');
    assert.equal(ageLabel('2026-01-15', new Date('2027-02-15')), '13 months');
    assert.equal(monthsBetween('2026-01-15', new Date('2026-01-14')), -1);
  });
});

// ------------------------------------------------------------- reading xlsx
//
// A centre's roll of two or three hundred children lives in Excel, not in CSV.
// "Save as CSV first" loses every tab but one and lets Excel reformat dates on
// the way out, so the importer reads the .xlsx itself. These are the cases that
// actually bite.

describe('reading a real .xlsx', () => {
  const book = (rows: Record<string, unknown>[], extra: unknown[] = []) => buildWorkbook([
    {
      name: 'Roll', accent: 'teal',
      columns: [
        { header: 'First name', key: 'first', format: 'text' },
        { header: 'Last name', key: 'last', format: 'text' },
        { header: 'Date of birth', key: 'dob', format: 'date' },
        { header: 'Fee', key: 'fee', format: 'money' },
      ],
      rows: rows as never,
    },
    ...(extra as never[]),
  ]);

  test('a workbook written here reads back with its values intact', () => {
    const buf = book([{ first: 'Chidi', last: 'Okonkwo', dob: '2022-03-14', fee: 425.5 }]);
    const [sheet] = readXlsx(buf);
    assert.equal(sheet!.name, 'Roll');
    assert.deepEqual(sheet!.rows[0], ['First name', 'Last name', 'Date of birth', 'Fee']);
    assert.deepEqual(sheet!.rows[1], ['Chidi', 'Okonkwo', '2022-03-14', '425.5']);
  });

  test('a date comes back as a date, not as the number Excel stores', () => {
    // This is the one that matters. Excel keeps 2022-03-14 as 44634 and
    // remembers it was a date only in the cell format; read naively, every
    // birthday in the file imports as a five-digit number that validates fine.
    const [sheet] = readXlsx(book([{ first: 'Aiko', dob: '2024-11-02' }]));
    assert.equal(sheet!.rows[1]![2], '2024-11-02');
  });

  test('the epoch is right, including Excel’s imaginary 29 February 1900', () => {
    assert.equal(fromExcelSerial(1), '1900-01-01');
    assert.equal(fromExcelSerial(59), '1900-02-28');
    // 60 is 29 Feb 1900, a day that never existed. 61 must still be 1 March.
    assert.equal(fromExcelSerial(61), '1900-03-01');
    assert.equal(fromExcelSerial(44634), '2022-03-14');
    assert.equal(fromExcelSerial(0), null);
    assert.equal(fromExcelSerial(-5), null);
  });

  test('escaped characters in a name survive the round trip', () => {
    const [sheet] = readXlsx(book([{ first: "O'Brien & Sons", last: '<Ali> "The" One' }]));
    assert.equal(sheet!.rows[1]![0], "O'Brien & Sons");
    assert.equal(sheet!.rows[1]![1], '<Ali> "The" One');
  });

  test('every tab is read, in the order Excel shows them', () => {
    const buf = book([{ first: 'Chidi' }], [
      { name: 'Waitlist', accent: 'amber', columns: [{ header: 'Note', key: 'n', format: 'text' }],
        rows: [{ n: 'second tab' }] },
      { name: 'Staff', accent: 'rose', columns: [{ header: 'Who', key: 'w', format: 'text' }],
        rows: [{ w: 'third tab' }] },
    ]);
    const sheets = readXlsx(buf);
    assert.deepEqual(sheets.map((s) => s.name), ['Roll', 'Waitlist', 'Staff']);
    assert.equal(sheets[1]!.rows[1]![0], 'second tab');
  });

  test('the import wizard sees an .xlsx exactly as it sees a CSV', () => {
    const buf = book([
      { first: 'Chidi', last: 'Okonkwo', dob: '2022-03-14' },
      { first: 'Aiko', last: 'Nakamura', dob: '2024-11-02' },
    ]);
    const t = parseTabular({ xlsxBase64: buf.toString('base64') });
    assert.deepEqual(t.headers, ['First name', 'Last name', 'Date of birth', 'Fee']);
    assert.equal(t.rows.length, 2, 'the header row must not be counted as a record');
    assert.deepEqual(t.sheetNames, ['Roll']);
    assert.equal(t.sheet, 'Roll');
  });

  test('a named tab can be chosen, and an unknown name falls back to the first', () => {
    const buf = book([{ first: 'Chidi' }], [
      { name: 'Waitlist', accent: 'amber', columns: [{ header: 'Note', key: 'n', format: 'text' }],
        rows: [{ n: 'on the list' }] },
    ]);
    const b64 = buf.toString('base64');
    assert.equal(parseTabular({ xlsxBase64: b64, sheet: 'Waitlist' }).rows[0]![0], 'on the list');
    assert.equal(parseTabular({ xlsxBase64: b64, sheet: 'Nope' }).sheet, 'Roll');
  });

  test('something that is not a spreadsheet is refused with advice, not a stack trace', () => {
    assert.equal(looksLikeXlsx(Buffer.from('first,last\na,b')), false);
    assert.throws(
      () => parseTabular({ xlsxBase64: Buffer.from('not a zip at all').toString('base64') }),
      /does not look like an \.xlsx/);
    // An .xls (the old binary format) is a common and confusing case.
    assert.throws(() => parseTabular({}), /Send a CSV/);
  });

  test('a formula is never evaluated; only its cached value is read', () => {
    // Imported spreadsheets are untrusted. Running someone else's formula is
    // how a spreadsheet turns into code execution.
    const sheetXml = `<worksheet><sheetData><row r="1">
      <c r="A1" t="str"><f>1+1</f><v>2</v></c>
      <c r="B1"><f>HYPERLINK("http://x")</f></c>
    </row></sheetData></worksheet>`;
    assert.match(sheetXml, /<f>/);
    // The reader only ever looks at <v>, so B1 (no cached value) is empty.
    const rows = readSheet(sheetXml);
    assert.deepEqual(rows[0], ['2', '']);
  });
});

// ------------------------------------------------------- growing up
//
// The distinction these protect: an age band is a fact about a birthday and is
// corrected automatically; a room is a decision and is only ever reported.

describe('children growing into the next room', () => {
  const STAFF = { type: 'user' as const, id: null, source: 'manual' };
  const yearsAgo = (y: number, months = 0) => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - y);
    d.setMonth(d.getMonth() - months);
    return d.toISOString().slice(0, 10);
  };
  const programId = (slug: string) =>
    one<{ id: string }>('SELECT id FROM programs WHERE slug = ?', slug)!.id;

  test('a stale age band is corrected from the date of birth', () => {
    const familyId = insertFamily('Adeyemi family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Tayo', ageBand: 'Under 12 months' }, STAFF);
    // Set a birthday directly, leaving the band wrong, exactly as a real record
    // drifts: correct on the day it was typed, stale a year later.
    execSql('UPDATE children SET date_of_birth = ? WHERE id = ?', yearsAgo(4), childId);

    const changed = refreshAgeBands(STAFF);
    assert.ok(changed.some((c) => c.childId === childId && c.to === '3-5 years'));
    assert.equal(
      one<{ age_band: string }>('SELECT age_band FROM children WHERE id = ?', childId)?.age_band,
      '3-5 years');
  });

  test('correcting a band is written to the append-only log', () => {
    const familyId = insertFamily('Kowalski family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Ida', ageBand: '12-18 months' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ? WHERE id = ?', yearsAgo(5, 1), childId);
    refreshAgeBands(STAFF);

    const summaries = many<{ summary: string }>(
      "SELECT summary FROM events WHERE entity_id = ? AND type = 'updated'", childId);
    assert.ok(summaries.some((e) => /Ida moved from 12-18 months to 5-6 years/.test(e.summary)),
      `no band-change event found, got: ${summaries.map((e) => e.summary).join(' | ')}`);
  });

  test('a child with no birthday keeps the band a person typed', () => {
    const familyId = insertFamily('Moreau family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Elise', ageBand: '18 months - 3 years' }, STAFF);
    refreshAgeBands(STAFF);
    assert.equal(
      one<{ age_band: string }>('SELECT age_band FROM children WHERE id = ?', childId)?.age_band,
      '18 months - 3 years', 'a guess must not overwrite the only information there is');
  });

  test('a child past their room shows up, with the room that fits and why', () => {
    const familyId = insertFamily('Novak family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Petra' }, STAFF);
    // Four years old, still in the 18 months - 3 years room.
    execSql('UPDATE children SET date_of_birth = ?, status = ?, program_id = ? WHERE id = ?',
      yearsAgo(4), 'enrolled', programId('comet-stars'), childId);

    const row = outgrown().find((o) => o.childId === childId);
    assert.ok(row, 'a four-year-old in the toddler room must be flagged');
    assert.equal(row.currentProgram, 'Comet Stars');
    assert.equal(row.suggestedProgram, 'Nova Stars');
    assert.match(row.reason, /4 years old/);
  });

  test('nobody is moved: the flag is a report, not an action', () => {
    const familyId = insertFamily('Bianchi family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Luca' }, STAFF);
    const comet = programId('comet-stars');
    execSql('UPDATE children SET date_of_birth = ?, status = ?, program_id = ? WHERE id = ?',
      yearsAgo(4), 'enrolled', comet, childId);

    outgrown();
    refreshAgeBands(STAFF);
    assert.equal(
      one<{ program_id: string }>('SELECT program_id FROM children WHERE id = ?', childId)?.program_id,
      comet, 'moving a child depends on space, ratios and their parents — never do it silently');
  });

  test('the boundary is inclusive at the bottom and exclusive at the top', () => {
    const familyId = insertFamily('Rossi family', 'manual', null, STAFF);
    const child = addChild(familyId, { firstName: 'Gia' }, STAFF);
    const comet = programId('comet-stars');   // 18 to 36 months

    // Exactly 36 months: past Comet Stars, so flagged.
    execSql('UPDATE children SET date_of_birth = ?, status = ?, program_id = ? WHERE id = ?',
      yearsAgo(3), 'enrolled', comet, child);
    assert.ok(outgrown().some((o) => o.childId === child), '36 months is out of an 18-36 room');

    // A month short of three: still in the room, so not flagged.
    execSql('UPDATE children SET date_of_birth = ? WHERE id = ?', yearsAgo(2, 11), child);
    assert.equal(outgrown().some((o) => o.childId === child), false);
  });

  test('a prospective child is not "outgrown" — they have not been placed', () => {
    const familyId = insertFamily('Ferrand family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Colette' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, program_id = ? WHERE id = ?',
      yearsAgo(5), programId('comet-stars'), childId);
    assert.equal(outgrown().some((o) => o.childId === childId), false);
  });

  test('an upcoming birthday is found, and the year wrap does not break it', () => {
    // Fixed dates, not "five days from now": this machine is UTC+5, so at two
    // in the morning "today" locally is still yesterday in UTC and a relative
    // test drifts by a day depending on the hour it runs.
    const familyId = insertFamily('Andersen family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Freja' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ? WHERE id = ?',
      '2023-09-08', 'enrolled', childId);

    const hit = upcomingBirthdays(14, new Date('2026-09-03T12:00:00Z'))
      .find((b) => b.childId === childId);
    assert.ok(hit, 'a birthday five days away must appear in a fortnight view');
    assert.equal(hit.inDays, 5);
    assert.equal(hit.turning, 3);
    assert.equal(hit.date, '2026-09-08');
  });

  test('a birthday in January is found from December, not missed for a year', () => {
    const familyId = insertFamily('Lindgren family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Alva' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ? WHERE id = ?',
      '2024-01-02', 'enrolled', childId);

    const hit = upcomingBirthdays(14, new Date('2026-12-28T12:00:00Z'))
      .find((b) => b.childId === childId);
    assert.ok(hit, 'comparing dates rather than month-and-day loses every new-year birthday');
    assert.equal(hit.date, '2027-01-02');
    assert.equal(hit.inDays, 5);
    assert.equal(hit.turning, 3);
  });

  test('the summary says which rooms still have no age range set', () => {
    const s = progressionSummary();
    assert.ok(Array.isArray(s.outgrown));
    assert.ok(Array.isArray(s.birthdays));
    // Every program Tiny Stars actually runs has bounds. Programs created by
    // other tests in this file deliberately have none, and showing up here is
    // the feature working: a room with no age range is reported, not guessed at.
    const named = (s.programsWithoutAges as { name: string }[]).map((p) => p.name);
    for (const real of ['Twinkle Stars', 'Comet Stars', 'Nova Stars', 'Galaxy Stars', 'Cosmic Stars']) {
      assert.equal(named.includes(real), false, `${real} should have an age range seeded`);
    }
  });
});

describe('moving a child up, by room', () => {
  const STAFF = { type: 'user' as const, id: null, source: 'manual' };
  const yearsAgo = (y: number) => {
    const d = new Date(); d.setFullYear(d.getFullYear() - y);
    return d.toISOString().slice(0, 10);
  };
  const programId = (slug: string) =>
    one<{ id: string }>('SELECT id FROM programs WHERE slug = ?', slug)!.id;

  test('the room a child sits in wins over the program somebody recorded', () => {
    // A child placed in a Comet Stars room but with nova-stars still on their
    // record. Their actual room is the truth, so at four they are fine.
    const comet = createClassroom('Comets A', { programId: programId('comet-stars'), capacity: 10 }, STAFF);
    const familyId = insertFamily('Duarte family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Ines' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ?, program_id = ?, classroom_id = ? WHERE id = ?',
      yearsAgo(4), 'enrolled', programId('nova-stars'), String(comet.id), childId);

    const row = outgrown().find((o) => o.childId === childId);
    assert.ok(row, 'the room says Comet Stars, and a four-year-old has outgrown it');
    assert.equal(row.currentProgram, 'Comet Stars');
  });

  test('the suggestion names a real room, and moving puts the child in it', () => {
    const comet = createClassroom('Comets B', { programId: programId('comet-stars'), capacity: 10 }, STAFF);
    const nova = createClassroom('Novas B', { programId: programId('nova-stars'), capacity: 12 }, STAFF);
    const familyId = insertFamily('Halim family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Sami' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ?, classroom_id = ? WHERE id = ?',
      yearsAgo(4), 'enrolled', String(comet.id), childId);

    const row = outgrown().find((o) => o.childId === childId);
    assert.ok(row);
    assert.equal(row.suggestedProgram, 'Nova Stars');
    assert.ok(row.suggestedClassroomId, 'a suggestion with no room to move into is not actionable');

    assignChild(childId, { classroomId: row.suggestedClassroomId! }, STAFF);
    const after = one<{ classroom_id: string; program_id: string }>(
      'SELECT classroom_id, program_id FROM children WHERE id = ?', childId);
    assert.equal(after?.classroom_id, String(nova.id));
    // The whole reason the program follows the room: otherwise the two
    // disagree the first time anybody is moved.
    assert.equal(after?.program_id, programId('nova-stars'));
    assert.equal(outgrown().some((o) => o.childId === childId), false);
  });

  test('a program with no open room is reported honestly, not silently skipped', () => {
    const galaxy = createClassroom('Galaxy Z', { programId: programId('galaxy-stars'), capacity: 8 }, STAFF);
    updateClassroom(String(galaxy.id), { active: false }, STAFF);

    const familyId = insertFamily('Terzi family', 'manual', null, STAFF);
    const childId = addChild(familyId, { firstName: 'Deniz' }, STAFF);
    const room = createClassroom('Novas C', { programId: programId('nova-stars'), capacity: 5 }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ?, classroom_id = ? WHERE id = ?',
      yearsAgo(5), 'enrolled', String(room.id), childId);

    const row = outgrown().find((o) => o.childId === childId);
    assert.ok(row);
    assert.equal(row.suggestedProgram, 'Galaxy Stars');
    assert.equal(row.suggestedClassroomId, null, 'the only Galaxy room is closed');
    assert.match(row.reason, /no open room yet/);
  });
});

// ------------------------------------------------------- colourful exports
//
// A CSV is right for feeding another system. This is the file somebody prints
// and points at in a meeting, so it has to be a real workbook — and it has to
// obey the same permission rules the screens do.

describe('exporting a spreadsheet people can read', () => {
  test('the families export is a real workbook with a sheet per question', () => {
    const buf = familiesWorkbook({ sensitive: true });
    assert.ok(looksLikeXlsx(buf));
    const names = readXlsx(buf).map((s) => s.name);
    assert.deepEqual(names, ['Overview', 'Families', 'Children', 'Guardians']);
  });

  test('a date of birth is dropped for roles that cannot see one, not blanked', () => {
    // Blanking leaves the column in the file, and a column that is there can be
    // un-hidden. The header must not exist at all.
    const withDob = readXlsx(familiesWorkbook({ sensitive: true }))
      .find((s) => s.name === 'Children')!;
    const without = readXlsx(familiesWorkbook({ sensitive: false }))
      .find((s) => s.name === 'Children')!;

    assert.ok(withDob.rows.some((r) => r.includes('Date of birth')));
    assert.equal(without.rows.some((r) => r.includes('Date of birth')), false);
    assert.ok(without.rows.some((r) => r.some((cell) => /not included in this export/.test(cell))
      || r.includes('Age group')));
  });

  test('the overview counts match the rows in the sheets behind it', () => {
    const sheets = readXlsx(familiesWorkbook({ sensitive: true }));
    const overview = sheets.find((s) => s.name === 'Overview')!;
    const familiesSheet = sheets.find((s) => s.name === 'Families')!;

    const stated = overview.rows.find((r) => r[0] === 'Families')?.[1];
    const counts = exportCounts();
    assert.equal(Number(stated), counts.families,
      'a summary that disagrees with the sheet behind it is worse than no summary');
    // Header, then one row per family, then the totals row.
    assert.ok(familiesSheet.rows.length >= counts.families + 1);
  });

  test('a name that starts like a formula cannot execute in Excel', () => {
    // "=cmd|' /c calc'!A1" in a spreadsheet is a real attack, and a child
    // called "-Ana" trips the same rule.
    assert.equal(deFormula('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(deFormula('-Ana'), "'-Ana");
    assert.equal(deFormula('+1 780 555 0100'), "'+1 780 555 0100");
    assert.equal(deFormula('@handle'), "'@handle");
    // Excel strips leading whitespace before deciding, so a tab still counts.
    assert.equal(deFormula('\t=cmd'), "'\t=cmd");
    assert.equal(deFormula('Ngozi Okonkwo'), 'Ngozi Okonkwo');
    assert.equal(deFormula(null), null);
  });

  test('the admissions workbook carries no child names', () => {
    const sheets = readXlsx(admissionsWorkbook());
    assert.deepEqual(sheets.map((s) => s.name),
      ['Funnel', 'Where they came from', 'Tours', 'Registrations', 'Waitlist']);
    // Family names appear, which is the point; a child's first name must not.
    const everything = sheets.flatMap((s) => s.rows.flat()).join(' | ');
    assert.equal(/\bChidi\b/.test(everything), false,
      'this file goes into meetings — it should not identify children');
  });
});

// ------------------------------------------------------------------- help
//
// The Help is the only support channel the person running the daycare has.
// These guard the things that would quietly rot it: a broken cross-reference,
// a topic filed under a section that no longer exists, or a search that cannot
// find the answer to the most ordinary question somebody will type.

describe('the built-in guide', () => {
  test('every topic is complete enough to be worth showing', () => {
    for (const t of HELP) {
      assert.ok(t.id && /^[a-z0-9-]+$/.test(t.id), `bad id: ${t.id}`);
      assert.ok(t.title.length > 3, `${t.id} needs a title`);
      assert.ok(t.summary.length > 10, `${t.id} needs a real summary`);
      assert.ok(t.body.length > 0, `${t.id} has no body`);
      assert.ok((HELP_SECTIONS as readonly string[]).includes(t.section),
        `${t.id} is filed under "${t.section}", which is not a section`);
    }
  });

  test('topic ids are unique', () => {
    const ids = HELP.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'two topics share an id');
  });

  test('every "see also" points at a topic that exists', () => {
    const ids = new Set(HELP.map((t) => t.id));
    for (const t of HELP) {
      for (const r of t.related ?? []) {
        assert.ok(ids.has(r), `${t.id} links to "${r}", which does not exist`);
      }
    }
  });

  test('every section has at least one topic in it', () => {
    for (const section of HELP_SECTIONS) {
      assert.ok(HELP.some((t) => t.section === section), `"${section}" is empty`);
    }
  });

  test('the questions people will actually type find the right topic', () => {
    // If one of these breaks, the guide has drifted from the software and the
    // person on the other end gets a wrong answer with no way to know.
    const expectations: [string, string][] = [
      ['how do I add a child', 'add-a-family'],
      ['import excel spreadsheet', 'importing-a-spreadsheet'],
      ['check in attendance', 'the-register'],
      ['what can an educator see', 'who-can-see-what'],
      ['export to excel', 'exports'],
      ['grocery expenses receipt', 'the-logbook'],
      ['child moving to the next room', 'moving-up-a-room'],
      ['instagram whatsapp facebook', 'not-built-yet'],
      ['forgot my password', 'signing-in'],
      ['backup restore', 'backups'],
      ['does it use ai', 'ai-what-it-does'],
      ['something is broken', 'something-went-wrong'],
    ];
    for (const [question, expected] of expectations) {
      const hits = searchHelp(question, 4).map((t) => t.id);
      assert.ok(hits.includes(expected),
        `"${question}" should find ${expected}, found: ${hits.join(', ') || 'nothing'}`);
    }
  });

  test('a question about nothing returns nothing rather than a wrong guess', () => {
    assert.deepEqual(searchHelp('zzzzq'), []);
    assert.deepEqual(searchHelp(''), []);
    assert.deepEqual(searchHelp('!!! ???'), []);
  });

  test('the AI is given the guide text and nothing else', () => {
    const context = topicsAsContext(searchHelp('how do I add a child', 2));
    assert.ok(context.includes('Add'), 'the matched topic should be in the context');
    // What must NOT be in there: anything from the database. The context is
    // built purely from these static topics, so a family name appearing would
    // mean somebody wired real records into it.
    assert.equal(/Whitfield|Okonkwo|@example\.invalid/.test(context), false,
      'help context must never carry family data');
  });

  test('the guide states what is not built, so nobody hunts for it', () => {
    const missing = HELP.find((t) => t.id === 'not-built-yet');
    assert.ok(missing);
    const text = [...missing.body, ...(missing.notes ?? [])].join(' ').toLowerCase();
    for (const gap of ['instagram', 'billing', 'incident', 'staff']) {
      assert.ok(text.includes(gap), `the "not built" topic should mention ${gap}`);
    }
  });
});


// -------------------------------------------------------- accounts & Lillio

describe('managing your own account', () => {
  test('a Lillio export maps its columns without anybody doing it by hand', () => {
    // The real header names from Lillio's Child Profile Report. If this breaks,
    // somebody has to map twelve columns by hand every time they migrate.
    const headers = [
      'Student First Name', 'Student Last Name', 'Student Date of Birth',
      'Classroom Name', 'Primary Contact', 'Primary Contact Email',
      'Primary Contact Phone', 'Enrollment Start Date', 'Student Status',
    ];
    const m = guessMapping(headers);
    assert.equal(m.childFirstName, 0);
    assert.equal(m.childLastName, 1);
    assert.equal(m.childDob, 2);
    assert.equal(m.program, 3);
    assert.equal(m.guardianName, 4);
    assert.equal(m.guardianEmail, 5);
    assert.equal(m.guardianPhone, 6);
    assert.equal(m.desiredStart, 7);
    assert.equal(m.status, 8);
  });

  test('changing your own password needs the current one', () => {
    const u = createUserAuth('pw-test@example.invalid', 'Pw Test', 'director', 'first-password-here');
    assert.throws(() => changeOwnPassword(u.id, 'wrong-one-entirely', 'second-password-here'),
      /not your current password/);
    // An unlocked screen must not be a permanent account takeover.
    assert.ok(login('pw-test@example.invalid', 'first-password-here'), 'password should be unchanged');
  });

  test('a new password has to be long enough, and actually new', () => {
    const u = createUserAuth('pw2@example.invalid', 'Pw Two', 'director', 'first-password-here');
    assert.throws(() => changeOwnPassword(u.id, 'first-password-here', 'short'), /at least 12/);
    assert.throws(() => changeOwnPassword(u.id, 'first-password-here', 'first-password-here'),
      /already have/);
  });

  test('changing it works, and signs the other devices out', () => {
    const u = createUserAuth('pw3@example.invalid', 'Pw Three', 'director', 'first-password-here');
    const a = login('pw3@example.invalid', 'first-password-here');
    const b = login('pw3@example.invalid', 'first-password-here');
    assert.ok(a && b);

    const r = changeOwnPassword(u.id, 'first-password-here', 'second-password-here', a.token);
    assert.equal(r.signedOut, 1, 'the other device should be signed out, this one kept');
    assert.ok(userForToken(a.token), 'signing somebody out of the screen they are using is hostile');
    assert.equal(userForToken(b.token), null);
    assert.ok(login('pw3@example.invalid', 'second-password-here'));
    assert.equal(login('pw3@example.invalid', 'first-password-here'), null);
  });

  test("a manager's reset ends every session of that account", () => {
    const u = createUserAuth('pw4@example.invalid', 'Pw Four', 'educator', 'first-password-here');
    const s = login('pw4@example.invalid', 'first-password-here');
    assert.ok(s);
    resetPasswordFor(u.id, 'manager-set-this-one');
    assert.equal(userForToken(s.token), null, 'a forgotten password means the old sessions go');
    assert.ok(login('pw4@example.invalid', 'manager-set-this-one'));
  });

  test('suspending somebody signs them out immediately', () => {
    const u = createUserAuth('pw5@example.invalid', 'Pw Five', 'educator', 'first-password-here');
    const s = login('pw5@example.invalid', 'first-password-here');
    assert.ok(s);
    setUserStatus(u.id, 'suspended');
    assert.equal(userForToken(s.token), null,
      'suspending does nothing until the browser closes, otherwise');
    assert.equal(login('pw5@example.invalid', 'first-password-here'), null);
  });

  test('the role list is read from the capability map, not typed out twice', () => {
    assert.deepEqual([...ROLE_NAMES].sort(),
      ['accounting', 'admissions', 'director', 'educator', 'owner', 'readonly']);
  });
});

describe('the logbook reads money the way people write it', () => {
  test('currency after the number, not only before', () => {
    // "50 usd" fell through to the bare-decimal rule and read as a different
    // number entirely. Found in real data on the live system.
    assert.equal(parseMoney('i bought 50 usd milk from store'), 5000);
    assert.equal(parseMoney('spent 40 cad on gas'), 4000);
    assert.equal(parseMoney('12 dollars of glue'), 1200);
    assert.equal(parseMoney('$84.32 at Costco'), 8432);
  });

  test('money named without a buying word is still a purchase', () => {
    // "I put fuel in the car, $60" was filed as a note, which left it out of
    // every total without saying so.
    const d = parseUtterance('i put feul in car $60', '2026-09-03');
    assert.equal(d.kind, 'purchase');
    assert.equal(d.amountCents, 6000);
  });

  test('a quantity is still not money, and a job is still a job', () => {
    assert.equal(parseUtterance('2 boxes of gloves', '2026-09-03').kind, 'note');
    assert.equal(parseUtterance('fixed the gate', '2026-09-03').kind, 'task');
    assert.equal(parseUtterance('ran out of wipes', '2026-09-03').kind, 'supply');
  });

  test('with no AI, one sentence is one entry and the rules still hold', async () => {
    const r = await splitUtterance('i put feul in car $60', '2026-09-03', null);
    assert.equal(r.splitBy, 'rules');
    assert.equal(r.drafts.length, 1);
    assert.equal(r.drafts[0]?.kind, 'purchase');
    assert.equal(r.drafts[0]?.amountCents, 6000);
  });

  test('a model that returns nothing usable falls back rather than losing the entry', async () => {
    const dud = { name: 'stub', complete: async () => 'I am afraid I cannot do that.' };
    const r = await splitUtterance('bought milk $12', '2026-09-03', dud);
    assert.equal(r.splitBy, 'rules');
    assert.equal(r.drafts.length, 1);
    assert.equal(r.drafts[0]?.amountCents, 1200);
  });

  test('the model splits, but the rules still decide what the numbers mean', async () => {
    const ai = {
      name: 'stub',
      complete: async () => `[{"summary":"milk","amount":"$12","vendor":"Costco","date":"september 2 2026"},
                             {"summary":"nappies","amount":"$30","vendor":"Costco","date":"september 2 2026"}]`,
    };
    const r = await splitUtterance(
      'i bought milk for $12 and nappies for $30 at Costco on september 2 2026', '2026-09-03', ai);
    assert.equal(r.splitBy, 'ai');
    assert.equal(r.drafts.length, 2);
    assert.equal(r.drafts[0]?.amountCents, 1200);
    assert.equal(r.drafts[1]?.amountCents, 3000);
    // The date was named once for the whole sentence and applies to both.
    assert.equal(r.drafts[0]?.happenedOn, '2026-09-02');
    assert.equal(r.drafts[1]?.happenedOn, '2026-09-02');
    assert.equal(r.drafts[0]?.vendor, 'Costco');
  });
});

describe('where every child should go', () => {
  const STAFF = { type: 'user' as const, id: null, source: 'manual' };
  const yearsAgo = (y: number) => {
    const d = new Date(); d.setFullYear(d.getFullYear() - y);
    return d.toISOString().slice(0, 10);
  };

  test('a child with no birthday is reported, never guessed at', () => {
    const fid = insertFamily('Placement family', 'manual', null, STAFF);
    const cid = addChild(fid, { firstName: 'NoDob' }, STAFF);
    const row = placementPlan().find((r) => r.childId === cid);
    assert.ok(row);
    assert.equal(row.verdict, 'no-birthday');
    assert.equal(row.shouldBeRoom, null, 'guessing a room for a child is exactly the wrong guess');
  });

  test('an unplaced child is told which room fits', () => {
    const pid = one<{ id: string }>("SELECT id FROM programs WHERE slug='nova-stars'")!.id;
    createClassroom('Placement Nova', { programId: pid, capacity: 10 }, STAFF);
    const fid = insertFamily('Unplaced family', 'manual', null, STAFF);
    const cid = addChild(fid, { firstName: 'Needsroom' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ? WHERE id = ?',
      yearsAgo(4), 'enrolled', cid);

    const row = placementPlan().find((r) => r.childId === cid);
    assert.ok(row);
    assert.equal(row.verdict, 'unplaced');
    assert.equal(row.shouldBeProgram, 'Nova Stars');
    assert.ok(row.shouldBeRoomId);
  });

  test('a child already in the right room is shown as correct, not hidden', () => {
    const pid = one<{ id: string }>("SELECT id FROM programs WHERE slug='nova-stars'")!.id;
    const room = createClassroom('Placement Nova 2', { programId: pid, capacity: 10 }, STAFF);
    const fid = insertFamily('Correct family', 'manual', null, STAFF);
    const cid = addChild(fid, { firstName: 'Rightplace' }, STAFF);
    execSql('UPDATE children SET date_of_birth = ?, status = ?, classroom_id = ? WHERE id = ?',
      yearsAgo(4), 'enrolled', String(room.id), cid);

    const row = placementPlan().find((r) => r.childId === cid);
    assert.ok(row, '"everyone is fine" is only believable if the fine ones are shown');
    assert.equal(row.verdict, 'correct');
  });
});

describe("Lillio's own export, as the centre actually has it", () => {
  // Rebuilt from the real Tiny_Stars_Active_enrollment_Report.xlsx: a paired
  // <sheet></sheet> element, no sharedStrings, inline strings, and a roster
  // with no parents in it.
  const HEADERS = ['First Name', 'Last Name', 'Date of Birth', 'Classroom',
                   'Enroll Date', 'Grad Date', 'Rotation', 'Schedule'];

  test('every column the report carries is recognised', () => {
    const m = guessMapping(HEADERS);
    assert.equal(m.childFirstName, 0);
    assert.equal(m.childLastName, 1);
    assert.equal(m.childDob, 2);
    assert.equal(m.program, 3);
    assert.equal(m.desiredStart, 4, '"Enroll Date" should map, not be left over');
  });

  test('a roster with no parents imports rather than being refused wholesale', () => {
    const rows = [
      ['Quinn', 'Abel', '2025-05-18', 'Blue Twinkle Stars', '2026-05-01', '', 'Day', 'MTWRF'],
      ['Oslo', 'Buick', '2025-08-23', 'Blue Twinkle Stars', '2026-09-01', '', 'Day', 'MTWRF'],
    ];
    const tab = { headers: HEADERS, rows, truncated: false };
    const view = previewImport(tab, guessMapping(HEADERS));
    assert.equal(view.willCreate, 2);
    assert.equal(view.willSkip, 0);
    assert.equal(view.issues.filter((i) => i.severity === 'error').length, 0);

    const res = commitImport(tab, guessMapping(HEADERS), actorFor({ id: 'imp' }), 'Lillio');
    assert.equal(res.created, 2);

    // Named from the child, because there is no parent to name it after.
    const fam = one<{ name: string }>("SELECT name FROM families WHERE name LIKE '%Abel%'");
    assert.ok(fam, 'a family should be created and named from the child');

    // The birthday survives as a real date, and the age group is derived from
    // it at import rather than staying blank until the nightly sweep.
    const child = one<{ date_of_birth: string; age_band: string | null }>(
      "SELECT date_of_birth, age_band FROM children WHERE first_name = 'Quinn'");
    assert.equal(child?.date_of_birth, '2025-05-18');
    assert.ok(child?.age_band, 'an imported roll should be usable immediately');

    // And no empty nameless guardian rows left behind.
    const ghosts = one<{ n: number }>(
      "SELECT COUNT(*) n FROM guardians WHERE first_name IS NULL OR first_name = ''");
    assert.equal(ghosts?.n, 0);
  });
});
