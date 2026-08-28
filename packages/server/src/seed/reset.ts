/**
 * Wipes operational data and re-seeds the demo set.
 *
 * Hard-blocked when CRM_MODE=production. A "reset demo data" button that can
 * reach a real install is not a convenience, it is a loaded gun. (spec 227)
 */
import { connect, run, tx, getDb } from '../db/index.ts';
import { config } from '../core/config.ts';
import { migrateUp } from '../db/migrate.ts';
import { seedDemo } from './demo.ts';

/** Children first, parents last, so foreign keys never block the delete. */
const TABLES = [
  'search_index', 'notifications', 'outbox', 'ingest_events', 'access_log',
  'notes', 'tasks', 'waitlist', 'registrations', 'tours', 'leads',
  'children', 'guardians', 'families', 'sessions',
];

export function resetDemoData(): void {
  if (config.mode === 'production') {
    throw new Error('Refusing to reset: CRM_MODE is "production".');
  }
  const db = getDb();
  tx(() => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of TABLES) run(`DELETE FROM ${t}`);
    // events has append-only triggers, so it is cleared by dropping and
    // recreating rather than DELETE. Losing the audit log is acceptable only
    // because this path is demo-only.
    db.exec('DROP TRIGGER IF EXISTS events_no_delete');
    run('DELETE FROM events');
    db.exec(`CREATE TRIGGER events_no_delete BEFORE DELETE ON events
             BEGIN SELECT RAISE(ABORT, 'events is append-only'); END`);
    run(`DELETE FROM sqlite_sequence WHERE name = 'events'`);
  });
  console.log('[reset] operational data cleared');
  seedDemo();
}

if (process.argv[1]?.endsWith('reset.ts')) {
  await connect();
  migrateUp();
  resetDemoData();
}
