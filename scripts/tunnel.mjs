/**
 * Temporarily expose the LOCAL CRM on a public HTTPS URL, so the live website
 * can deliver registrations before there is any hosting account.
 *
 *   npm run tunnel -- --yes
 *
 * The --yes is required on purpose. This puts a system designed to hold
 * children's records on the public internet, and that should never happen as a
 * side effect of running something.
 *
 * It is a stopgap for proving the loop, not a deployment:
 *   - the URL changes every time, so Vercel needs updating each run;
 *   - it dies when this process does, and the website silently stops
 *     delivering (registrations are NOT lost, they just never arrive);
 *   - your machine has to be awake.
 *
 * For anything real, use `npm run deploy`.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CRM = 'http://127.0.0.1:4317';

function findCloudflared() {
  const candidates = [
    'cloudflared',
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    `${process.env.LOCALAPPDATA ?? ''}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { execFileSync(c, ['--version'], { stdio: 'pipe' }); return c; } catch { /* next */ }
    if (existsSync(c)) return c;
  }
  return null;
}

if (!process.argv.includes('--yes')) {
  console.log('This exposes your local CRM on a public HTTPS URL.');
  console.log('');
  console.log('Only reasonable while the database holds demo data. Check first:');
  console.log('  npm run prod:check');
  console.log('');
  console.log('Sign-in is required and throttled, and the URL is random, but it is');
  console.log('still the open internet. For anything real, use: npm run deploy');
  console.log('');
  console.log('If you mean it:  npm run tunnel -- --yes');
  process.exit(0);
}

const bin = findCloudflared();
if (!bin) {
  console.log('cloudflared is not installed.');
  console.log('  Windows:  winget install Cloudflare.cloudflared');
  console.log('  macOS:    brew install cloudflared');
  process.exit(1);
}

// Refuse to tunnel to nothing.
try {
  const res = await fetch(`${CRM}/healthz`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.log(`The CRM is not answering on ${CRM}.`);
  console.log('Start it first:  npm start');
  process.exit(1);
}
console.log(`CRM is up on ${CRM}. Opening a tunnel...\n`);

const child = spawn(bin, ['tunnel', '--url', CRM, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });

let announced = false;
const watch = (chunk) => {
  const text = chunk.toString();
  const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(text);
  if (m && !announced) {
    announced = true;
    const url = m[0];
    console.log('='.repeat(68));
    console.log(`  PUBLIC URL   ${url}`);
    console.log('='.repeat(68));
    console.log('');
    console.log('Paste into Vercel -> Project -> Settings -> Environment Variables,');
    console.log('then redeploy the website:');
    console.log('');
    console.log(`  CRM_INGEST_URL     = ${url}/api/v1/ingest`);
    console.log('  CRM_INGEST_SECRET  = (the value already in your local .env)');
    console.log('');
    console.log('Then check:');
    console.log('  https://tiny-stars-demo-titan-2ac2.vercel.app/api/registration');
    console.log('  should answer {"configured":true}');
    console.log('');
    console.log('Also set CRM_ALLOWED_ORIGIN in the CRM .env to the website origin,');
    console.log('and restart the CRM, or the browser analytics beacon will be refused.');
    console.log('');
    console.log('Ctrl+C closes the tunnel. The URL is different every time.');
    console.log('');
  }
};
child.stdout.on('data', watch);
child.stderr.on('data', watch);   // cloudflared prints the URL to stderr

child.on('exit', (code) => {
  console.log(`\ncloudflared exited (${code}). The public URL is gone.`);
  console.log('The website will stop delivering until you tunnel again and update Vercel.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { child.kill(); process.exit(0); });
}
