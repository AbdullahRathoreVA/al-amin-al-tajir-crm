# AI

## Status: not built. Phase 4.

There is no AI in this system today. The dashboard's AI panel says so, in the
product, rather than generating a plausible-sounding "briefing" from numbers
already on the screen. That would be theatre.

Everything currently shown is a `COUNT` over rows.

## Rules for when it is built

These are constraints on the implementation, decided now while it is cheap.

**Core CRUD must work with AI switched off.** Not degraded: off. If the model
fails, the CRM is a CRM.

**Local first.** Ollama on the operator's machine, hardware-aware model choice.
Cloud is explicit opt-in, per install, and clearly indicated in the UI when
active.

**Nothing leaves without passing the privacy filter.** `families.no_ai` and
`families.local_only` are columns for exactly this reason. Minimise, redact,
and honour the flags before any request leaves the machine.

**Read-only by default.** Generated queries are validated, schema-constrained
and permission-aware. Natural language never produces arbitrary SQL. Writes
require confirmation and are recorded as reversible events with the model and
prompt that produced them.

**Facts and inferences are visually distinct.** A number that was counted and a
number that was estimated must never look the same. Every inference links to
the records behind it.

**Confidence is stated, including when it is low.** "I am not sure" is a valid
and useful answer.

**Deterministic rules until the data justifies more.** Lead priority today is a
rules engine with stated reasons. It stays that way until there are enough
validated outcomes to beat it, measured rather than assumed.

**No fabricated metrics.** No "saved 12 hours", no accuracy figure that was not
computed from outcomes. `NOT ENOUGH DATA` is the honest default.

## Autonomy ladder

Earned per action type, never granted wholesale.

| Level | Meaning |
|---|---|
| 0 | Observe |
| 1 | Suggest |
| 2 | Prepare a draft |
| 3 | Execute after explicit confirmation |
| 4 | Limited autonomy in a narrow scope |
| 5 | Trusted automation with a kill switch |

Nothing ships above level 1 without an accept-rate measured over real use.
