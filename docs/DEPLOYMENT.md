# Deployment

## The rule

**The CRM never becomes public.** The website moving to a real domain does not
change that. Parents reach the website; the website posts one signed event to
the CRM; nobody else reaches the CRM at all.

Do not put this behind a guessable public route "temporarily".

## Now: localhost

The current and correct setup while building.

```bash
npm install && npm run db:migrate && npm run db:seed && npm run build && npm start
```

Bound to `127.0.0.1:4317`. Not reachable from the network.

## Next: private network for the team

When two or more people need it, in preference order:

1. **Tailscale (or equivalent WireGuard mesh).** Install on the machine running
   the CRM and on each staff device. Set `CRM_HOST=0.0.0.0` so it binds to the
   Tailscale interface, and rely on the mesh for access control. Nothing is
   exposed to the internet.
2. **A VPN into the nursery's network**, with the CRM on a fixed internal
   address.
3. **A small private VPS**, firewalled to known IPs, TLS terminated by a
   reverse proxy. Only if 1 and 2 are impossible; it is the largest attack
   surface of the three.

For any of these, before you expose the port:

- [ ] `CRM_MODE=production`
- [ ] `CRM_SESSION_SECRET` set explicitly, not auto-generated
- [ ] Real user accounts created; every `@demo.local` account deleted
- [ ] `npm run db:reset` understood to be disabled in production mode
- [ ] Full-disk encryption on the host (there is no encryption at rest yet)
- [ ] A backup that has been **restored** at least once
- [ ] Rate limiting in front of the ingest endpoint

## Connecting the website

The website is on Vercel. The CRM is not. The website's serverless function must
be able to reach the CRM's private address.

**Website environment (Vercel → Settings → Environment Variables):**

```
CRM_INGEST_URL     = https://crm.your-tailnet.ts.net/api/v1/ingest
CRM_INGEST_SECRET  = <the shared secret>
```

**CRM environment (`.env`):**

```
CRM_INGEST_SECRET  = <the same value>
CRM_ALLOWED_ORIGIN = https://tiny-stars-demo-titan-2ac2.vercel.app
```

Neither may be prefixed `PUBLIC_`. Both are read server-side only.

Generate the secret once, per environment:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Verify from the website: `GET /api/registration` returns
`{"configured": true}`. Verify from anywhere that can reach the CRM:
`GET /api/v1/ingest/ping`.

If Vercel cannot reach a Tailscale address, the options are a Tailscale funnel
restricted to Vercel's egress, or a queue the CRM polls. Do not solve it by
making the CRM public.

## Domain cutover

When the website moves from
`https://tiny-stars-demo-titan-2ac2.vercel.app` to the production domain:

1. Update `CRM_ALLOWED_ORIGIN` in the CRM.
2. Update `PUBLIC_SITE_URL` and set `PUBLIC_INDEXABLE=true` in the website.
3. Nothing else changes. The CRM does not care what the website is called.

## Before production

Your specification, item 344. All of these, not most:

- [ ] Website approved
- [ ] CRM approved
- [ ] Security reviewed against SECURITY.md, including the "known gaps"
- [ ] Data migration tested with real volumes
- [ ] Backup verified by restoring it
- [ ] Rollback plan written down

## Never

- Never commit `.env`, `data/crm.db`, or `data/.session-key`.
- Never use real family data in development. `CRM_MODE=demo` exists for this.
- Never start the voice phase before the website and CRM are both stable.
