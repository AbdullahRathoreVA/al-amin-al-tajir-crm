# Tiny Stars Command Center

Private, local-first operations system for a childcare business. It is the staff
side of the Tiny Stars ecosystem: the public website talks to families, this
talks to the team.

**This repository is private and must stay private.** It is designed to hold
records about children.

---

## Run it

You need **Node 22.5 or newer**. Nothing else — no Rust, no build tools, no
database server, no Docker.

```bash
npm install
npm run db:migrate
npm run db:seed
npm run build
npm start
```

Open <http://127.0.0.1:4317> and sign in with `owner@demo.local` / `demo1234`.

For development with hot reload, run the API and the web dev server in two
terminals:

```bash
npm run dev:server
```

```bash
npm run dev:web
```

The web dev server is on <http://localhost:4318> and proxies `/api` to the API,
so the app is same-origin in development exactly as it is in production.

### Demo accounts

| Email | Role | Sees |
|---|---|---|
| `owner@demo.local` | owner | Everything, including user management |
| `director@demo.local` | director | Everything except user management |
| `admissions@demo.local` | admissions | Pipeline, families, tours, registrations |
| `educator@demo.local` | educator | Assigned children and tasks. **No** dates of birth, **no** export |

Password for all four: `demo1234`. They exist only in demo mode.

### Real accounts

Managed from the command line. The password is **never** an argument — arguments
land in shell history, in `ps` output, and in terminal recordings. It is read
from a hidden prompt, or from `CRM_NEW_PASSWORD` when scripting.

```bash
npm run user:list
npm run user:create -- <login> "<Full Name>" <role>    # prompts for the password
npm run user:password -- <login>                       # rotate; signs out every device
npm run user:suspend -- <login>
npm run user:activate -- <login>
```

`<login>` may be an email address or a plain username, and is matched
case-insensitively. `<role>` is one of `owner`, `director`, `admissions`,
`educator`, `accounting`, `readonly`.

Delete every `@demo.local` account before this holds real data.

---

## What is actually built

Phase 1 and the registration path of Phase 2. Everything listed below works and
has tests behind it.

- **Families, guardians, children, leads, tours, registrations, waitlist, tasks,
  notes** — full data model, with siblings and multiple guardians per family.
- **Website registration intake** — a parent submits on the public site and the
  record is in here within seconds. Nobody retypes anything. Sending the same
  submission twice does not create a duplicate.
- **Append-only event store** — every change is recorded, enforced by database
  triggers rather than convention. Powers the family timeline, the audit log and
  historical state.
- **Attention radar and follow-up engine** — overdue follow-ups, unreviewed
  registrations, unconfirmed tours and failed integrations, each linking to the
  exact record.
- **Tasks with reasons** — every automatically created task states why it exists.
- **Universal search** — SQLite FTS5 across families, children, guardians, leads,
  tours, registrations, tasks and notes. Prefix matching, so partial typing works.
- **3D command map** — ten nodes sized and coloured by real counts, with a full
  2D fallback that is not a downgrade in capability.
- **Roles and permissions** — capability-based. An educator cannot see a date of
  birth or export the family list.
- **Local-first** — SQLite on disk, WAL mode. No network needed for any of the
  above.

### What is not built

Stated plainly, because a greyed-out button implying otherwise is worse than an
honest gap. The `/system` page lists this in the app too.

| Area | Phase |
|---|---|
| Google Sheets two-way sync, Excel import/export | 3 |
| Local AI assistant, natural-language search, AI briefings | 4 |
| Attendance, classrooms, documents, incidents, staff module | 6 |
| Email, calendar, billing | 7 |
| Team sync between devices | 9 |
| Voice agents | 10 |

The event contract already accepts the shape voice agents will send. Nothing
emits it, and no telephony code exists.

---

## Architecture

```
  PARENT  ->  public website (Astro, Vercel)
                    |
                    |  HMAC-signed event over HTTPS
                    v
              /api/v1/ingest
                    |
              CRM service (Node, zero runtime dependencies)
                    |
              SQLite (WAL, FTS5) on local disk
                    |
              optional, all off by default:
              Google Sheets · AI · email
```

The website never touches the database. It posts a signed event to one
authenticated endpoint. That is the entire boundary.

**Zero runtime dependencies on the server.** The API uses only `node:http` and
`node:sqlite`. On a system holding children's records, having no transitive
supply chain to audit is worth more than the convenience a framework buys.

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Stack, and why

Your specification proposed a stack. Some of it was right and some of it was
not; here is the honest accounting.

| Proposed | Decision | Reason |
|---|---|---|
| SQLite, WAL, FTS5 | **Adopted** | Correct. Fast, local, and FTS5 removes the need for a search service. |
| React + TypeScript strict + Tailwind | **Adopted** | The website is Astro with no React, but the CRM is interaction-heavy. |
| Tauri 2 | **Deferred** | Needs Rust and MSVC build tools on every machine. Runs in a browser today; Tauri can wrap the same code later with no rework. |
| shadcn/ui | **Not used** | Pulls in Radix and a copy-in CLI. The control-room look is bespoke; the handful of primitives needed are in `packages/web/src/ui/kit.tsx`. |
| sqlite-vec / vector search | **Deferred** | A daycare has hundreds of families, not millions. FTS5 wins at this scale. Revisit on a measurement, not a hunch. |
| Ollama / local AI | **Phase 4** | Core CRUD must work with AI switched off, which means building it that way first. |
| GraphQL | **Not used** | Would add a schema layer over ten resources for no gain. |

`better-sqlite3` is honoured if it is installed — the driver in
`packages/server/src/db/driver.ts` prefers it and falls back to Node's built-in
`node:sqlite`. Neither choice is locked in.

---

## Testing

```bash
npm test          # 27 tests
npm run typecheck
```

The suite runs against a real SQLite database in a temp directory. No mocks: the
thing worth testing is how validation, matching, transactions and the event
store behave together, and a mock would just agree with whatever was assumed.

It covers the cases that actually bite:

- the same registration submitted twice creates **one** family
- a second child from the same email is a **sibling**, not a duplicate
- a surname-only match creates a separate family and **flags it for a human**
- the event log physically rejects `UPDATE` and `DELETE`
- a tampered HMAC signature is refused
- an educator cannot export data or read a date of birth
- a search box full of FTS operators returns results instead of a 500
- line breaks a parent typed survive into the record

Migrations are tested by rolling back and re-applying:

```bash
npm run db:migrate verify
```

---

## Data and privacy

- **No real family data in development.** `CRM_MODE=demo` seeds synthetic
  records and shows a banner on every screen. `CRM_MODE=production` refuses to
  seed or reset.
- Demo children have a first name and an age band. No surnames, no dates of
  birth, no health information — a demo should model good data hygiene, not just
  look full.
- Dates of birth are permission-gated. Roles without `child:read_sensitive` get
  the column omitted from the response entirely, not blanked in the UI.
- Every family can be marked `local only`, `never send to AI` or `never sync`.
  These are database columns so they can be enforced by query.
- Reads of sensitive records are recorded in `access_log`, separately from the
  change log.
- Passwords use scrypt. Session tokens are stored as SHA-256 hashes, so a stolen
  database file does not hand over live sessions.

See [docs/SECURITY.md](docs/SECURITY.md).

---

## Connecting the website

The public website repo (`tiny-stars-ai`) holds the client half. Both are off by
default: with either variable unset the site behaves exactly as it ships, a
preview that submits nothing.

In the **CRM** environment:

```
CRM_INGEST_SECRET=<32 random bytes as hex>
CRM_ALLOWED_ORIGIN=https://tiny-stars-demo-titan-2ac2.vercel.app
```

In the **website** environment:

```
CRM_INGEST_URL=https://<private-crm-host>/api/v1/ingest
CRM_INGEST_SECRET=<the same value>
```

Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`CRM_INGEST_URL` must not be a public address. Put the CRM behind a VPN or a
Tailscale-style private network. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

The event schema is shared, not duplicated:
`packages/shared/src/contract.ts` is the source of truth and is copied verbatim
into the website. `node scripts/check-crm-contract.mjs` in the website repo
fails if the two have drifted.

---

## Repository layout

```
packages/
  shared/    the website <-> CRM event contract. Zero dependencies, so both
             an Astro site and a Node server can run the identical code.
  server/    API and database. Zero runtime dependencies.
    src/core/      auth, events, matching, search, notifications, queries
    src/db/        driver, migrations, migration runner
    src/ingest/    the registration pipeline
  web/       React app. Vite, Tailwind, three.js.
docs/        architecture, database, API, security, integrations, deployment
tests/       the suite described above
data/        the SQLite file. Gitignored. Never commit it.
```

---

## Backups

The database is a single file at `data/crm.db`. Copy it while the app is
stopped, or use SQLite's online backup. Scheduled backups and a restore-test
workflow are Phase 6; until then the boot health check reports backup age as
`unknown` rather than pretending.

---

## Licence

Private and unlicensed. Not for distribution.
