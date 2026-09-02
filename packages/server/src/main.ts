/**
 * Boot. Connects, runs the startup health check, then serves the API and the
 * built web app from one loopback port. (spec 187)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';
import { connect, one } from './db/index.ts';
import { config, REPO_ROOT } from './core/config.ts';
import { migrateUp, applied, loadMigrations } from './db/migrate.ts';
import { seedTemplates } from './core/drafts.ts';
import { startBackupSchedule, newestBackup } from './core/backup.ts';
import { seedAutomations, startAutomationSchedule } from './core/automations.ts';
import { registerTransport, startSyncSchedule } from './core/sync.ts';
import { sheetsTransport } from './core/transports/sheets.ts';
import { emailTransport } from './core/transports/email.ts';
import { seedReference, referenceIsPresent } from './core/reference.ts';
import { reindexAll, searchIndexNeedsRebuild } from './core/search.ts';
import { startAgeSchedule } from './core/progression.ts';
import { handle, securityHeaders } from './http.ts';
import { router } from './routes.ts';

const WEB_DIST = resolve(REPO_ROOT, 'packages/web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

async function serveStatic(pathname: string): Promise<{ body: Buffer; type: string } | null> {
  // Resolve inside WEB_DIST and verify: without this, ../../ walks the disk.
  const target = normalize(join(WEB_DIST, pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(WEB_DIST)) return null;
  try {
    const s = await stat(target);
    if (!s.isFile()) throw new Error('not a file');
    return { body: await readFile(target), type: MIME[extname(target)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

function bootHealthCheck(): void {
  const integrity = one<{ integrity_check: string }>('PRAGMA integrity_check');
  if (integrity?.integrity_check !== 'ok') {
    console.error('[crm] DATABASE INTEGRITY CHECK FAILED:', integrity?.integrity_check);
    console.error('[crm] Refusing to start. Restore from a backup in ./backups.');
    process.exit(1);
  }
  const done = applied().length;
  const total = loadMigrations().length;
  const users = one<{ n: number }>('SELECT COUNT(*) n FROM users')?.n ?? 0;
  const families = one<{ n: number }>('SELECT COUNT(*) n FROM families')?.n ?? 0;

  console.log(`[crm] database  ok   migrations ${done}/${total}   users ${users}   families ${families}`);
  if (config.mode === 'demo') console.log('[crm] MODE: demo  - synthetic data, DEMO banner shown in the UI');
  else console.log('[crm] MODE: production - demo reset disabled');
  if (!config.ingestSecret) {
    console.log('[crm] note: CRM_INGEST_SECRET is not set, so the website cannot post registrations yet.');
  }
  if (users === 0) {
    console.log('[crm] no users yet. Create one:  npm run user:create');
  }

  const ref2 = referenceIsPresent();
  if (!ref2.ok) {
    console.error('[crm] NO LEAD STAGES. Registrations will fail on arrival.');
  } else {
    console.log(`[crm] reference ${ref2.stages} stages, ${ref2.programs} programs`);
  }

  const backup = newestBackup();
  if (!backup) console.log('[crm] backup   none yet, one will be taken shortly');
  else if (backup.ageHours > 48) console.log(`[crm] backup   WARNING last one is ${backup.ageHours}h old`);
  else console.log(`[crm] backup   ${backup.file} (${backup.ageHours}h ago)`);
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;

  // CORS, only for the ingest endpoint and only for the configured origin.
  // Everything else is same-origin by design; the UI is served from here.
  if (req.url?.startsWith('/api/v1/ingest') && origin && origin === config.allowedOrigin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type, x-crm-signature, x-crm-timestamp');
    res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
    res.setHeader('vary', 'origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    if (await handle(router, req, res)) return;
  } catch (err) {
    console.error('[crm] router failure', err);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); }
    res.end(JSON.stringify({ error: 'Server error' }));
    return;
  }

  if (req.url?.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `No such endpoint: ${req.method} ${req.url}` }));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = await serveStatic(url.pathname);
  if (file) {
    res.writeHead(200, { 'content-type': file.type, ...securityHeaders(req) });
    res.end(file.body);
    return;
  }
  // SPA fallback so deep links like /families/<id> work on a hard refresh.
  const index = await serveStatic('/index.html');
  if (index) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...securityHeaders(req) });
    res.end(index.body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('The web app has not been built yet. Run: npm run build   (or npm run dev for the dev server)');
});

await connect();
migrateUp();
// Message templates are reference data, not demo data, so they are seeded in
// production too. seedTemplates() only inserts what is missing.
// Lead stages and programs. Without these the CRM accepts a registration and
// then throws while creating the lead, losing it. Reference data, not demo
// data, so it seeds in every mode.
const ref = seedReference();
if (ref.stages || ref.programs) {
  console.log(`[crm] seeded ${ref.stages} lead stage(s) and ${ref.programs} program(s)`);
}
// The FTS table is a derived cache, and a migration that rebuilds it leaves it
// empty. Refill it here rather than letting the first person to use the search
// box discover the gap — a search that silently returns nothing looks like an
// empty database, not a missing index.
if (searchIndexNeedsRebuild()) {
  console.log(`[crm] search   index empty, rebuilding… ${reindexAll()} record(s)`);
}

const newTemplates = seedTemplates();
const newAutomations = seedAutomations();
if (newAutomations) console.log(`[crm] seeded ${newAutomations} automation(s)`);
if (newTemplates) console.log(`[crm] seeded ${newTemplates} message template(s)`);
bootHealthCheck();

// Daily, keeping two weeks. Verified on the way out; an unverified backup is
// a guess.
startBackupSchedule(24, 14);

// Hourly sweep for the time-based rules. Event-driven ones fire inline.
startAutomationSchedule(60);

// Children have birthdays. Age groups are recomputed from the date of birth
// and corrected; rooms are only ever reported, never changed, because moving a
// child depends on space, ratios and their parents.
startAgeSchedule(24);

// Registered unconditionally; it reports itself as not connected until the
// Google credentials exist. Registering only when configured would make an
// unconfigured channel indistinguishable from an unknown one, and /system
// needs to tell a setup step apart from a broken integration.
registerTransport(sheetsTransport);
registerTransport(emailTransport);
startSyncSchedule(15);

server.listen(config.port, config.host, () => {
  console.log(`[crm] Tiny Stars Command Center  ->  http://${config.host}:${config.port}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log('\n[crm] shutting down'); server.close(() => process.exit(0)); });
}
