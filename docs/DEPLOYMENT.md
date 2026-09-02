# Deployment

## The rule

**The CRM never becomes public.** The website moving to a real domain does not
change that. Parents reach the website; the website posts one signed event to
the CRM; nobody else reaches the CRM at all.

## Why not Vercel

This was asked, and the honest answer is that it would fail quietly.

Vercel serverless functions have an **ephemeral filesystem**. Every invocation
may be a fresh container, and anything written to disk is discarded. This CRM's
entire design rests on a local SQLite file: that is where its speed comes from
and why it works with no network. On Vercel it would appear to work for a few
minutes inside one warm container and then start losing families, registrations
and analytics, with no error anywhere.

That is worse than not deploying. A CRM that loses a registration is worse than
no CRM, because staff stop checking the one that never lost anything.

Two ways to have it on Vercel anyway, neither free:

- **Turso (hosted libSQL).** SQLite-compatible, so the schema and FTS5 survive.
  Requires converting every database call from synchronous to asynchronous
  across the whole server, and every query becomes a network round trip.
- **Postgres.** A schema rewrite, and FTS5 becomes `tsvector`.

Both are real options if being on Vercel matters more than the simplicity. The
website stays on Vercel either way; it is stateless, which is what Vercel is
good at.

## Fly.io: the recommended host

A long-running process with a real disk. The code deploys unchanged.

```bash
fly launch --no-deploy --name tiny-stars-crm
fly volumes create crm_data --size 1 --region yyz     # Toronto
fly secrets set \
  CRM_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")" \
  CRM_INGEST_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  CRM_ALLOWED_ORIGIN="https://tiny-stars-demo-titan-2ac2.vercel.app"
fly deploy
```

Then create the first real account:

```bash
fly ssh console -C "sh -lc 'cd /app && CRM_NEW_PASSWORD=... node --disable-warning=ExperimentalWarning packages/server/src/seed/users.ts create you@tinystars.ca \"Your Name\" owner'"
```

`fly.toml` pins `max_machines_running = 1` deliberately. SQLite has one writer,
and two machines would each hold their own volume and silently diverge.

### This is live

The deploy has happened. The CRM runs at **<https://tiny-stars-crm.fly.dev>** in
`production` mode on the `crm_data` volume.

Checked from outside on 2026-09-02:

| Check | Result |
|---|---|
| `GET /healthz` | `{"ok":true}` |
| `GET /api/v1/ingest/ping` | `{"ok":true,"contractVersion":1,"configured":true,"mode":"production"}` |
| `GET /api/v1/families` with no session | `401` |
| `GET /api/v1/auth/me` with no session | `401` |
| `POST /api/v1/auth/login` as `owner@demo.local` | rejected — the demo accounts are gone |
| Security headers | CSP (no `unsafe-inline` on scripts), HSTS, `frame-ancestors 'none'`, `nosniff`, COOP/CORP |

Local still works and is still the right way to develop; `npm start` on
<http://127.0.0.1:4317> is unaffected by any of this, and `npm run demo` gives
you a throwaway populated instance on 4319 that cannot reach the real database.

The Dockerfile is no longer theoretical — it builds and boots. The two bugs
below were found by simulating the image layout before Docker was available,
and both were real; they are kept here because they are the two ways this
particular build can break again.

### Still to do: get it off the public internet

`fly.dev` is reachable by anyone. What protects it today is real — scrypt
password hashing, per-account and per-address sign-in throttling, server-side
capability checks, session tokens stored as hashes, a strict CSP — but the
correct posture for a system holding children's records is that the login page
should not be reachable at all from the open web.

Options, cheapest first:

1. **Tailscale (free tier).** Put the machine on a tailnet and remove the public
   service. Staff install the client once. No code change.
2. **Fly private networking + WireGuard.** Same idea without a third party;
   `flyctl` issues peer configs. More setup per device.
3. **A allow-list at the edge.** Weakest of the three — a daycare's staff are
   not on fixed addresses — but better than nothing as an interim step.

Whichever is chosen, `CRM_INGEST_URL` on the website must be able to reach it,
so the ingest endpoint is the one thing that may need to stay publicly routable.
That is an acceptable exception: it is signature-authenticated, replay-protected
and cannot read anything back.

Two bugs were found and fixed by doing that simulation, both of which would have
crash-looped the container on boot:

1. The server imported `@crm/shared` as a bare specifier, which npm workspaces
   resolve through a `node_modules` symlink that does not survive the copy.
2. Copying the package into `node_modules` instead fails a second way: Node
   refuses to strip TypeScript types for anything under `node_modules`.

The server now imports the shared contract by relative path, so the image needs
no `node_modules` whatsoever.

## Alternatives

- **Railway / Render** — same shape as Fly. Attach a persistent volume, set
  `CRM_DATA_DIR` to it, run the same Dockerfile.
- **Tailscale, staying local** — free and the most private. The CRM never leaves
  your machine and is reachable only from your tailnet. Offline when the laptop
  is, and Vercel needs a route into the tailnet to deliver registrations.

## Before real family data goes in

```bash
npm run prod:check
```

It exits non-zero while anything is blocking, and it is deliberately
pessimistic. It checks:

- `CRM_MODE=production`
- `CRM_SESSION_SECRET` set explicitly and long enough (on a host that replaces
  the filesystem, the auto-generated on-disk key signs everyone out each deploy)
- `CRM_INGEST_SECRET` set, long enough, and **different** from the session
  secret — they are shared with different parties
- `CRM_ALLOWED_ORIGIN` set and https
- no `@demo.local` accounts, all of which have the password `demo1234`
- no synthetic families left (`example.invalid` addresses)
- an active owner exists, and no account has never signed in
- migrations current, database integrity passing

To clear the demo blockers:

```bash
npm run prod:harden              # shows what it would delete
npm run prod:harden -- --force   # actually deletes it
```

The event log is append-only and is not deleted; it still records that the demo
data existed.

## Connecting the website

**Website environment (Vercel → Settings → Environment Variables):**

```
CRM_INGEST_URL     = https://tiny-stars-crm.fly.dev/api/v1/ingest
CRM_INGEST_SECRET  = <the same value as the CRM's>
```

**CRM environment (`fly secrets`):**

```
CRM_INGEST_SECRET  = <the same value>
CRM_ALLOWED_ORIGIN = https://tiny-stars-demo-titan-2ac2.vercel.app
```

Neither may be prefixed `PUBLIC_`. Both are read server-side only.

Verify: `GET https://<site>/api/registration` returns `{"configured": true}`,
and `GET https://<crm>/api/v1/ingest/ping` returns `{"configured": true}`.

Until both are set, the site behaves exactly as it ships: a preview that submits
nothing.

## What is hardened, and what is not

Done:

- Sign-in throttling, per account and per address, tuned so one member of staff
  fumbling a password does not lock out the office (see SECURITY.md)
- `Secure` on the session cookie whenever the request arrived over TLS
- CSP, HSTS (TLS only), `X-Frame-Options`, `Permissions-Policy`,
  `Cross-Origin-Opener-Policy`, `nosniff`, `no-store` on every response
- HMAC + 5-minute replay window + idempotency on the one anonymous endpoint
- `X-Forwarded-For` trusted for throttling only, never for access

Still open, and worth doing before this holds many real families:

- **No encryption at rest.** Fly volumes are encrypted at the platform level;
  the SQLite file itself is not.
- **No automated backup.** Take one and *restore* it once. A backup that has
  never been restored is a guess.
- **No rate limiting on read endpoints.** Sign-in is throttled; the rest is not.
- **No two-factor authentication.**
- Consider putting Cloudflare Access or Tailscale in front, so the login page
  is not reachable from the open internet at all.

## Domain cutover

When the website moves to the production domain:

1. Update `CRM_ALLOWED_ORIGIN` on the CRM.
2. Update `PUBLIC_SITE_URL` and set `PUBLIC_INDEXABLE=true` on the website.

Nothing else changes. The CRM does not care what the website is called.

## Never

- Never commit `.env`, `data/crm.db`, or `data/.session-key`.
- Never use real family data in development. `CRM_MODE=demo` exists for this.
- Never run more than one machine against one volume.
- Never start the voice phase before the website and CRM are both stable.
