# API v1

Versioned in the path so CRM changes cannot break the website. All responses are
JSON. All routes except the two ingest routes require a session cookie.

Base: `http://127.0.0.1:4317/api/v1`

## Errors

```json
{ "error": "Human-readable message", "detail": [ { "path": "...", "message": "..." } ] }
```

| Status | Meaning |
|---|---|
| 400 | Validation failed. `detail` lists the fields |
| 401 | No session, or it expired |
| 403 | Signed in, but your role lacks the capability |
| 404 | No such record or route |
| 413 | Body too large |
| 500 | Server fault. The real error is on the server's stderr, not in the response |

## Auth

| Route | Notes |
|---|---|
| `POST /auth/login` | `{email, password}`. Sets an HttpOnly cookie |
| `POST /auth/logout` | Revokes the current session |
| `GET /auth/me` | Current user, capabilities, mode, active sessions |
| `DELETE /auth/sessions/:id` | Revoke one of your own sessions |

## Reads

| Route | Capability | Notes |
|---|---|---|
| `GET /dashboard` | any | Today, attention, pipeline, programs, data health, tours, follow-ups, alerts |
| `GET /search?q=&types=&limit=` | any | FTS5. Minimum two characters |
| `GET /meta` | any | Stages, programs, assignable users, contract version |
| `GET /families?filter=&status=` | `family:read` | Filters: `duplicates`, `no-contact`, `no-children` |
| `GET /families/:id` | `family:read` | Guardians, children, leads, tours, registrations, tasks, notes, timeline |
| `GET /leads?filter=&stage=` | `lead:read` | Filters: `open`, `overdue`, `unowned`, `stale` |
| `GET /tours?filter=` | `tour:read` | Filters: `today`, `requested`, `upcoming` |
| `GET /registrations?filter=` | `registration:read` | Filters: `submitted`, `incomplete` |
| `GET /registrations/:id` | `registration:read` | Includes the parent's payload verbatim |
| `GET /tasks?filter=` | `task:read` | Filters: `overdue`, `mine`, `done` |
| `GET /notifications` | any | Unread and due-snoozed |
| `GET /events?since=&limit=` | `audit:read` | The change log |
| `GET /events/:type/:id` | `audit:read` | One entity's timeline |
| `GET /system/health` | `audit:read` | Checks, outbox, ingest log |

`GET /families/:id` omits `date_of_birth` entirely unless you hold
`child:read_sensitive`. `sensitiveVisible` in the response tells the UI which it
got.

## Writes

| Route | Capability |
|---|---|
| `PATCH /families/:id` | `family:write` |
| `PATCH /leads/:id` | `lead:write` |
| `PATCH /tours/:id` | `tour:write` |
| `PATCH /registrations/:id` | `registration:write` |
| `POST /tasks`, `PATCH /tasks/:id` | `task:write` |
| `POST /notes` | `note:write` |
| `PATCH /notifications/:id` | any |

Every write records an event with before and after state.

`PATCH /tours/:id` with `status: "completed"` also creates the follow-up task
and sets the lead's next action. Completing a tour never leaves a family with
no next step.

## Ingest

### `GET /ingest/ping`

No auth. Confirms wiring without sending anything.

```json
{ "ok": true, "contractVersion": 1, "configured": true, "mode": "demo" }
```

### `POST /ingest`

No session. Authenticated by signature.

**Headers**

| Header | Value |
|---|---|
| `x-crm-signature` | `sha256=<hex>` or bare hex: HMAC-SHA256 of the raw body with `CRM_INGEST_SECRET` |
| `x-crm-timestamp` | `Date.now()`. Must be within 5 minutes |

**Body**

```json
{
  "eventId": "uuid-v4",
  "type": "registration.created",
  "version": 1,
  "occurredAt": "2026-08-28T12:00:00.000Z",
  "source": "website",
  "data": {
    "guardian": { "fullName": "...", "email": "...", "phone": "...", "relationship": "Parent" },
    "child": { "firstName": "...", "ageBand": "3-5 years" },
    "programInterest": "Nova Stars",
    "desiredStart": "September 2026",
    "notes": "...",
    "completedSteps": 5,
    "totalSteps": 5
  }
}
```

`eventId` **is** the idempotency key. Resending the same one returns the original
result with `"status": "duplicate"` and writes nothing.

**Types:** `registration.created`, `registration.updated`, `tour.requested`,
`waitlist.requested`, `contact.created`. Declared but deliberately unimplemented:
`call.received`, `voice.summary` (Phase 10) — they validate as "not implemented
yet" rather than being silently accepted.

**Response**

```json
{
  "status": "processed",
  "eventId": "...",
  "familyId": "...",
  "childId": "...",
  "leadId": "...",
  "registrationId": "...",
  "createdFamily": true,
  "needsReview": { "candidates": [ { "familyName": "...", "confidence": 0.35, "reasons": ["same surname (Lindqvist)"] } ] }
}
```

`needsReview` appears only when a near-match was found and deliberately **not**
merged. A task and an alert are raised for a human.

## Signing example

```js
import { createHmac, randomUUID } from 'node:crypto';

const envelope = { eventId: randomUUID(), type: 'registration.created', version: 1,
  occurredAt: new Date().toISOString(), source: 'website', data: { /* ... */ } };

const body = JSON.stringify(envelope);
const signature = createHmac('sha256', process.env.CRM_INGEST_SECRET)
  .update(body, 'utf8').digest('hex');

await fetch(`${CRM}/api/v1/ingest`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-crm-signature': signature,
    'x-crm-timestamp': String(Date.now()),
  },
  body,                      // sign and send the SAME string
});
```

Sign the exact string you send. Re-serialising changes key order and invalidates
the signature.

## Versioning

`CONTRACT_VERSION` lives in `packages/shared/src/contract.ts`. An envelope with a
higher version is rejected with a clear message rather than partly understood.
Adding an optional field does not need a bump; changing the meaning of an
existing one does.
