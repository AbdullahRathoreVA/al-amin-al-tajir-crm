# Security

## Threat model

This system holds names, contact details and dates of birth for children. The
realistic threats are: a lost or stolen laptop, a staff member seeing more than
their role warrants, spam or forged submissions from the internet, and the
database file ending up somewhere it should not.

It is not designed to survive a determined attacker with local root. It is
designed so that ordinary mistakes are not catastrophic.

## Authentication

- Passwords: **scrypt** (N=16384, r=8, p=1, 64-byte key, 16-byte random salt),
  from `node:crypto`. Memory-hard, in the standard library, no native module.
- A failed login on a non-existent account still runs a hash, so response timing
  does not enumerate accounts.
- Session tokens are 32 random bytes. **Only the SHA-256 is stored.** A stolen
  database file does not yield live sessions.
- Cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, with an explicit expiry.
- Sessions last 14 days and can be listed and revoked per device.

## Authorisation

Capability-based, not screen-based. `family:read` is a different question from
`child:read_sensitive`, and `data:export` is its own capability: being allowed
to see a family is not being allowed to walk out with every family.

| Role | Notable limits |
|---|---|
| owner | Everything |
| director | Everything except `user:manage` |
| admissions | No sensitive child data, no export, no audit |
| educator | Assigned work only. No DOB, no export, no pipeline |
| accounting | Read plus export. No write |
| readonly | Read only |

Dates of birth are **omitted from the response** for roles without
`child:read_sensitive`, not nulled. The UI cannot accidentally render a withheld
field as "not recorded".

## The inbound endpoint

`/api/v1/ingest` is the only route reachable without a session, and it is
authenticated by:

1. **HMAC-SHA256** over the exact raw request body, compared with
   `timingSafeEqual`. Changing one byte invalidates it.
2. **A 5-minute timestamp window**, so a captured request cannot be replayed
   indefinitely.
3. **Contract validation** before anything is written.
4. **Idempotency** on `eventId`, so a replay inside the window is a no-op that
   returns the original result.

CORS is granted only to `CRM_ALLOWED_ORIGIN`, and only on this route.

## Sign-in throttling

Failed sign-ins back off exponentially: five free attempts, then 2s doubling to
a 15 minute cap, forgotten after an hour of quiet. A correct password clears the
account.

Two counters, and they behave differently on purpose:

- **Per account** carries the escalating lock.
- **Per address** only counts, and trips at a much higher sweep cap (50 failures
  across any accounts).

The address deliberately does NOT get the escalating lock. Every member of staff
shares one office address, so applying it there meant one person fumbling their
password locked out every colleague sitting next to them. Found by hammering the
real endpoint, not by reading the code.

 is trusted for throttling only, never for anything that grants
access.

## Input handling

- Bodies are capped at 1 MB; the registration route on the website caps at 32 KB.
- Control characters are stripped. Free text keeps newlines and tabs; names,
  emails and dates do not.
- All SQL uses positional parameters. There is no string interpolation of user
  input into SQL anywhere in the codebase.
- Static file serving resolves and then verifies the path is inside the build
  directory, so `../` cannot walk the disk.
- Errors returned to clients are generic. Real errors go to stderr, locally.

## Secrets

- Never in source. `.env` is gitignored; `.env.example` carries names only.
- The session key, if not supplied, is generated on first run and written to
  `data/.session-key` with mode `0600`.
- The ingest secret is read server-side only. On the website it is read inside a
  serverless function and is never prefixed `PUBLIC_`, so it cannot reach a
  browser bundle. That lookup is deliberately dynamic to stop Vite statically
  inlining the value into a build artifact.

## Privacy controls

- `families.local_only`, `families.no_ai`, `families.no_sync` are columns, so
  they are enforceable in a `WHERE` clause rather than by discipline.
- `access_log` records reads of sensitive records, separately from `events`.
- Cloud AI is off by default, and no code path sends data anywhere without
  explicit configuration.

## Deployment

Bind to `127.0.0.1`. Do not put this on a public port. For team access use a VPN
or a Tailscale-style private network. See DEPLOYMENT.md.

## Known gaps

Stated rather than glossed over:

- **No encryption at rest.** The SQLite file is plaintext on disk. Use full-disk
  encryption (BitLocker, FileVault). SQLCipher would need a native module, which
  is the same trade-off deferred with Tauri.
- **No rate limiting beyond login and the body cap.** Sign-in is throttled (see
  below); the read endpoints are not. That matters the moment this is exposed
  beyond loopback.
- **The website's rate limit is best-effort.** A serverless function has no
  shared memory, so it only slows a burst landing on one warm instance. Real
  rate limiting belongs at the edge.
- **No two-factor authentication.**
- **No automated dependency scanning yet**, though the server has no runtime
  dependencies to scan.
- **Performance at 100k rows is not benchmarked.** The indexes are designed for
  it; that is a different claim from having measured it.
