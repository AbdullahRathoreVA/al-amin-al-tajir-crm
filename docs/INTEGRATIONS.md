# Integrations

## Principle

Every integration is optional, and every one fails gracefully. Turning them all
off leaves a fully working CRM. That is not a nice-to-have; it is why the
outbound queue exists.

## What is wired today

| Integration | Status | Notes |
|---|---|---|
| Public website intake | **Live** | HMAC-signed events, idempotent, tested end to end |
| Google Sheets | Not built (Phase 3) | Events already queue in `outbox` |
| Excel / CSV | Not built (Phase 3) | |
| Email | Not built (Phase 7) | |
| Calendar | Not built (Phase 7) | |
| Voice | Not started (Phase 10) | Contract reserved, see VOICE-FUTURE.md |

`/system` in the app shows this same list. Nothing unbuilt is shown as green.

## The outbox

`packages/server/src/ingest/pipeline.ts` queues outbound work **after** the CRM
transaction commits. This ordering is the whole design:

> If the CRM write succeeded and Google Sheets is down, the registration is
> safe and the sync retries. The reverse — losing a registration because a
> spreadsheet was unreachable — must never be possible.

Rows carry `status` (`pending` / `sent` / `failed` / `dead`), `attempts`,
`next_retry_at` and `last_error`. Anything that ends up `failed` or `dead`
appears on the attention radar and on `/system`, where a person can see it.
Failed integrations must land somewhere a human looks, not in a log file.

Retries are bounded with backoff. Nothing retries forever.

## Adding one

1. Write to `outbox` with a new `channel`, after the transaction commits.
2. Add a worker that claims `pending` rows for that channel.
3. On success, `status = 'sent'`. On failure, increment `attempts`, set
   `next_retry_at` with backoff, record `last_error`; past the cap, `dead`.
4. Add a check to `systemHealth()` in `core/queries.ts` that reports a real
   state — `unknown` while unconfigured, never `good`.
5. Honour `families.no_sync`. It is a column so it can be enforced in the query
   that selects what to send.

## Excel and CSV (Phase 3, designed)

Import is a wizard, not a button: upload, scan, preview, map columns, validate,
duplicate-check, show the exact record count, confirm, import, report.

Two rules decided now:

- **Show the count before importing.** "428 records detected. Continue?"
- **Imported files are untrusted.** Validate every cell; never evaluate formulas
  or anything that arrives in a file.

Every imported record keeps its `source`, `source_id` and an import batch ID, so
"where did this come from" is answerable a year later.

Export is permission-gated behind `data:export`, which `educator` does not hold,
and every export is logged.
