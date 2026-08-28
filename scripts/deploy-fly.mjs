/**
 * One-command Fly.io deploy.
 *
 *   npm run deploy
 *
 * Idempotent: safe to re-run. It creates only what is missing, never
 * regenerates a secret that already exists (that would sign everyone out and
 * break the website's signature), and refuses to continue if flyctl is not
 * signed in.
 *
 * The one thing it cannot do for you is `fly auth login`, which opens a browser.
 */
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'tiny-stars-crm';
const REGION = 'yyz';           // Toronto, closest to Edmonton of the Canadian regions
const VOLUME = 'crm_data';
const SECRETS_FILE = resolve(ROOT, 'deploy-secrets.local.txt');

const say = (s = '') => console.log(s);
const step = (s) => console.log(`\n=== ${s} ===`);

// --------------------------------------------------------------- flyctl

function findFly() {
  const candidates = [
    'flyctl',
    `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\WinGet\\Links\\flyctl.exe`,
    `${process.env.USERPROFILE ?? ''}\\.fly\\bin\\flyctl.exe`,
    `${process.env.HOME ?? ''}/.fly/bin/flyctl`,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      execFileSync(c, ['version'], { stdio: 'pipe' });
      return c;
    } catch { /* try the next */ }
  }
  // winget installs under a versioned Packages path; find it as a last resort.
  try {
    const base = `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages`;
    const hit = execSync(`dir /s /b "${base}\\flyctl.exe"`, { shell: 'cmd.exe', stdio: 'pipe' })
      .toString().split(/\r?\n/).filter(Boolean)[0];
    if (hit) { execFileSync(hit, ['version'], { stdio: 'pipe' }); return hit; }
  } catch { /* not found */ }
  return null;
}

const fly = findFly();
if (!fly) {
  say('flyctl is not installed.');
  say('  Windows:  winget install Fly-io.flyctl');
  say('  macOS:    brew install flyctl');
  say('  Linux:    curl -L https://fly.io/install.sh | sh');
  process.exit(1);
}

const run = (args, opts = {}) =>
  execFileSync(fly, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
const tryRun = (args) => { try { return { ok: true, out: run(args) }; } catch (e) {
  return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }; } };

step('flyctl');
say(run(['version']));

const who = tryRun(['auth', 'whoami']);
if (!who.ok) {
  say('\nNot signed in to Fly.io.');
  say('\nThis is the one step that cannot be scripted: it opens a browser.');
  say('\n  1. Create a free account at https://fly.io/app/sign-up');
  say('  2. Run:  flyctl auth login');
  say('  3. Run this again:  npm run deploy');
  process.exit(1);
}
say(`signed in as ${who.out}`);

// ------------------------------------------------------------------ app

step('app');
const appExists = tryRun(['status', '--app', APP]).ok;
if (appExists) {
  say(`${APP} already exists`);
} else {
  say(`creating ${APP}`);
  const created = tryRun(['apps', 'create', APP, '--org', 'personal']);
  if (!created.ok) {
    say(created.out);
    say(`\nIf the name is taken, edit "app" in fly.toml and APP in this script, then re-run.`);
    process.exit(1);
  }
  say('created');
}

// --------------------------------------------------------------- volume

step('volume');
const vols = tryRun(['volumes', 'list', '--app', APP]);
if (vols.ok && vols.out.includes(VOLUME)) {
  say(`${VOLUME} already exists`);
  say('NOTE: the database lives on this volume. Never destroy it to "start clean".');
} else {
  say(`creating ${VOLUME} (1GB, ${REGION})`);
  const made = tryRun(['volumes', 'create', VOLUME, '--size', '1', '--region', REGION, '--app', APP, '--yes']);
  if (!made.ok) { say(made.out); process.exit(1); }
  say('created');
}

// -------------------------------------------------------------- secrets

step('secrets');
const existing = tryRun(['secrets', 'list', '--app', APP]).out;
const has = (name) => existing.includes(name);

const generated = {};
const wanted = [
  ['CRM_SESSION_SECRET', () => randomBytes(48).toString('hex')],
  ['CRM_INGEST_SECRET', () => randomBytes(32).toString('hex')],
];

const toSet = [];
for (const [name, gen] of wanted) {
  if (has(name)) { say(`${name} already set, leaving it alone`); continue; }
  const value = gen();
  generated[name] = value;
  toSet.push(`${name}=${value}`);
}

// The origin is not a secret, but it belongs with them so one command sets
// everything the app needs.
const ORIGIN = process.env.CRM_ALLOWED_ORIGIN
  || 'https://tiny-stars-demo-titan-2ac2.vercel.app';
if (!has('CRM_ALLOWED_ORIGIN')) toSet.push(`CRM_ALLOWED_ORIGIN=${ORIGIN}`);

if (toSet.length) {
  say(`setting ${toSet.length} secret(s)`);
  // --stage so nothing deploys until the image is ready.
  const set = tryRun(['secrets', 'set', ...toSet, '--app', APP, '--stage']);
  if (!set.ok) { say(set.out); process.exit(1); }
  say('set');
} else {
  say('all secrets already present');
}

if (generated.CRM_INGEST_SECRET) {
  // Written to a gitignored file rather than left in terminal scrollback.
  const body = [
    'Tiny Stars Command Center - deployment secrets',
    `Generated ${new Date().toISOString()}`,
    '',
    'This file is gitignored. Delete it once the values are in Vercel.',
    'Do not paste these into chat, email or a ticket.',
    '',
    '--- Paste into Vercel: Project -> Settings -> Environment Variables ---',
    '',
    `CRM_INGEST_URL=https://${APP}.fly.dev/api/v1/ingest`,
    `CRM_INGEST_SECRET=${generated.CRM_INGEST_SECRET}`,
    '',
    'Neither may be prefixed PUBLIC_. Both are server-side only.',
    '',
  ].join('\n');
  writeFileSync(SECRETS_FILE, body, { mode: 0o600 });
  try { chmodSync(SECRETS_FILE, 0o600); } catch { /* best effort on Windows */ }
  say(`\nThe website's half was written to:\n  ${SECRETS_FILE}`);
}

// --------------------------------------------------------------- deploy

step('deploy');
say('Building remotely on Fly (no local Docker needed). This takes a few minutes.');
try {
  execFileSync(fly, ['deploy', '--app', APP, '--remote-only', '--yes'], {
    cwd: ROOT, stdio: 'inherit',
  });
} catch {
  say('\nDeploy failed. The build log above says why.');
  say('Common first-deploy causes: an app name already taken, or no payment method on the account.');
  process.exit(1);
}

// --------------------------------------------------------------- verify

step('verify');
const url = `https://${APP}.fly.dev`;
let healthy = false;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { healthy = true; break; }
  } catch { /* still booting */ }
  await new Promise((r) => setTimeout(r, 3000));
}
say(healthy ? `${url}/healthz is answering` : `${url}/healthz did not answer. Check: flyctl logs --app ${APP}`);

try {
  const ping = await (await fetch(`${url}/api/v1/ingest/ping`, { signal: AbortSignal.timeout(5000) })).json();
  say(`ingest endpoint: configured=${ping.configured} mode=${ping.mode}`);
} catch { say('ingest ping did not answer yet'); }

// ----------------------------------------------------------------- next

step('what is left, and only you can do it');
say(`1. Create the first real account:`);
say(`     flyctl ssh console --app ${APP} -C "sh -lc 'cd /app && CRM_NEW_PASSWORD=CHOOSE-A-STRONG-ONE node --disable-warning=ExperimentalWarning packages/server/src/seed/users.ts create you@tinystars.ca \\"Your Name\\" owner'"`);
say('');
say('2. Put the website half into Vercel:');
say(`     Project -> Settings -> Environment Variables`);
if (existsSync(SECRETS_FILE)) say(`     The exact values are in ${SECRETS_FILE}`);
else say(`     CRM_INGEST_URL=${url}/api/v1/ingest  and the CRM_INGEST_SECRET you already set`);
say('     Then redeploy the website so the functions pick them up.');
say('');
say('3. Confirm the loop:');
say(`     https://tiny-stars-demo-titan-2ac2.vercel.app/api/registration  -> {"configured":true}`);
say(`     ${url}/api/v1/ingest/ping                                       -> {"configured":true}`);
say('');
say('4. Before real family data:');
say(`     flyctl ssh console --app ${APP} -C "sh -lc 'cd /app && node --disable-warning=ExperimentalWarning packages/server/src/seed/production.ts check'"`);
say('');
say(`The CRM is at ${url}`);
