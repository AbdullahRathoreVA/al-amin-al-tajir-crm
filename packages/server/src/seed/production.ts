/**
 * Production preflight and cutover.
 *
 *   npm run prod:check    read-only. Lists everything blocking a real deploy.
 *   npm run prod:harden   destructive. Removes demo data and demo accounts.
 *
 * The check is deliberately pessimistic. It is cheaper to be told about a
 * missing secret now than to discover it from a family whose registration
 * vanished.
 */
import { connect, one, many, run, tx, getDb } from '../db/index.ts';
import { config } from '../core/config.ts';
import { migrateUp, applied, loadMigrations } from '../db/migrate.ts';
import { nowIso } from '../core/util.ts';
import { newestBackup, createBackup } from '../core/backup.ts';
import { recordEvent, SYSTEM } from '../core/events.ts';

interface Finding { level: 'blocker' | 'warning' | 'ok'; message: string; fix?: string }

const count = (sql: string, ...p: string[]): number =>
  Number(one<{ n: number }>(sql, ...p)?.n ?? 0);

export function preflight(): Finding[] {
  const f: Finding[] = [];

  // --- mode ---------------------------------------------------------------
  if (config.mode !== 'production') {
    f.push({
      level: 'blocker',
      message: `CRM_MODE is "${config.mode}". Demo data and the reset command are still enabled.`,
      fix: 'Set CRM_MODE=production in the deployed environment.',
    });
  } else f.push({ level: 'ok', message: 'CRM_MODE is production' });

  // --- secrets ------------------------------------------------------------
  if (!process.env.CRM_SESSION_SECRET) {
    f.push({
      level: 'blocker',
      message: 'CRM_SESSION_SECRET is not set, so a key was generated on disk.',
      fix: 'Generate one and set it as a platform secret. On a host that replaces the ' +
           'filesystem, an on-disk key means every deploy signs everyone out.',
    });
  } else if (process.env.CRM_SESSION_SECRET.length < 48) {
    f.push({ level: 'blocker', message: 'CRM_SESSION_SECRET is shorter than 48 characters.' });
  } else f.push({ level: 'ok', message: 'CRM_SESSION_SECRET is set explicitly' });

  if (!config.ingestSecret) {
    f.push({
      level: 'warning',
      message: 'CRM_INGEST_SECRET is not set, so the website cannot deliver registrations.',
      fix: 'Set the same value here and in the website environment.',
    });
  } else if (config.ingestSecret.length < 32) {
    f.push({ level: 'blocker', message: 'CRM_INGEST_SECRET is shorter than 32 characters.' });
  } else f.push({ level: 'ok', message: 'CRM_INGEST_SECRET is set' });

  if (config.ingestSecret && config.ingestSecret === process.env.CRM_SESSION_SECRET) {
    f.push({
      level: 'blocker',
      message: 'CRM_SESSION_SECRET and CRM_INGEST_SECRET are the same value.',
      fix: 'Use two different secrets. They are shared with different parties.',
    });
  }

  if (!config.allowedOrigin) {
    f.push({ level: 'warning', message: 'CRM_ALLOWED_ORIGIN is not set, so browser CORS is refused for the website.' });
  } else if (!config.allowedOrigin.startsWith('https://')) {
    f.push({ level: 'blocker', message: `CRM_ALLOWED_ORIGIN is not https: ${config.allowedOrigin}` });
  } else f.push({ level: 'ok', message: `CRM_ALLOWED_ORIGIN is ${config.allowedOrigin}` });

  // --- binding ------------------------------------------------------------
  if (config.host === '0.0.0.0') {
    f.push({
      level: 'warning',
      message: 'Bound to 0.0.0.0. Correct behind a platform proxy; wrong on a machine reachable directly.',
      fix: 'Confirm that only the platform proxy can reach this port.',
    });
  }

  // --- accounts -----------------------------------------------------------
  const demoUsers = count(`SELECT COUNT(*) n FROM users WHERE email LIKE '%@demo.local'`);
  if (demoUsers > 0) {
    f.push({
      level: 'blocker',
      message: `${demoUsers} demo account(s) still exist, all with the password "demo1234".`,
      fix: 'Run: npm run prod:harden',
    });
  } else f.push({ level: 'ok', message: 'No demo accounts' });

  const users = count('SELECT COUNT(*) n FROM users');
  if (users === 0) {
    f.push({ level: 'blocker', message: 'No users at all. Nobody could sign in.', fix: 'npm run user:create' });
  }
  const owners = count(`SELECT COUNT(*) n FROM users WHERE role = 'owner' AND status = 'active'`);
  if (owners === 0) f.push({ level: 'blocker', message: 'No active owner account.' });

  const neverSignedIn = many<{ email: string }>(
    `SELECT email FROM users WHERE last_login_at IS NULL AND status = 'active'`);
  if (neverSignedIn.length) {
    f.push({
      level: 'warning',
      message: `${neverSignedIn.length} account(s) have never signed in: ${neverSignedIn.map((u) => u.email).join(', ')}`,
      fix: 'Confirm each is real, or suspend it.',
    });
  }

  // --- database -----------------------------------------------------------
  const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') {
    f.push({ level: 'blocker', message: `Database integrity check failed: ${integrity?.integrity_check}` });
  } else f.push({ level: 'ok', message: 'Database integrity check passed' });

  const pending = loadMigrations().length - applied().length;
  if (pending > 0) f.push({ level: 'blocker', message: `${pending} migration(s) pending.`, fix: 'npm run db:migrate' });
  else f.push({ level: 'ok', message: 'Migrations are current' });

  // --- reference data -------------------------------------------------------
  const stages = count('SELECT COUNT(*) n FROM lead_stages');
  const programs = count('SELECT COUNT(*) n FROM programs');
  if (stages === 0) {
    f.push({
      level: 'blocker',
      message: 'No lead stages. A registration would be accepted and then thrown away.',
      fix: 'Restart the server; reference data seeds at boot.',
    });
  } else f.push({ level: 'ok', message: `${stages} lead stages, ${programs} programs` });

  // --- leftovers ----------------------------------------------------------
  // Count only what harden would actually remove. Counting the families it now
  // protects would block the preflight forever, telling you to run a command
  // that correctly refuses to touch them.
  const kept = websiteSourcedFamilyIds();
  const demoFamilies = many<{ family_id: string }>(
    `SELECT DISTINCT family_id FROM guardians WHERE email LIKE '%@example.invalid'`)
    .filter((g) => !kept.has(g.family_id)).length;
  if (demoFamilies > 0) {
    f.push({
      level: 'blocker',
      message: `${demoFamilies} synthetic family record(s) remain (example.invalid addresses).`,
      fix: 'Run: npm run prod:harden',
    });
  } else f.push({ level: 'ok', message: 'No synthetic family data' });

  // --- backup -------------------------------------------------------------
  // This used to warn unconditionally, without looking. A preflight that cries
  // wolf about a thing it never checked is worse than no preflight.
  const backup = newestBackup();
  if (!backup) {
    f.push({
      level: 'blocker',
      message: 'No backup exists. Losing the disk would lose every family.',
      fix: 'npm run backup, then npm run backup:test to prove it restores.',
    });
  } else if (backup.ageHours > 48) {
    f.push({
      level: 'warning',
      message: `The newest backup is ${Math.round(backup.ageHours)}h old.`,
      fix: 'Check the backup schedule is running.',
    });
  } else {
    f.push({
      level: 'ok',
      message: `Backup ${backup.file} taken ${backup.ageHours}h ago`,
    });
  }

  return f;
}

/**
 * Every family a real parent submitted through the website, whatever address
 * they typed into the form.
 *
 * This exists because the `@example.invalid` rule below is a guess about intent
 * and this is a fact about origin. On 2026-08-28 a real website registration
 * was submitted with an `@example.invalid` address; `harden --force` ran 55
 * seconds later, matched it, and deleted the family, the child, the lead and
 * both registrations. Only the append-only event log survived to prove they had
 * ever existed.
 *
 * A pattern-match on an email address must never outrank the record of how a
 * row got here. If the website put it there, a person put it there.
 */
function websiteSourcedFamilyIds(): Set<string> {
  // `source = 'website'` is NOT the test, however much it reads like one: the
  // demo seeder stamps its fabricated families with exactly that. What cannot
  // be fabricated is `source_id`, which holds the eventId of the signed request
  // that created the row — and `ingest_events` is the ledger of events actually
  // received and verified. The seeder writes NULL there, because no event ever
  // arrived. So: joinable to ingest_events means a real parent pressed submit.
  const rows = many<{ id: string }>(
    `SELECT id AS id        FROM families      WHERE source_id IN (SELECT event_id FROM ingest_events)
      UNION SELECT family_id FROM registrations WHERE source_id IN (SELECT event_id FROM ingest_events)
      UNION SELECT family_id FROM leads         WHERE source_id IN (SELECT event_id FROM ingest_events)`);
  return new Set(rows.map((r) => r.id));
}

/**
 * Tasks and notifications point at records by (type, id) with no foreign key,
 * deliberately: a task may outlive the thing it refers to and still be worth
 * reading. But when the target is deleted outright, what is left is a link that
 * 404s — which is how the deletion above was discovered, from a task in the
 * attention radar that led to "No such registration".
 *
 * Deleting the row and orphaning its inbound links is not finishing the job.
 */
function dependentIdsOf(familyId: string): { type: string; id: string }[] {
  const out: { type: string; id: string }[] = [{ type: 'family', id: familyId }];
  for (const [type, table] of [
    ['child', 'children'], ['lead', 'leads'], ['tour', 'tours'],
    ['registration', 'registrations'], ['waitlist', 'waitlist'], ['guardian', 'guardians'],
  ] as const) {
    for (const r of many<{ id: string }>(`SELECT id FROM ${table} WHERE family_id = ?`, familyId)) {
      out.push({ type, id: r.id });
    }
  }
  return out;
}

/** Destructive. Removes every demo account and every synthetic family. */
export function harden(force: boolean): void {
  const demoUsers = many<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email LIKE '%@demo.local'`);
  const candidates = many<{ id: string; name: string; emails: string }>(
    `SELECT f.id, f.name, GROUP_CONCAT(DISTINCT g.email) AS emails
       FROM families f JOIN guardians g ON g.family_id = f.id
      WHERE g.email LIKE '%@example.invalid'
      GROUP BY f.id, f.name`);

  const protectedIds = websiteSourcedFamilyIds();
  const demoFamilies = candidates.filter((f) => !protectedIds.has(f.id));
  const spared = candidates.filter((f) => protectedIds.has(f.id));

  // Say what was protected even when there is nothing to delete. Silence here
  // reads as "there was nothing matching", which is a different fact.
  if (spared.length) {
    console.log(`Protected ${spared.length} family record(s) that came from the website:`);
    for (const f of spared) console.log(`  keep    ${f.name}  (${f.emails})`);
    console.log('');
  }

  if (!demoUsers.length && !demoFamilies.length) {
    console.log('Nothing to remove. No demo accounts and no synthetic families.');
    return;
  }

  console.log(`This will permanently delete:`);
  for (const u of demoUsers) console.log(`  account  ${u.email}`);
  // Name them. A count cannot be sanity-checked by the person typing --force.
  for (const f of demoFamilies) console.log(`  family   ${f.name}  (${f.emails})`);
  if (!force) {
    console.log('\nNothing was deleted. Re-run with --force to go ahead:');
    console.log('  npm run prod:harden -- --force');
    return;
  }

  // Before, not after. A backup taken after the delete preserves the delete.
  let safety = '(none)';
  try {
    safety = createBackup().path;
    console.log(`\nBackup taken first: ${safety}`);
  } catch (err) {
    console.error('\nRefusing to delete: the safety backup failed.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }

  let orphans = 0;
  tx(() => {
    for (const u of demoUsers) run('DELETE FROM users WHERE id = ?', u.id);
    for (const f of demoFamilies) {
      const deps = dependentIdsOf(f.id);
      // Cascades handle guardians, children, leads, tours, registrations, waitlist.
      run('DELETE FROM families WHERE id = ?', f.id);
      for (const d of deps) {
        orphans += Number(run('DELETE FROM tasks WHERE related_type = ? AND related_id = ?', d.type, d.id).changes ?? 0);
        orphans += Number(run('DELETE FROM notifications WHERE link_type = ? AND link_id = ?', d.type, d.id).changes ?? 0);
      }
      recordEvent({
        entityType: 'family', entityId: f.id, type: 'deleted', actor: SYSTEM,
        summary: `Family "${f.name}" removed by prod:harden as synthetic data`,
        before: { name: f.name, guardianEmails: f.emails }, after: null,
      });
    }
    run('INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?) ' +
        'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      'hardened_at', JSON.stringify(nowIso()), nowIso());
  });

  getDb().exec('VACUUM');
  console.log(`\nDeleted ${demoUsers.length} account(s) and ${demoFamilies.length} synthetic family record(s).`);
  console.log(`Cleared ${orphans} task(s) and notification(s) that would have pointed at nothing.`);
  console.log('The event log is append-only and was NOT deleted; it still records that the demo data existed.');
  console.log('\nNow re-run:  npm run prod:check');
}

if (process.argv[1]?.endsWith('production.ts')) {
  await connect();
  migrateUp();
  const cmd = process.argv[2] ?? 'check';

  if (cmd === 'harden') {
    harden(process.argv.includes('--force'));
    process.exit(0);
  }

  const findings = preflight();
  const blockers = findings.filter((x) => x.level === 'blocker');
  const warnings = findings.filter((x) => x.level === 'warning');

  for (const x of findings.filter((y) => y.level === 'ok')) console.log(`  ok       ${x.message}`);
  for (const x of warnings) {
    console.log(`  WARNING  ${x.message}`);
    if (x.fix) console.log(`           -> ${x.fix}`);
  }
  for (const x of blockers) {
    console.log(`  BLOCKER  ${x.message}`);
    if (x.fix) console.log(`           -> ${x.fix}`);
  }

  console.log(
    `\n${blockers.length} blocker(s), ${warnings.length} warning(s).` +
    (blockers.length === 0
      ? '\nNothing is blocking a deploy. Read the warnings before you go.'
      : '\nDo not deploy with real family data until the blockers are cleared.'),
  );
  process.exit(blockers.length === 0 ? 0 : 1);
}
