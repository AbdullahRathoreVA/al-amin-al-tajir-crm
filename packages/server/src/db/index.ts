import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase, type Driver, type SqlParam } from './driver.ts';
import { config } from '../core/config.ts';

let db: Driver | null = null;

export function dbFile(): string {
  return resolve(config.dataDir, 'crm.db');
}

export async function connect(): Promise<Driver> {
  if (db) return db;
  const file = dbFile();
  mkdirSync(dirname(file), { recursive: true });
  db = await openDatabase(file);
  // WAL: readers never block the writer, which is what makes the UI feel local.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  // NORMAL is the right trade for a local single-writer app: still crash-safe
  // under WAL, without an fsync on every commit.
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}

export function getDb(): Driver {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db;
}

export function close(): void { db?.close(); db = null; }

// ------------------------------------------------------------------ helpers

export function one<T = Record<string, unknown>>(sql: string, ...p: SqlParam[]): T | undefined {
  return getDb().prepare(sql).get<T>(...p);
}
export function many<T = Record<string, unknown>>(sql: string, ...p: SqlParam[]): T[] {
  return getDb().prepare(sql).all<T>(...p);
}
export function run(sql: string, ...p: SqlParam[]) {
  return getDb().prepare(sql).run(...p);
}

/**
 * Explicit BEGIN/COMMIT so both drivers behave identically. IMMEDIATE takes the
 * write lock up front rather than failing halfway through a multi-table write —
 * which is what a family + child + registration insert is. (spec 278/279)
 */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch { /* the original error matters more */ }
    throw err;
  }
}
