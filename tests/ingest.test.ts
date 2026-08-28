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
const { reindexAll, search } = await import('../packages/server/src/core/search.ts');
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
const { createBackup, listBackups, testRestore, pruneBackups } =
  await import('../packages/server/src/core/backup.ts');

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

  test('a row with no way to contact the family is skipped, with a reason', () => {
    const csv = HEAD + 'No Contact Person,,,Kid,\n';
    const p = parseCsv(csv);
    const view = previewImport(p, guessMapping(p.headers));
    assert.equal(view.willSkip, 1);
    assert.ok(view.issues.some((i) => i.severity === 'error' && /never be contacted/.test(i.message)));
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
