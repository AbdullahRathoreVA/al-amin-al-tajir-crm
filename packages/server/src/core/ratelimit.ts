/**
 * Login throttling.
 *
 * In-memory, which is correct here specifically because the CRM is one
 * long-lived process with one database. (The website's equivalent is
 * best-effort precisely because a serverless function is not.)
 *
 * Two counters, deliberately:
 *   - per account, so one account cannot be ground down from many addresses;
 *   - per source address, so one address cannot sweep many accounts.
 *
 * Failures back off exponentially and a success clears the account's counter,
 * so a person who mistypes twice and then gets it right is never punished.
 */

interface Bucket { failures: number; lockedUntil: number; last: number }

const byAccount = new Map<string, Bucket>();
const byAddress = new Map<string, Bucket>();

/** Free attempts before backoff starts. */
const FREE_ATTEMPTS = 5;
/** Doubling from 2s, capped: 2, 4, 8 ... 15 min. */
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 15 * 60_000;
/** A quiet hour forgets you entirely. */
const FORGET_AFTER_MS = 60 * 60_000;
/** An address sweeping accounts is a different, blunter problem. */
const ADDRESS_ATTEMPT_CAP = 50;

function sweep(map: Map<string, Bucket>, now: number): void {
  if (map.size < 500) return;
  for (const [k, b] of map) if (now - b.last > FORGET_AFTER_MS) map.delete(k);
}

function get(map: Map<string, Bucket>, key: string, now: number): Bucket {
  const existing = map.get(key);
  if (existing && now - existing.last <= FORGET_AFTER_MS) return existing;
  const fresh: Bucket = { failures: 0, lockedUntil: 0, last: now };
  map.set(key, fresh);
  return fresh;
}

export interface LimitVerdict { allowed: boolean; retryAfterSeconds: number }

/** Called before a password is checked. */
export function checkLoginAllowed(account: string, address: string): LimitVerdict {
  const now = Date.now();
  sweep(byAccount, now);
  sweep(byAddress, now);

  const a = get(byAccount, account.toLowerCase(), now);
  const ip = get(byAddress, address, now);

  const lockedUntil = Math.max(a.lockedUntil, ip.lockedUntil);
  if (lockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
  }
  if (ip.failures > ADDRESS_ATTEMPT_CAP) {
    return { allowed: false, retryAfterSeconds: Math.ceil(MAX_DELAY_MS / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

export function recordLoginFailure(account: string, address: string): void {
  const now = Date.now();

  // The escalating lock applies to the ACCOUNT only.
  const a = get(byAccount, account.toLowerCase(), now);
  a.failures++;
  a.last = now;
  if (a.failures > FREE_ATTEMPTS) {
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (a.failures - FREE_ATTEMPTS - 1));
    a.lockedUntil = now + delay;
  }

  // The address only ever counts, and only trips at the far higher sweep cap.
  //
  // It must NOT get the escalating lock: a nursery's staff all share one office
  // address, so one person fumbling their password would otherwise lock out
  // every colleague at the same time. Learned by testing it.
  const ip = get(byAddress, address, now);
  ip.failures++;
  ip.last = now;
}

/**
 * A correct password clears the account and lifts the lock on the address it
 * came from.
 *
 * Lifting the address lock is deliberate. Without it, a staff member who
 * mistypes six times and then gets it right is locked out immediately AFTER
 * succeeding, which is both baffling and useless: they have just proved they
 * are not an unauthenticated sweep, which is the only thing the address counter
 * defends against.
 *
 * The address's failure tally is halved rather than zeroed, so a real sweep
 * that happens to hold one valid credential still climbs back to the cap
 * quickly instead of resetting for free on every success.
 */
export function recordLoginSuccess(account: string, address?: string): void {
  byAccount.delete(account.toLowerCase());
  if (!address) return;
  const b = byAddress.get(address);
  if (!b) return;
  b.lockedUntil = 0;
  b.failures = Math.floor(b.failures / 2);
}

/** Test seam. */
export function resetLoginLimits(): void {
  byAccount.clear();
  byAddress.clear();
}
