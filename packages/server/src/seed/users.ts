/**
 * User administration from the command line.
 *
 *   npm run user:list
 *   npm run user:create -- <login> "<Full Name>" <role>
 *   npm run user:password -- <login>
 *   npm run user:suspend -- <login>
 *   npm run user:activate -- <login>
 *
 * The password is NEVER an argument. It is read from the CRM_NEW_PASSWORD
 * environment variable, or typed at a prompt with echo off. Arguments end up in
 * shell history, in `ps` output, and in any terminal recording.
 *
 * `login` may be an email address or a plain username. It is stored lowercased
 * so signing in is case-insensitive.
 */
import { createInterface } from 'node:readline';
import { connect, one, many, run } from '../db/index.ts';
import { migrateUp } from '../db/migrate.ts';
import { nowIso, newId } from '../core/util.ts';
import { hashPassword, capabilitiesFor, type Role } from '../core/auth.ts';
import { recordEvent, SYSTEM } from '../core/events.ts';

const ROLES: Role[] = ['owner', 'director', 'admissions', 'educator', 'accounting', 'readonly'];

const MIN_PASSWORD = 12;

/** Reads a password without echoing it to the terminal. */
function promptSecret(label: string): Promise<string> {
  const env = process.env.CRM_NEW_PASSWORD;
  if (env) return Promise.resolve(env);

  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error(
        'No TTY to prompt on. Set CRM_NEW_PASSWORD in the environment instead:\n' +
        '  CRM_NEW_PASSWORD=... npm run user:password -- <login>',
      ));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout;
    // Swallow the echoed characters so the password never appears on screen.
    const original = out.write.bind(out);
    let muted = false;
    (out as { write: (s: string) => boolean }).write = (chunk: string) =>
      muted ? true : original(chunk);

    rl.question(`${label}: `, (answer) => {
      (out as { write: (s: string) => boolean }).write = original;
      out.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

function findUser(login: string) {
  return one<{ id: string; email: string; name: string; role: Role; status: string }>(
    'SELECT id, email, name, role, status FROM users WHERE email = ?', login.trim().toLowerCase(),
  );
}

function checkPassword(pw: string): void {
  if (pw.length < MIN_PASSWORD) {
    throw new Error(`Password must be at least ${MIN_PASSWORD} characters. Got ${pw.length}.`);
  }
}

export function listUsers(): void {
  const rows = many<{ email: string; name: string; role: Role; status: string; last_login_at: string | null }>(
    'SELECT email, name, role, status, last_login_at FROM users ORDER BY role, email',
  );
  if (!rows.length) { console.log('No users. Create one with: npm run user:create'); return; }
  console.log(`${rows.length} user(s):\n`);
  for (const u of rows) {
    const flag = u.status === 'active' ? ' ' : '!';
    console.log(`${flag} ${u.email.padEnd(28)} ${u.role.padEnd(12)} ${u.name}`);
    console.log(`  ${u.last_login_at ? `last signed in ${u.last_login_at}` : 'never signed in'}`);
  }
}

export async function createUser(login: string, name: string, role: string): Promise<void> {
  if (!ROLES.includes(role as Role)) {
    throw new Error(`Unknown role "${role}". One of: ${ROLES.join(', ')}`);
  }
  const email = login.trim().toLowerCase();
  if (findUser(email)) throw new Error(`"${email}" already exists. Use user:password to change its password.`);

  const password = await promptSecret(`New password for ${email}`);
  checkPassword(password);

  const id = newId();
  run('INSERT INTO users (id, email, name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
    id, email, name, role, hashPassword(password), 'active', nowIso());
  recordEvent({
    entityType: 'user', entityId: id, type: 'created', actor: SYSTEM,
    summary: `User ${email} created with role ${role}`,
    after: { email, role, status: 'active' },
  });

  console.log(`Created ${email} (${role}).`);
  console.log(`Capabilities: ${capabilitiesFor(role as Role).join(', ')}`);
}

export async function setPassword(login: string): Promise<void> {
  const u = findUser(login);
  if (!u) throw new Error(`No user "${login}". List them with: npm run user:list`);

  const password = await promptSecret(`New password for ${u.email}`);
  checkPassword(password);

  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  // Changing a password signs out every other device. That is the point of
  // changing it.
  const revoked = run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    nowIso(), u.id).changes;
  recordEvent({
    entityType: 'user', entityId: u.id, type: 'password_changed', actor: SYSTEM,
    summary: `Password changed for ${u.email}; ${revoked} session(s) revoked`,
  });
  console.log(`Password updated for ${u.email}. ${revoked} active session(s) signed out.`);
}

export function setStatus(login: string, status: 'active' | 'suspended'): void {
  const u = findUser(login);
  if (!u) throw new Error(`No user "${login}".`);
  run('UPDATE users SET status = ? WHERE id = ?', status, u.id);
  if (status === 'suspended') {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), u.id);
  }
  recordEvent({
    entityType: 'user', entityId: u.id, type: 'status_changed', actor: SYSTEM,
    summary: `User ${u.email} ${status}`,
    before: { status: u.status }, after: { status },
  });
  console.log(`${u.email} is now ${status}.`);
}

if (process.argv[1]?.endsWith('users.ts')) {
  await connect();
  migrateUp();
  const [, , cmd, a, b, c] = process.argv;
  try {
    switch (cmd) {
      case 'list': listUsers(); break;
      case 'create':
        if (!a || !b || !c) throw new Error('Usage: user:create -- <login> "<Full Name>" <role>');
        await createUser(a, b, c);
        break;
      case 'password':
        if (!a) throw new Error('Usage: user:password -- <login>');
        await setPassword(a);
        break;
      case 'suspend': if (!a) throw new Error('Usage: user:suspend -- <login>'); setStatus(a, 'suspended'); break;
      case 'activate': if (!a) throw new Error('Usage: user:activate -- <login>'); setStatus(a, 'active'); break;
      default:
        console.log('Commands: list | create | password | suspend | activate');
        console.log('  npm run user:create -- tinystarscanada "Tiny Stars Canada" owner');
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  process.exit(0);
}
