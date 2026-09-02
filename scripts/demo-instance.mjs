/**
 * A demo instance that cannot touch the real database.
 *
 * `npm run db:seed` fills whatever `.env` points at, and `.env` on a working
 * machine points at the database with the real families in it — which is why
 * seeding refuses to run in production mode at all. The effect is that there
 * is no quick way to look at a populated CRM, and "no quick way" means people
 * end up pointing demo data at production to see a screen.
 *
 * So this takes the decision away: its data directory is `data/demo/`, its
 * mode is demo, and its port is not 4317. Both are set before anything reads
 * the config, and `.env` cannot override them because loadDotEnv() only fills
 * variables that are not already set.
 *
 *   npm run demo            -> http://127.0.0.1:4319
 *
 * Delete `data/demo/` to start it over. Nothing here is real.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'demo');
mkdirSync(DATA, { recursive: true });

// Set before the first import that reads config, not after.
process.env.CRM_DATA_DIR = DATA;
process.env.CRM_MODE = 'demo';
process.env.CRM_HOST = '127.0.0.1';
process.env.CRM_PORT = process.env.CRM_DEMO_PORT ?? '4319';

// A demo instance has no business holding the real ingest secret or being a
// valid target for the live website, so neither is inherited.
delete process.env.CRM_INGEST_SECRET;
delete process.env.CRM_ALLOWED_ORIGIN;

const fresh = !existsSync(join(DATA, 'crm.db'));

const { connect } = await import('../packages/server/src/db/index.ts');
const { migrateUp } = await import('../packages/server/src/db/migrate.ts');

await connect();
migrateUp();

if (fresh) {
  const { seedDemo } = await import('../packages/server/src/seed/demo.ts');
  seedDemo();
  console.log('[demo] seeded a fresh synthetic database');
}

console.log(`[demo] data dir ${DATA}`);
console.log('[demo] sign in with owner@demo.local / demo1234');

// connect() is idempotent, so main.ts picking up the same handle is fine.
await import('../packages/server/src/main.ts');
