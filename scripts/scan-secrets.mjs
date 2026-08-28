/**
 * Refuses to let a secret reach the repository.
 *
 * Runs over TRACKED files only, so it checks what git would actually publish
 * rather than whatever happens to be sitting on disk. Run it before every push.
 * CI runs it too, but by then a leaked secret is already in the history.
 */
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key'],
  [/\bsk-[A-Za-z0-9]{20,}/, 'OpenAI-style API key'],
  [/\bgsk_[A-Za-z0-9]{20,}/, 'Groq API key'],
  [/\bsk-ant-[A-Za-z0-9-]{20,}/, 'Anthropic API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/"private_key"\s*:\s*"-----BEGIN/, 'Google service account json'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  // An assignment holding something that looks like a real value rather than a
  // placeholder. Placeholders in .env.example are empty, so they do not match.
  [/(SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY)\s*[=:]\s*['"][^'"\s]{16,}['"]/i, 'hardcoded credential'],
];

/** Files that legitimately discuss secrets without containing one. */
const ALLOW = [
  /^\.env\.example$/,
  /^docs\//,
  /^README\.md$/,
  /^scripts\/scan-secrets\.mjs$/,
  /^\.github\/workflows\//,
];

/** Files that must never be tracked at all, regardless of contents. */
const MUST_NOT_BE_TRACKED = [
  /^\.env$/,
  /(^|\/)data\/.*\.db(-wal|-shm)?$/,
  /(^|\/)data\/\.session-key$/,
  /\.pem$/,
  /\.p12$/,
];

/**
 * Values that are obviously stand-ins. Narrower than allowlisting whole files:
 * a test file stays scanned, so a real key pasted into one is still caught.
 * A genuine secret does not contain the word "example".
 */
const PLACEHOLDER = /(not-a-real|placeholder|changeme|change-me|example|dummy|fake|sample|test-secret|your[-_]|xxxx|<[^>]+>)/i;

const NUL = String.fromCharCode(0);

const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
let problems = 0;

for (const file of tracked) {
  for (const forbidden of MUST_NOT_BE_TRACKED) {
    if (forbidden.test(file)) {
      console.error(`TRACKED BUT MUST NOT BE: ${file}`);
      problems++;
    }
  }
}

for (const file of tracked) {
  if (ALLOW.some((a) => a.test(file))) continue;

  let stat;
  try { stat = statSync(file); } catch { continue; }
  if (!stat.isFile() || stat.size > 2_000_000) continue;

  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (text.includes(NUL)) continue; // binary

  for (const [re, label] of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    if (PLACEHOLDER.test(m[0])) continue;
    const line = text.slice(0, m.index).split('\n').length;
    console.error(`POSSIBLE ${label}: ${file}:${line}`);
    problems++;
  }
}

if (problems > 0) {
  console.error(`\n${problems} problem(s) found. Do not push.`);
  process.exit(1);
}
console.log(`Scanned ${tracked.length} tracked files. No secrets found.`);
