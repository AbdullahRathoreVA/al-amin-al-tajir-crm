# Architecture

## The one rule

The public website is simple for parents. The Command Center is powerful for
staff. Neither is compromised to serve the other, and they meet at exactly one
place: a signed event posted to `/api/v1/ingest`.

```
PARENT / PUBLIC WEBSITE   (Astro, static + one function, on Vercel)
        |
        |  POST, HMAC-SHA256 over the raw body, 5-minute timestamp window
        v
SECURE EVENT ENDPOINT     (/api/v1/ingest)
        |
CRM SERVICE               (Node, zero runtime dependencies)
        |
LOCAL DATABASE            (SQLite, WAL, FTS5, on local disk)
        |
OPTIONAL INTEGRATIONS     (Google Sheets, AI, email - all off by default)
```

The website has no database credentials, no schema knowledge beyond the shared
contract, and no route into the CRM other than that one endpoint.

## Why zero runtime dependencies on the server

The API is built on `node:http` and `node:sqlite` only. This is a deliberate
trade: a router is roughly 150 lines that we own, versus a framework and its
transitive tree that we would have to keep patched. On a system holding
children's records, having nothing to audit is worth more than the convenience.

The web app is not held to this. It uses React, Vite, Tailwind and three.js,
because building those from scratch would be absurd. The distinction is that the
web app is a client: it holds no secrets and enforces no permissions.

## Request path

1. `main.ts` receives the request.
2. `handle()` in `http.ts` matches a route, parses cookies and body, resolves
   the session, and constructs the context.
3. The handler runs. Anything that writes calls `tx()`, and every consequential
   write calls `recordEvent()` inside that same transaction.
4. The result is serialised. `HttpError` becomes its status; anything else
   becomes a 500 with a generic message, and the real error goes to stderr,
   which stays local.

## Why the event store is inside the transaction

`recordEvent()` is called within the same `tx()` as the change it describes. If
the write rolls back, so does its event. The log therefore cannot disagree with
the data, and that single property is what makes the audit trail, the family
timeline, "what changed today" and historical reconstruction all fall out of one
table instead of four subsystems.

The `events` table has `BEFORE UPDATE` and `BEFORE DELETE` triggers that
`RAISE(ABORT)`. Append-only is a database guarantee here, not a habit.

## Ingestion, step by step

`packages/server/src/ingest/pipeline.ts`.

```
verify signature + timestamp
  -> validate against the shared contract
  -> claim the eventId in ingest_events (UNIQUE)   <- idempotency
  -> BEGIN IMMEDIATE
       match or create family                      <- entity resolution
       upsert guardian (fill gaps, never blank)
       upsert child (same first name + no DOB conflict = same child)
       upsert lead (only ever move forward)
       insert registration with the payload verbatim
       recordEvent x2
       create follow-up, task and notification
     COMMIT
  -> queue outbound sync in outbox                 <- after commit, never before
```

Three decisions worth naming:

**Only an exact contact-point match links automatically.** An email or phone hit
scores 0.75 and links. A surname match alone scores 0.2 and produces a flagged
candidate for a human. Silently merging two families costs far more to undo than
clearing a duplicate.

**A lead only ever moves forward.** A late "contact us" must not drag a family
that already booked a tour back to New.

**Outbound work happens after the commit.** If Google Sheets is down, the
registration is already safe. The sync retries from `outbox` on its own.

## Local-first

Everything the CRM does for its core job happens against a local file. There is
no network call on the read path, the write path, search, or the dashboard. WAL
mode means readers never block the writer, which is what makes the UI feel
immediate.

Cloud is additive. Turning off every integration leaves a fully working system.

## Web app

- A ~60 line router, because there are nine routes and no nested layouts.
- `useApi` for reads, with a request-ticket guard so a slow first response
  cannot overwrite a fast second one.
- Polling only while the tab is visible.
- The 3D map is one three.js scene that pauses when the tab is hidden or the
  element scrolls out of view, disposes every resource it creates, and has a 2D
  fallback carrying the same numbers and the same links.

## Deliberate omissions

- No ORM. Ten tables and hand-written SQL is less code than a schema DSL.
- No state library. Server state is fetched per screen; there is no client state
  worth centralising yet.
- No GraphQL. A schema layer over ten resources buys nothing here.
- No vector search. FTS5 wins at this data volume. Revisit on a measurement.
