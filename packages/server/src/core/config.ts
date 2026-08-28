import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../../..');

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

/** Loads .env if present. No dependency — this is 12 lines, not a package. */
function loadDotEnv(): void {
  const file = resolve(REPO_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    let v = (m[2] ?? '').trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv();

const dataDir = resolve(REPO_ROOT, env('CRM_DATA_DIR', './data'));

/** Persisted so sessions survive a restart. 0600 — owner read/write only. */
function sessionSecret(): string {
  const fromEnv = env('CRM_SESSION_SECRET');
  if (fromEnv) return fromEnv;
  const keyFile = resolve(dataDir, '.session-key');
  if (existsSync(keyFile)) return readFileSync(keyFile, 'utf8').trim();
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(48).toString('hex');
  writeFileSync(keyFile, key, { mode: 0o600 });
  try { chmodSync(keyFile, 0o600); } catch { /* best effort on Windows */ }
  return key;
}

export const config = {
  dataDir,
  host: env('CRM_HOST', '127.0.0.1'),
  port: Number(env('CRM_PORT', '4317')),
  sessionSecret: sessionSecret(),
  ingestSecret: env('CRM_INGEST_SECRET'),
  allowedOrigin: env('CRM_ALLOWED_ORIGIN'),
  mode: (env('CRM_MODE', 'demo') === 'production' ? 'production' : 'demo') as 'demo' | 'production',
  get isDemo() { return this.mode === 'demo'; },
} as const;
