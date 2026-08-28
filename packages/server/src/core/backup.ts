/**
 * Backups.
 *
 * `VACUUM INTO` rather than copying the file: it is atomic, it produces a
 * single consistent database even while writes are happening, and it does not
 * need the -wal and -shm sidecars that a naive `cp` silently leaves behind.
 * A backup taken by copying a WAL database mid-write is frequently unopenable,
 * and you find out on the day you need it.
 *
 * Every backup is verified immediately after it is taken: opened, integrity
 * checked, and its row counts compared to the live database. An unverified
 * backup is a guess. (spec 101 / 102)
 */
import { mkdirSync, readdirSync, statSync, unlinkSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDb, dbFile, one } from '../db/index.ts';
import { openDatabase } from '../db/driver.ts';
import { config } from './config.ts';
import { nowIso } from './util.ts';

const BACKUP_DIR = resolve(config.dataDir, 'backups');
/** Tables whose counts are compared. If these match, the backup is usable. */
const CHECK_TABLES = ['families', 'guardians', 'children', 'registrations', 'events'] as const;

export interface BackupInfo {
  file: string;
  path: string;
  sizeBytes: number;
  takenAt: string;
  ageHours: number;
}

export interface VerifyResult {
  ok: boolean;
  integrity: string;
  counts: Record<string, number>;
  liveCounts: Record<string, number>;
  problems: string[];
}

function ensureDir(): void { mkdirSync(BACKUP_DIR, { recursive: true }); }

// -------------------------------------------------------------------- take

export function createBackup(): { path: string; sizeBytes: number; verify: VerifyResult } {
  ensureDir();
  // Colons are illegal in Windows filenames, so the ISO timestamp is flattened.
  const stamp = nowIso().replace(/[:.]/g, '-');
  const path = join(BACKUP_DIR, `crm-${stamp}.db`);

  // VACUUM INTO refuses to overwrite, which is the behaviour we want.
  getDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);

  const sizeBytes = statSync(path).size;
  const verify = verifyBackup(path);
  return { path, sizeBytes, verify };
}

// ------------------------------------------------------------------ verify

/**
 * Opens the backup as a real database and checks it. This is the step that
 * separates "a file exists" from "we can recover".
 */
export function verifyBackup(path: string): VerifyResult {
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  const liveCounts: Record<string, number> = {};

  for (const t of CHECK_TABLES) {
    liveCounts[t] = Number(one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)?.n ?? 0);
  }

  let integrity = 'not checked';
  try {
    // Synchronous open of the backup file. openDatabase is async only because
    // of the optional better-sqlite3 import, so this is awaited by the caller
    // through verifyBackupAsync; the sync path below uses the live driver's
    // ATTACH instead, which avoids a second connection entirely.
    const db = getDb();
    const safe = path.replace(/'/g, "''");
    db.exec(`ATTACH DATABASE '${safe}' AS backup_check`);
    try {
      const row = db.prepare('PRAGMA backup_check.integrity_check').get<{ integrity_check: string }>();
      integrity = row?.integrity_check ?? 'no result';
      if (integrity !== 'ok') problems.push(`Integrity check failed: ${integrity}`);

      for (const t of CHECK_TABLES) {
        const n = Number(db.prepare(`SELECT COUNT(*) n FROM backup_check.${t}`).get<{ n: number }>()?.n ?? -1);
        counts[t] = n;
        if (n < 0) problems.push(`Could not read ${t} from the backup.`);
        // A backup taken a moment ago can legitimately be one or two rows
        // behind a live system. A large gap means something is wrong.
        else if (n < liveCounts[t]! - 5) {
          problems.push(`${t}: backup has ${n}, live has ${liveCounts[t]}. Too far behind.`);
        }
      }
    } finally {
      db.exec('DETACH DATABASE backup_check');
    }
  } catch (err) {
    problems.push(`Could not open the backup: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: problems.length === 0, integrity, counts, liveCounts, problems };
}

// -------------------------------------------------------------------- list

export function listBackups(): BackupInfo[] {
  ensureDir();
  const now = Date.now();
  return readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith('crm-') && f.endsWith('.db'))
    .map((file) => {
      const path = join(BACKUP_DIR, file);
      const s = statSync(path);
      return {
        file, path, sizeBytes: s.size,
        takenAt: s.mtime.toISOString(),
        ageHours: Math.round((now - s.mtimeMs) / 36e5 * 10) / 10,
      };
    })
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}

export function newestBackup(): BackupInfo | null { return listBackups()[0] ?? null; }

// ------------------------------------------------------------------- prune

export function pruneBackups(keep = 14): string[] {
  const all = listBackups();
  const removed: string[] = [];
  for (const b of all.slice(keep)) {
    try { unlinkSync(b.path); removed.push(b.file); } catch { /* already gone */ }
  }
  return removed;
}

// ----------------------------------------------------------------- restore

/**
 * Restores a backup over the live database.
 *
 * The current database is copied aside first, unconditionally. Restoring the
 * wrong file is a mistake people make while already panicking, and it must not
 * be the last thing that ever happens to the real data.
 *
 * The process must be restarted afterwards: the running server holds an open
 * handle to the old file.
 */
export function restoreBackup(file: string): { restored: string; safetyCopy: string } {
  const path = join(BACKUP_DIR, file);
  if (!existsSync(path)) throw new Error(`No such backup: ${file}`);

  const check = verifyBackup(path);
  if (check.integrity !== 'ok') {
    throw new Error(`Refusing to restore: that backup fails its integrity check (${check.integrity}).`);
  }

  const live = dbFile();
  const safetyCopy = `${live}.before-restore-${nowIso().replace(/[:.]/g, '-')}`;
  copyFileSync(live, safetyCopy);
  copyFileSync(path, live);

  // The -wal and -shm belong to the replaced database. Left in place SQLite
  // would try to replay them over the restored file.
  for (const suffix of ['-wal', '-shm']) {
    const side = live + suffix;
    if (existsSync(side)) { try { unlinkSync(side); } catch { /* best effort */ } }
  }

  return { restored: file, safetyCopy };
}

/**
 * Restore rehearsal: proves a backup would restore, without touching live data.
 * This is the difference between having backups and being able to recover.
 */
export async function testRestore(file: string): Promise<VerifyResult & { file: string }> {
  const path = join(BACKUP_DIR, file);
  if (!existsSync(path)) throw new Error(`No such backup: ${file}`);

  const problems: string[] = [];
  const counts: Record<string, number> = {};
  const liveCounts: Record<string, number> = {};
  for (const t of CHECK_TABLES) {
    liveCounts[t] = Number(one<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)?.n ?? 0);
  }

  // A genuinely separate connection, the way a real recovery would open it.
  let integrity = 'not checked';
  const db = await openDatabase(path);
  try {
    integrity = db.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check ?? 'no result';
    if (integrity !== 'ok') problems.push(`Integrity check failed: ${integrity}`);

    for (const t of CHECK_TABLES) {
      try {
        counts[t] = Number(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get<{ n: number }>()?.n ?? -1);
      } catch (err) {
        counts[t] = -1;
        problems.push(`${t} is unreadable in the backup: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Prove it is a working database, not just a readable file.
    try {
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' LIMIT 1").get();
    } catch {
      problems.push('The backup has no readable schema.');
    }
  } finally {
    db.close();
  }

  return { ok: problems.length === 0, integrity, counts, liveCounts, problems, file };
}

// --------------------------------------------------------------- scheduler

let timer: NodeJS.Timeout | null = null;

/**
 * Takes one at boot if the newest is older than the interval, then on a timer.
 * unref() so a pending backup never keeps the process alive during a shutdown.
 */
export function startBackupSchedule(intervalHours = 24, keep = 14): void {
  const run = () => {
    try {
      const { path, sizeBytes, verify } = createBackup();
      const removed = pruneBackups(keep);
      const kb = Math.round(sizeBytes / 1024);
      if (verify.ok) {
        console.log(`[crm] backup ok  ${path.split(/[\\/]/).pop()}  ${kb}kB` +
          (removed.length ? `  (pruned ${removed.length})` : ''));
      } else {
        console.error('[crm] BACKUP VERIFICATION FAILED:', verify.problems.join('; '));
      }
    } catch (err) {
      console.error('[crm] backup failed:', err instanceof Error ? err.message : err);
    }
  };

  const newest = newestBackup();
  if (!newest || newest.ageHours >= intervalHours) run();

  timer = setInterval(run, intervalHours * 36e5);
  timer.unref();
}

export function stopBackupSchedule(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
