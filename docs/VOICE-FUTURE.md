# Voice agents

## Status: not built, and deliberately not started. Phase 10.

No telephony code exists. None should be written until the website and the CRM
are both stable in real use. This document exists so the decisions are recorded
while they are still cheap to change.

## What already exists

The event contract declares the shapes voice will send, so adding it later does
not require a breaking change:

```ts
'call.received'   // reserved
'voice.summary'   // reserved
```

Both are declared in `EVENT_TYPES` and both are **rejected** by
`validateEnvelope` with "declared but not implemented yet". They validate as
recognised-but-unsupported rather than being silently accepted and dropped, and
there is a test asserting exactly that.

`SOURCES` already includes `voice-agent`.

## The chosen stack

Recorded from the plan of 2026-08-28.

| # | Component | Provider | Est. / month |
|---|---|---|---|
| 1 | Canadian number, inbound calls | Twilio | $9.65 |
| 2 | Real-time speech recognition | Deepgram | $4.80 |
| 3 | Conversation engine | cost-efficient LLM | $10.00 |
| 4 | Natural voice | Fish Audio | $10.00 |
| 5 | Database and lead storage | Supabase | $0–10 |
| 6 | Agent server and hosting | — | $5–10 |
| | **Total** | | **$39.45–54.45** |

Components 1–4 and 6 are sound. Component 5 needs rethinking, below.

## Component 5 is the one to change

**As written, Supabase becomes a second source of truth, and that is the one
thing this architecture must not have.**

If the voice agent writes leads into Supabase, a family who phones exists in
Supabase while a family who used the website exists in the CRM. Then there are
two half-pictures, two dedupe problems, and a merge nobody wants to own. Spec
items 5 and 355 both rule this out, and they are right to.

The voice agent should do what the website already does: **POST a signed event
to `/api/v1/ingest`**. It then gets, for free, everything already built and
tested — family matching, sibling detection, duplicate flagging, idempotency,
the timeline, the follow-up task and the alert. A phone call and a web form
converge on one family record through one pipeline.

That also removes the $10/month line.

### The real problem Supabase was solving

There is a genuine reason it appeared on the list: **a cloud-hosted voice agent
cannot reach a CRM running on `127.0.0.1`.** Supabase is reachable; a laptop is
not.

This is the same problem currently blocking the website from delivering
registrations. Solve it once and both are solved.

Three options, best first:

1. **Put the CRM on a private network the voice server can reach** — Tailscale,
   or a small firewalled VPS. The voice agent posts straight to
   `/api/v1/ingest`. One source of truth, nothing extra to run.
2. **Use Supabase as a queue, not a database.** The voice agent appends an event
   row; the CRM polls and ingests it; the row is transient and deleted once
   acknowledged. Still one source of truth — Supabase is transport, not storage.
   Acceptable if the CRM genuinely cannot be made reachable.
3. **Supabase as a second lead database.** Do not. This is the split-brain case.

Option 2 reuses the idempotency already in place: the queue row carries the
`eventId`, so a redelivery after a crash is harmless.

## Intended flow

```
CALL -> Twilio -> Deepgram (speech to text)
                -> LLM (intent, within its permissions)
                -> Fish Audio (speech)
                -> POST call.received to /api/v1/ingest
                     -> the SAME matcher the website uses
                     -> family or lead created / updated
                     -> activity, follow-up and task created
```

## Outbound calls

Having the agent call the business owner is straightforward for Twilio, and
calling yourself is not telemarketing, so the regulatory picture there is
simple.

Calling **families** is a different question. Automated outbound calling in
Canada falls under the CRTC Unsolicited Telecommunications Rules, including
do-not-call obligations and identification requirements. Treat any outbound call
to a parent as a compliance question first and a technical one second, and
honour `guardians.opted_out`, which exists for exactly this reason.

## Constraints decided in advance

- **Permissions apply.** A voice agent gets a role like any other actor, and a
  narrow one. It may look up authorised information, create a lead, request a
  tour and create a task. It may not read sensitive child data aloud, and it may
  not confirm a booking — it *requests* one, and a person confirms.
- **Recording and transcription are legal questions before technical ones.**
  Consent rules vary by province. Do not store a transcript until that is
  answered in writing for Alberta.
- **Official APIs only.** No unofficial automation of platforms that forbid it.
- **Every call becomes an auditable event**, with the same before/after
  discipline as any other write.
- **A caller can always reach a person.** The agent is a front door, not a wall.
- **Nothing is built here until the CRM is finished and in real daily use.**
