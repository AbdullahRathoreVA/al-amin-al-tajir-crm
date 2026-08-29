/**
 * Authentication and role permissions.
 *
 * Passwords use scrypt from node:crypto — memory-hard, in the standard library,
 * and therefore not a native module your friend has to compile. Session tokens
 * are random 32-byte values; only their SHA-256 is stored, so a stolen database
 * file does not hand over live sessions. (spec 161 / 162)
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one, many, run } from '../db/index.ts';
import { newId, nowIso, sha256, plain } from './util.ts';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 } as const;
const SESSION_DAYS = 14;

export type Role = 'owner' | 'director' | 'admissions' | 'educator' | 'accounting' | 'readonly';

export interface User {
  id: string; email: string; name: string; role: Role;
  status: 'active' | 'suspended'; created_at: string; last_login_at: string | null;
}

// ------------------------------------------------------------------ passwords

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltHex, keyHex] = parts;
  try {
    const salt = Buffer.from(saltHex!, 'hex');
    const expected = Buffer.from(keyHex!, 'hex');
    const actual = scryptSync(password, salt, expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

// ------------------------------------------------------------------- sessions

export interface SessionResult { token: string; expiresAt: string; user: User }

export function login(email: string, password: string, userAgent?: string): SessionResult | null {
  // Explicit, including the hash, because this is the one place that needs it.
  // The destructure below removes it again before anything is returned.
  const row = one<User & { password_hash: string }>(
    `SELECT id, email, name, role, status, created_at, last_login_at, password_hash
       FROM users WHERE email = ? AND status = ?`,
    email.trim().toLowerCase(), 'active',
  );
  // Hash anyway when the user is missing, so a wrong email and a wrong password
  // take the same time. Otherwise response timing enumerates accounts.
  if (!row) { verifyPassword(password, hashPassword('decoy')); return null; }
  if (!verifyPassword(password, row.password_hash)) return null;

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  run('INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent) VALUES (?,?,?,?,?,?)',
    newId(), row.id, sha256(token), nowIso(), expiresAt, userAgent ?? null);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), row.id);

  const { password_hash: _drop, ...user } = row;
  return { token, expiresAt, user: { ...user } as User };
}

/**
 * Columns that may leave this module. Written out rather than `u.*` because
 * `u.*` shipped the scrypt hash of every signed-in user's password straight to
 * the browser via /auth/me. TypeScript could not catch it: the row was typed as
 * `User`, which has no password_hash, so the annotation was simply a lie about
 * what SQL returned. Only reading an actual response caught it.
 *
 * Never put `*` in a query whose result reaches a client.
 */
const USER_COLUMNS = 'u.id, u.email, u.name, u.role, u.status, u.created_at, u.last_login_at';

export function userForToken(token: string | null | undefined): User | null {
  if (!token) return null;
  const row = one<User>(
    `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`,
    sha256(token), nowIso(),
  );
  return plain(row) ?? null;
}

export function logout(token: string): void {
  run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL', nowIso(), sha256(token));
}

export function sessionsFor(userId: string) {
  return many(
    `SELECT id, created_at, expires_at, revoked_at, user_agent FROM sessions
     WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, userId,
  );
}

export function revokeSession(id: string, userId: string): boolean {
  return run('UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
    nowIso(), id, userId).changes > 0;
}

export function createUser(email: string, name: string, role: Role, password: string): User {
  const id = newId();
  run('INSERT INTO users (id, email, name, role, password_hash, status, created_at) VALUES (?,?,?,?,?,?,?)',
    id, email.trim().toLowerCase(), name, role, hashPassword(password), 'active', nowIso());
  return one<User>('SELECT id,email,name,role,status,created_at,last_login_at FROM users WHERE id = ?', id)!;
}

// ---------------------------------------------------------------- permissions

/**
 * Capability strings, not booleans-per-screen. `family:read` is a different
 * question from `child:read_sensitive`, and export is deliberately its own
 * capability — being allowed to see a family is not being allowed to walk out
 * with every family. (spec 163 / 164 / 165)
 */
export type Capability =
  | 'family:read' | 'family:write'
  | 'child:read' | 'child:read_sensitive' | 'child:write'
  | 'lead:read' | 'lead:write'
  | 'tour:read' | 'tour:write'
  | 'registration:read' | 'registration:write'
  | 'task:read' | 'task:write'
  | 'classroom:read' | 'classroom:write'
  | 'attendance:read' | 'attendance:write'
  | 'note:write'
  | 'data:export'
  | 'audit:read'
  | 'user:manage'
  | 'settings:write'
  | 'demo:reset';

const ALL: Capability[] = [
  'family:read', 'family:write', 'child:read', 'child:read_sensitive', 'child:write',
  'lead:read', 'lead:write', 'tour:read', 'tour:write', 'registration:read', 'registration:write',
  'task:read', 'task:write', 'classroom:read', 'classroom:write',
  'attendance:read', 'attendance:write', 'note:write', 'data:export', 'audit:read',
  'user:manage', 'settings:write', 'demo:reset',
];

const ROLES: Record<Role, Capability[]> = {
  owner: ALL,
  director: ALL.filter((c) => c !== 'user:manage'),
  admissions: [
    'family:read', 'family:write', 'child:read', 'child:write',
    'lead:read', 'lead:write', 'tour:read', 'tour:write',
    'registration:read', 'registration:write', 'task:read', 'task:write', 'note:write',
    // Placement is an admissions question: which room has space, and when.
    // Not attendance, which is about children already in the building.
    'classroom:read',
  ],
  // An educator sees the children in their care, not the sales pipeline and not
  // dates of birth by default.
  // Marking the register is the educator's core job, so they get attendance
  // write. The capability says "may mark attendance"; it does not say whose.
  // classroom_staff decides that, and an educator with no room sees nobody.
  educator: [
    'family:read', 'child:read', 'task:read', 'task:write', 'note:write', 'tour:read',
    'classroom:read', 'attendance:read', 'attendance:write',
  ],
  // Billing follows the register, so accounting reads attendance and never
  // writes it. An invoice must not be able to edit the day it bills for.
  accounting: [
    'family:read', 'child:read', 'registration:read', 'task:read', 'data:export',
    'classroom:read', 'attendance:read',
  ],
  readonly: [
    'family:read', 'child:read', 'lead:read', 'tour:read', 'registration:read', 'task:read',
    'classroom:read', 'attendance:read',
  ],
};

export function can(user: Pick<User, 'role'> | null, cap: Capability): boolean {
  if (!user) return false;
  return ROLES[user.role]?.includes(cap) ?? false;
}

export function capabilitiesFor(role: Role): Capability[] { return ROLES[role] ?? []; }

/** Roles that may see a date of birth. Everyone else gets the age band. */
export function canSeeSensitive(user: User | null): boolean {
  return can(user, 'child:read_sensitive');
}
