# Google Sheets

## Status: built, not connected.

The sending machinery is done and tested: batching, exponential backoff with
jitter, a bounded retry that ends in a dead-letter, `families.no_sync` enforced
in the selecting query, an editable column mapping, and a run log that records
the attempts that did nothing as well as the ones that sent.

What is missing is a Google account to send to. Three secrets are required:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

Until all three are set, `/system` reports the channel as **not connected**
with that exact reason, queued rows wait rather than failing, and the health
check reads `unknown` rather than warning about a backlog nobody can clear.

**One caveat, stated plainly.** `core/transports/sheets.ts` is the only file in
this repository that has never been run against the real thing, because that
needs a Google Cloud project that cannot be created from the build. Its two
HTTP calls and its reading of Google's replies are unverified. Watch the first
real run rather than trusting it; everything it depends on is tested.

## The rule that decides the design

**The CRM database is the source of truth. Google Sheets is an integration
surface, not a database.** A spreadsheet is where staff want to read and
occasionally edit; it is not where the canonical record lives.

## Intended behaviour

```
Parent submits on the website
  -> CRM creates the family, child and registration      (already works)
  -> outbox row queued                                   (already works)
  -> worker appends a row to the configured Sheet        (Phase 3)
  -> CRM logs the sync result
```

If Sheets is unavailable the registration is already safe in the CRM and the
row retries. That ordering is not negotiable.

## Auth

OAuth, via Google's official flow. Specifically:

- **Never ask a user to paste a Google password into the CRM.**
- Request the narrowest workable scope. `spreadsheets` for a known sheet ID.
  Avoid broad `drive` scope; if a picker is needed later, `drive.file` grants
  access only to files the user explicitly chose.
- Store the refresh token in the OS keychain where available, not in the
  database.

## Column mapping

A saved mapping per sheet, edited in the UI:

```
Parent Name  -> guardian.fullName
Email        -> guardian.email
Phone        -> guardian.phone
Child Name   -> child.firstName
DOB          -> child.dateOfBirth
Program      -> programInterest
Start Date   -> desiredStart
Notes        -> notes
```

Mappings are stored in `settings`, so a sheet's shape can change without a code
change.

## Conflicts

When the CRM says A and the sheet says B, show a conflict. Options: CRM wins,
sheet wins, merge, review later.

**Never silently overwrite.** Last-write-wins may be acceptable for a low-stakes
free-text field; it is not acceptable for a contact detail or anything
financial, which require a person to choose.

## Quotas

The Sheets API has documented per-minute read and write limits. Design for them
rather than discovering them:

- Batch writes; do not send one request per row.
- Exponential backoff with jitter on `429` and `5xx`.
- Bounded retries, then the dead-letter state, which is already visible in
  `/system`.
- Never poll tightly. A scheduled reconciliation beats a hot loop.

## Sync log

Display last sync, imported, exported, updated, duplicates, conflicts, errors,
and a retry control. The `outbox` table already carries `attempts`,
`last_error` and `next_retry_at` to back this.

## Privacy

Honour `families.no_sync`. It is a column precisely so the query that selects
rows to send can exclude them, rather than relying on someone remembering.
