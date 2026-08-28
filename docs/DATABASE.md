# Database

SQLite. One file, `data/crm.db`. WAL mode, foreign keys on, `synchronous=NORMAL`
(still crash-safe under WAL, without an fsync per commit).

## Conventions

- **IDs are TEXT uuid4.** Portable and mergeable, so these databases can be
  synced between devices later without sequence collisions.
- **Timestamps are TEXT ISO-8601 UTC.** Sortable as text, no timezone bugs.
- **Every operational record carries** `source`, `source_id`, `created_at`,
  `updated_at`, `created_by`, `updated_by`. A record can always answer where it
  came from.
- **Privacy flags are columns**, not conventions, so they can be enforced by
  query rather than by remembering.
- **`NULL` means "not recorded"** and is never rendered as `0`. "We counted and
  found none" and "we never counted" are different claims.

## Tables

| Table | Holds |
|---|---|
| `users`, `sessions` | Staff accounts and login sessions |
| `families` | The central record: status, owner, privacy flags, duplicate link |
| `guardians` | Many per family. Normalised email/phone for matching |
| `children` | Many per family. DOB is sensitive and permission-gated |
| `programs`, `classrooms` | Reference data |
| `lead_stages` | Configurable pipeline stages |
| `leads` | Carries the next action, its due date and its reason |
| `tours` | Requested through completed |
| `registrations` | Includes `payload_json`: the parent's submission, verbatim |
| `waitlist` | Per child, per program |
| `tasks`, `notes` | Work and free text |
| `events` | Append-only change log, enforced by trigger |
| `access_log` | Who read what. Reads are not changes, but still answerable |
| `ingest_events` | The idempotency ledger |
| `outbox` | Outbound sync queue with retry and dead-letter states |
| `notifications` | With `dedupe_key`, so five related events become one alert |
| `settings` | Key/value |
| `search_index` | FTS5 virtual table |

## Matching columns

`guardians.email_norm` is lowercased. `guardians.phone_norm` is digits only,
last 10, so `+1 (416) 555-0134` and `4165550134` are the same person. Both are
indexed (partial, `WHERE NOT NULL`), both written by code and never edited by
hand.

## Search

`search_index` is a standalone FTS5 table using
`unicode61 remove_diacritics 2`. It is written by the code paths that change
data, not by triggers: a trigger would fire mid-transaction on partially-written
rows. `reindexAll()` rebuilds it from the operational tables and is cheap at
this scale.

User input never reaches `MATCH` raw. Each word is quoted and given a prefix
wildcard, so operators become literal words and a malformed query returns no
results rather than a 500.

## Migrations

One `.sql` file per migration, with `-- +up` and `-- +down` sections. A missing
`-- +down` is a hard error: every migration needs a rollback path.

```bash
npm run db:migrate                                    # apply pending
node packages/server/src/db/migrate.ts status         # what is applied
node packages/server/src/db/migrate.ts down           # roll back the last one
node packages/server/src/db/migrate.ts verify         # up -> down -> up
```

Applying records the file's SHA-256. Editing an already-applied migration is
detected and refused, because every other database is already past it. Write a
new migration instead.

## Indexes

Built for the queries the app actually runs: family status and owner; guardian
email and phone; children by family and program; leads by stage and due date;
tours by date and status; tasks by status/due and by owner; events by entity and
by time.

Performance at 100k rows has **not been benchmarked**. The indexes are designed
for it, which is a different claim from having measured it.

## Backup

The database is one file. Stop the app and copy `data/crm.db`, or use SQLite's
online backup API. Under WAL you must also copy `-wal` and `-shm`, or checkpoint
first. Scheduled backups and a restore-test workflow are Phase 6; until then the
boot health check reports backup age as `unknown` rather than pretending.
