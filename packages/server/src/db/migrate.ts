/**
 * Migration runner.
 *
 * Every migration is one .sql file with a `-- +up` and a `-- +down` section.
 * Applying records the file's hash, so an edited-after-the-fact migration is
 * caught rather than silently skipped. Rollback is a first-class command, not a
 * thing you improvise at 2am. (spec 261 / 276 / 180)
 *
 *   node packages/server/src/db/migrate.ts          apply all pending
 *   node packages/server/src/db/migrate.ts status   show what is applied
 *   node packages/server/src/db/migrate.ts down     roll back the last one
 *   node packages/server/src/db/migrate.ts verify   apply, roll back, re-apply
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { connect, getDb, one, many, run, tx } from './index.ts';
import { nowIso } from '../core/util.ts';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface Migration { version: string; name: string; up: string; down: string; hash: string }

export function loadMigrations(): Migration[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(DIR, file), 'utf8');
      const upAt = sql.indexOf('-- +up');
      const downAt = sql.indexOf('-- +down');
      if (upAt === -1) throw new Error(`${file}: missing "-- +up" section`);
      if (downAt === -1) throw new Error(`${file}: missing "-- +down" section. Every migration needs a rollback path.`);
      const [version = file, ...rest] = file.replace(/\.sql$/, '').split('_');
      return {
        version,
        name: rest.join('_') || version,
        up: sql.slice(upAt + 6, downAt).trim(),
        down: sql.slice(downAt + 8).trim(),
        hash: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      };
    });
}

function ensureTable(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, applied_at TEXT NOT NULL)`);
}

export interface AppliedRow { version: string; name: string; hash: string; applied_at: string }

export function applied(): AppliedRow[] {
  ensureTable();
  return many<AppliedRow>('SELECT * FROM schema_migrations ORDER BY version');
}

export function migrateUp(): string[] {
  ensureTable();
  const done = new Map(applied().map((r) => [r.version, r]));
  const ran: string[] = [];
  for (const m of loadMigrations()) {
    const prev = done.get(m.version);
    if (prev) {
      if (prev.hash !== m.hash) {
        throw new Error(
          `Migration ${m.version} was edited after it was applied (hash ${prev.hash} -> ${m.hash}).\n` +
          `Write a NEW migration instead; changing an applied one leaves every other database behind.`,
        );
      }
      continue;
    }
    tx(() => {
      getDb().exec(m.up);
      run('INSERT INTO schema_migrations (version, name, hash, applied_at) VALUES (?,?,?,?)',
        m.version, m.name, m.hash, nowIso());
    });
    ran.push(`${m.version}_${m.name}`);
  }
  return ran;
}

export function migrateDown(): string | null {
  ensureTable();
  const last = one<AppliedRow>('SELECT * FROM schema_migrations ORDER BY version DESC LIMIT 1');
  if (!last) return null;
  const m = loadMigrations().find((x) => x.version === last.version);
  if (!m) throw new Error(`Cannot roll back ${last.version}: its .sql file is gone.`);
  tx(() => {
    getDb().exec(m.down);
    run('DELETE FROM schema_migrations WHERE version = ?', m.version);
  });
  return `${m.version}_${m.name}`;
}

/**
 * up -> down -> up. A migration that has never been rolled back is untested.
 *
 * DESTRUCTIVE: rolling back drops the tables, so every row goes with them. It
 * refuses to run against a database that holds records unless you pass --force,
 * because "I just wanted to check the migration" should never be how the
 * family list disappears.
 */
export function verify(force = false): void {
  ensureTable();
  const holdsData = ['families', 'children', 'guardians', 'registrations', 'users']
    .map((t) => {
      try { return Number(one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)?.n ?? 0); }
      catch { return 0; } // table does not exist yet
    })
    .reduce((a, b) => a + b, 0);

  if (holdsData > 0 && !force) {
    throw new Error(
      `Refusing to verify: this database holds ${holdsData} record(s), and verifying drops every table.\n` +
      `Run it against an empty database, or pass --force if you genuinely mean to erase this one.`,
    );
  }

  const up1 = migrateUp();
  const down = migrateDown();
  if (!down) throw new Error('verify: nothing to roll back');
  const up2 = migrateUp();
  if (up2.length === 0) throw new Error('verify: re-apply did nothing, rollback was incomplete');
  console.log(`verify OK  applied=${up1.length || 'already-current'}  rolled back=${down}  re-applied=${up2.join(', ')}`);
  if (force && holdsData > 0) console.log(`(--force: ${holdsData} record(s) were erased)`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.ts')) {
  await connect();
  const cmd = process.argv[2] ?? 'up';
  if (cmd === 'status') {
    const rows = applied();
    const all = loadMigrations();
    console.log(`${rows.length}/${all.length} applied`);
    for (const m of all) {
      const a = rows.find((r) => r.version === m.version);
      console.log(` ${a ? 'x' : ' '}  ${m.version}_${m.name}${a ? `   ${a.applied_at}` : '   (pending)'}`);
    }
  } else if (cmd === 'down') {
    const r = migrateDown();
    console.log(r ? `rolled back ${r}` : 'nothing to roll back');
  } else if (cmd === 'verify') {
    verify(process.argv.includes('--force'));
  } else {
    const ran = migrateUp();
    console.log(ran.length ? `applied: ${ran.join(', ')}` : 'already up to date');
  }
}
