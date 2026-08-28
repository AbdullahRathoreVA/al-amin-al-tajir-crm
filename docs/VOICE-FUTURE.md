# Voice agents

## Status: not built, and deliberately not started. Phase 10.

No telephony code exists. None should be written until the website and the CRM
are both stable in real use.

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

## The intended path

```
CALL -> voice agent -> identify caller
                    -> match family or lead   (the SAME matcher the website uses)
                    -> intent
                    -> answer within its permissions
                    -> POST call.received to /api/v1/ingest
                    -> CRM creates the activity, the follow-up and the task
```

The point is that voice becomes another **source** on the existing pipeline, not
a parallel system. `SOURCES` already includes `voice-agent`. A call and a web
form should converge on the same family record through the same matching and
the same idempotency.

## Constraints decided in advance

- **Permissions apply.** A voice agent gets a role like any other actor, and it
  is a narrow one. It may look up authorised information, create a lead, request
  a tour and create a task. It may not read sensitive child data aloud.
- **Recording and transcription are legal questions before technical ones.**
  Two-party consent varies by jurisdiction. Do not store a transcript until that
  is answered in writing for Alberta.
- **Official APIs only.** No unofficial automation of platforms that forbid it.
- **Every call becomes an auditable event**, with the same before/after
  discipline as any other write.
- **A caller can always reach a person.** The agent is a front door, not a wall.
