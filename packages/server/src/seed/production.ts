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

  // --- leftovers ----------------------------------------------------------
  const demoFamilies = count(
    `SELECT COUNT(*) n FROM guardians WHERE email LIKE '%@example.invalid'`);
  if (demoFamilies > 0) {
    f.push({
      level: 'blocker',
      message: `${demoFamilies} synthetic guardian record(s) remain (example.invalid addresses).`,
      fix: 'Run: npm run prod:harden',
    });
  } else f.push({ level: 'ok', message: 'No synthetic family data' });

  // --- backup -------------------------------------------------------------
  f.push({
    level: 'warning',
    message: 'No automated backup exists yet.',
    fix: 'Take a copy of the database and RESTORE it once before real data goes in. ' +
         'A backup that has never been restored is a guess.',
  });

  return f;
}

/** Destructive. Removes every demo account and every synthetic family. */
export function harden(force: boolean): void {
  const demoUsers = many<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE email LIKE '%@demo.local'`);
  const demoFamilies = many<{ id: string; name: string }>(
    `SELECT DISTINCT f.id, f.name FROM families f JOIN guardians g ON g.family_id = f.id
      WHERE g.email LIKE '%@example.invalid'`);

  if (!demoUsers.length && !demoFamilies.length) {
    console.log('Nothing to remove. No demo accounts and no synthetic families.');
    return;
  }

  console.log(`This will permanently delete:`);
  console.log(`  ${demoUsers.length} account(s): ${demoUsers.map((u) => u.email).join(', ') || 'none'}`);
  console.log(`  ${demoFamilies.length} family record(s) and everything attached to them`);
  if (!force) {
    console.log('\nNothing was deleted. Re-run with --force to go ahead:');
    console.log('  npm run prod:harden -- --force');
    return;
  }

  tx(() => {
    for (const u of demoUsers) run('DELETE FROM users WHERE id = ?', u.id);
    // Cascades handle guardians, children, leads, tours, registrations, waitlist.
    for (const f of demoFamilies) run('DELETE FROM families WHERE id = ?', f.id);
    run('INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?) ' +
        'ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
      'hardened_at', JSON.stringify(nowIso()), nowIso());
  });

  getDb().exec('VACUUM');
  console.log(`\nDeleted ${demoUsers.length} account(s) and ${demoFamilies.length} synthetic family record(s).`);
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
