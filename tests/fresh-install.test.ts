/**
 * A brand new production install, with nothing in it.
 *
 * This file exists because the main suite calls seedReference() in its setup,
 * which meant every test ran against a database that already had lead stages.
 * Production never runs the demo seeder, so production had none, and the very
 * first real registration was accepted, got as far as creating the lead, and
 * threw. The parent saw success. The registration was lost.
 *
 * Found by posting through the live website, not by the tests. So: a suite that
 * seeds NOTHING except what boot itself seeds.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const TMP = mkdtempSync(join(tmpdir(), 'crm-fresh-'));
process.env.CRM_DATA_DIR = TMP;
process.env.CRM_MODE = 'production';
process.env.CRM_SESSION_SECRET = 'fresh-install-test-secret-not-a-real-one-000000';
process.env.CRM_INGEST_SECRET = 'fresh-install-ingest-secret';

const { connect, close, one } = await import('../packages/server/src/db/index.ts');
const { migrateUp } = await import('../packages/server/src/db/migrate.ts');
const { seedReference, referenceIsPresent } = await import('../packages/server/src/core/reference.ts');
const { validateEnvelope } = await import('../packages/shared/src/contract.ts');
const { ingest } = await import('../packages/server/src/ingest/pipeline.ts');

before(async () => {
  await connect();
  migrateUp();
  // Exactly what main.ts does at boot, and nothing else. No demo seeder.
  seedReference();
});
after(() => { close(); rmSync(TMP, { recursive: true, force: true }); });

describe('a brand new production install', () => {
  test('boot seeds the reference data the CRM cannot work without', () => {
    const ref = referenceIsPresent();
    assert.equal(ref.ok, true, 'lead stages must exist after boot');
    assert.ok(ref.stages >= 10, `expected the full pipeline, got ${ref.stages} stages`);
    assert.ok(ref.programs >= 6, `expected the real programs, got ${ref.programs}`);
  });

  test('programs match the public website, with no invented capacity', () => {
    const comet = one<{ name: string; capacity: number | null }>(
      "SELECT name, capacity FROM programs WHERE slug = 'comet-stars'");
    assert.equal(comet?.name, 'Comet Stars', 'a parent choosing this on the site finds the same thing here');
    assert.equal(comet?.capacity, null,
      'capacity nobody has told us must stay null, or occupancy becomes fiction');
  });

  test('THE REGRESSION: the very first registration on an empty install works', () => {
    // Before the fix this threw "No lead stages configured", the website
    // reported delivered:false, and the parent saw a confirmation anyway.
    const env = validateEnvelope({
      eventId: randomUUID(),
      type: 'registration.created',
      version: 1,
      occurredAt: new Date().toISOString(),
      source: 'website',
      data: {
        guardian: { fullName: 'Ada Firstborn', email: 'first@example.invalid', phone: '780-555-0001' },
        child: { firstName: 'Tobi', ageBand: '3-5 years' },
        programInterest: 'Nova Stars',
        completedSteps: 5, totalSteps: 5,
      },
    });
    assert.equal(env.ok, true);
    if (!env.ok) return;

    const r = ingest(env.value);
    assert.ok('createdFamily' in r, 'a family result, not an error');
    assert.equal(r.status, 'processed');

    const fam = one<{ name: string }>('SELECT name FROM families WHERE id = ?',
      (r as { familyId: string }).familyId);
    assert.equal(fam?.name, 'Firstborn family');

    const lead = one<{ stage_id: string }>('SELECT stage_id FROM leads WHERE family_id = ?',
      (r as { familyId: string }).familyId);
    assert.ok(lead?.stage_id, 'the lead reached a real stage');
    assert.equal(lead?.stage_id, 'application_submitted');

    const task = one<{ n: number }>('SELECT COUNT(*) n FROM tasks');
    assert.ok(Number(task?.n ?? 0) >= 1, 'and staff were given something to do about it');
  });

  test('seeding reference data twice changes nothing', () => {
    const before = referenceIsPresent();
    const again = seedReference();
    assert.equal(again.stages, 0, 'no duplicate stages');
    assert.equal(again.programs, 0, 'no duplicate programs');
    assert.deepEqual(referenceIsPresent(), before);
  });
});
