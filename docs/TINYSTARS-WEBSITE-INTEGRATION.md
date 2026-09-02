# TinyStars.ca — website integration contract

How the public website gets what a parent typed into this CRM, without the
website ever touching the database.

This document has two halves. The first is an **audit of what tinystars.ca
actually does today**, verified by request rather than assumed. The second is
the **contract** a website — any website — implements to send events here.

Read the audit first. It changes the plan.

---

## Part 1 — what the live site does today

Verified 2026-09-02 by fetching each page and reading the returned HTML and
redirects. Re-verify before acting on it; the site is not ours and can change
without telling us.

**tinystars.ca is not our code.** It is a Laravel application (every form
carries a Laravel `_token` CSRF field) built by BM-IT (`bmgroupinc.com`, linked
in the footer). We cannot deploy to it. Every change in Part 3 is a request to
somebody else.

### The five intake paths

| Page | Where the parent's data actually goes | Ours to change? |
|---|---|---|
| `/book-a-tour` | **Calendly.** The page has no form of its own — it loads `assets.calendly.com/assets/external/widget.js` and embeds `calendly.com/tinystars-info/30min` | No — Calendly |
| `/registration-package` | **Zoho Forms.** `302` redirect off-site to `forms.zohopublic.com/tinystars1/form/EventRegistration/...` | No — Zoho |
| `/waitlist` | **Lillio.** `302` redirect off-site to `app.lillio.com/online_registration/apply/tiny-stars` | No — Lillio |
| `/contact-us` | On-site. `POST https://tinystars.ca/contact.submit` | Only via BM-IT |
| `/careers` | On-site. `POST https://tinystars.ca/careers.submit`, `multipart/form-data` | Only via BM-IT |

### The consequence, stated plainly

**Three of the five paths never reach the website's own server.** A parent
booking a tour is talking to Calendly. A parent registering is talking to Zoho.
A parent joining the waitlist is talking to Lillio. The Laravel application
never sees those submissions, so *no change BM-IT can make to tinystars.ca will
capture them.*

This matters because the obvious plan — "add a signed webhook to the website" —
would capture the contact form and the careers form, and would miss tours,
registrations and the waitlist. Those three are the entire admissions pipeline.

Each of the three needs its own connector, on the provider's terms, with the
provider's credentials. That is not a build problem. It is an access problem,
and it is listed in Part 3 with the exact action needed for each.

### Field inventory of the two on-site forms

Read off the live HTML, so these are the real field names.

`/contact-us` → `POST /contact.submit`

| Field | Type | Required |
|---|---|---|
| `_token` | hidden | Laravel CSRF |
| `name` | text | yes |
| `phone` | tel | no |
| `email` | email | yes |
| `subject` | text | yes |
| `message` | textarea | yes |

`/careers` → `POST /careers.submit` (`multipart/form-data`)

| Field | Type | Required |
|---|---|---|
| `_token` | hidden | Laravel CSRF |
| `honey_pot` | text | spam trap, must stay empty |
| `fullName` | text | yes |
| `email` | email | yes |
| `contactNumber` | tel | yes |
| `birthdate` | date | yes |
| `address` | textarea | yes |
| `applicationDate` | date | yes |
| `preferredAge` | select | yes |
| `expectedWage` | text | no |
| `resume` | file | no |
| `consent` | radio | yes |

Note the careers form already has a honeypot. Whoever built it was thinking
about spam, which is a good sign for the conversation in Part 3.

---

## Part 2 — the contract

One endpoint. One secret. The website never gets a database credential, and
there is nothing in the browser to steal.

    POST https://<private-crm-host>/api/v1/ingest

Full reference, including the response shape and the signing example, is in
[API.md](API.md#ingest). The essentials:

- **Auth is a signature, not a session.** `x-crm-signature` is the HMAC-SHA256
  of the exact request body using `CRM_INGEST_SECRET`. Sign the same string you
  send — re-serialising the JSON changes key order and invalidates it.
- **`x-crm-timestamp` must be within 5 minutes.** This is replay protection.
- **`eventId` is the idempotency key.** Send the same one twice and the second
  is a no-op that returns `"status": "duplicate"`. This is what makes retrying
  safe, and retrying is required — see below.
- **The secret is server-side only.** It must never appear in frontend
  JavaScript, in a page source, or in a repository. Anyone holding it can write
  records into this CRM.

Event types accepted today: `registration.created`, `registration.updated`,
`tour.requested`, `waitlist.requested`, `contact.created`, `web.analytics`.

`packages/shared/src/contract.ts` is the source of truth for the schema and is
copied verbatim into the website repo. Do not hand-write a second copy.

### What the sender must do when the CRM is unreachable

The CRM is deliberately not on the public internet. It will be unreachable
sometimes. The rule for anything sending to it:

> **Never let a failed forward fail the parent's submission.** Show the parent
> success, keep the submission in whatever the sender already trusts (the
> Laravel database, the provider's own record), and retry the forward.

Retry with backoff, reusing the **same `eventId`** each time. Idempotency is
what makes that safe. A submission that never gets through must end up
somewhere a person looks, not in a log file nobody reads.

---

## Part 3 — the work, per path, with the operator action

Nothing here is a code problem we can finish alone. Each item names the single
thing a human has to obtain.

### `/contact-us` and `/careers` — BM-IT adds a server-side forward

The only two paths where the website's own server sees the data.

Ask BM-IT to add, in the Laravel controller that already handles the
submission, **after** it has saved its own record: build the envelope, sign it
with a secret read from the server environment, `POST` it to the ingest URL,
and queue a retry on failure. Laravel's own queue and `Http::` client cover
this; it is a small controller change, not a rebuild.

- **Operator action:** BM-IT accepts the change, and is given
  `CRM_INGEST_URL` + `CRM_INGEST_SECRET` through a channel that is not email.
- **Careers caveat:** the CRM has no staff or applicant module yet — it is
  listed as unbuilt in the README and on `/system`. `career.application` is not
  in the contract, so **do not wire careers up first.** Contact is the one to
  start with.

### `/book-a-tour` — Calendly

Calendly can push `invitee.created` to a webhook, which is exactly a
`tour.requested`. Its payload is Calendly's shape, not ours, so it needs a
small adapter that verifies Calendly's own signing key and maps the fields into
our envelope.

- **Operator action:** confirm the Tiny Stars Calendly plan includes webhook
  subscriptions — on Calendly's pricing this is a paid-tier feature, so check
  the actual plan before promising it — then create the subscription and supply
  the signing key.

### `/registration-package` — Zoho Forms

Zoho Forms can call a webhook on submission. Same shape of problem as Calendly:
Zoho's payload, our envelope, one adapter between them.

- **Operator action:** confirm the account's Zoho Forms plan includes the
  webhook/integration feature, then point it at the adapter URL and supply
  whatever shared secret Zoho is configured to send.

### `/waitlist` — Lillio

The hardest one, and the one to decide rather than build.

Lillio is a childcare management product and appears to be the centre's actual
enrolment system for this path. Before any code: **find out whether Lillio is
staying.** Three futures, and they are genuinely different:

1. **Lillio stays as the enrolment system.** The CRM should link to the Lillio
   record, not duplicate it. Least work, no double data entry.
2. **The CRM takes over the waitlist.** The website stops redirecting and posts
   `waitlist.requested` instead. Most work, and it needs the centre to agree to
   change how they actually operate.
3. **Both, with the CRM shadowing.** Only sane if Lillio exposes an export or
   API — otherwise it means retyping, which is the thing this CRM exists to
   stop.

- **Operator action:** ask the centre which of the three they want, and ask
  Lillio whether the account has any export or API access. Do not build until
  that answer exists.

**Do not silently break the Lillio redirect.** Families are using it now.

---

## Part 4 — testing, before anyone calls it done

Run in this order. Each step must pass before the next.

1. **Wiring.** `GET /api/v1/ingest/ping` returns `{"ok":true,"configured":true}`.
   No auth, sends nothing. If `configured` is false the secret is not set.
2. **One real submission.** Submit the form as a parent would. Confirm the
   record appears in the CRM, and that the parent still saw their normal
   thank-you page.
3. **The same submission twice.** Re-send with the same `eventId`. Expect
   `"status": "duplicate"` and exactly one record in the CRM.
4. **A malformed submission.** Expect a `400` naming the bad field, and no
   record.
5. **A tampered signature.** Change one byte of the body. Expect a `401` and no
   record.
6. **A stale timestamp.** Send one over 5 minutes old. Expect rejection.
7. **CRM down.** Stop the CRM, submit a form. The parent must still see
   success, and the submission must be queued.
8. **CRM back up.** Start it. The queued submission arrives, once.

Steps 3 to 6 can be run against a local CRM with `npm start` and the signing
snippet in [API.md](API.md#signing-example) — they need no website at all, and
no provider credentials.

---

## Part 5 — rollback

Every integration in this document fails safe, because the website keeps its own
record and the forward is an extra.

- **To stop all inbound events:** unset `CRM_INGEST_SECRET` on the CRM and
  restart. `/ingest/ping` reports `configured: false` and every event is
  refused. Nothing already stored is affected.
- **To stop one sender:** remove its URL/secret at that sender. For the Laravel
  forms this is an environment variable on the website; for Calendly and Zoho it
  is deleting the webhook subscription.
- **If the secret leaks:** rotate it. Generate a new one, set it on the CRM and
  every sender, restart. Events signed with the old secret are refused from that
  moment. There is no revocation list — rotation is the mechanism.

Rolling back never involves editing the database by hand.

---

## What must never happen

- The ingest secret in frontend JavaScript, in page source, or in a git
  repository.
- The CRM on a public address. It holds records about children. Put it behind a
  VPN or a private network — see [DEPLOYMENT.md](DEPLOYMENT.md).
- A parent's submission lost because the CRM was unreachable.
- The Lillio or Zoho flow broken silently while families are mid-application.
- A second hand-written copy of the event schema. Copy `contract.ts` verbatim.
