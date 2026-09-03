# Every account and key, and what each one actually costs

For whoever is setting Tiny Stars up. Work down the list — the top of it is
free and takes minutes, the bottom is weeks and involves other companies.

Nothing here is needed for the CRM to run. Families, children, the register,
enquiries, tasks, the logbook, importing and exporting all work today with none
of it. Each item switches on one extra thing.

---

## Already done — nothing to do

| What | Status |
|---|---|
| The CRM itself | Running at `tiny-stars-crm.fly.dev` |
| Website intake secret | `CRM_INGEST_SECRET` set |
| Allowed website origin | `CRM_ALLOWED_ORIGIN` set |
| Session security | `CRM_SESSION_SECRET` set |
| Backups | Daily, kept a fortnight, verified by restoring |

---

## Free, and worth doing first

### 1. Put the login page behind a private network — **do this one**

Not a key. Right now `tiny-stars-crm.fly.dev` is reachable by anyone on the
internet. Sign-in throttling, roles and a strict security policy are all in
place, but a login page for a system holding children's records should not be
on the open web.

**Tailscale free tier.** Staff install it once, and the address stops existing
for everyone else. No code change, no monthly cost for a team this size.

### 2. Local AI — free, private, no key at all

Install **Ollama** on the machine, then set:

```
CRM_AI_PROVIDER=ollama
CRM_OLLAMA_MODEL=llama3.2
```

Switches on: family summaries, the daily briefing, plain-English answers in the
Help tab, and splitting "I bought milk for $12 and nappies for $30" into two
logbook entries. Nothing leaves the building. **£0 / $0 forever.**

A cloud model is the alternative — `CRM_AI_PROVIDER=anthropic` plus
`ANTHROPIC_API_KEY` — and is charged per use. Only worth it if the machine is
too small for a local model.

### 3. Google — free

<https://console.cloud.google.com> → new project → enable Sheets, Drive and
Calendar → OAuth credentials.

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=
```

Switches on: pushing records out to a Google Sheet. Reading back from Sheets is
not built yet.

### 4. Email — free tier is plenty

Any of Resend, Brevo or Mailgun. A nursery sends hundreds of emails a month,
not millions, so the free tier covers it.

```
EMAIL_API_URL=
EMAIL_API_KEY=
EMAIL_FROM=
```

Switches on: actually sending the follow-ups the CRM drafts. **A person still
presses send** — that does not change.

---

## Costs money, or takes weeks

### 5. Instagram and Facebook — an approval process, not a key

This is the one that is misunderstood most often, so plainly:

**There is no key you can buy today.** Meta requires **Business Verification**
(company documents, a real registered business) and then **App Review** for the
messaging permissions. That is typically several weeks and Meta can refuse.

Once approved you would have an App ID, App Secret, Page Access Token and a
webhook verify token. Until then, **the CRM has no Instagram or Facebook code
at all** — there is nothing waiting for a key. It is a build that has not been
started, deliberately, because starting it before approval means months of dead
code.

Start the verification now if you want it, because the waiting is the long part.

### 6. WhatsApp — paid per conversation

WhatsApp Business Cloud API, on top of the same Meta verification above. Meta
charges per conversation. Free code, not free messaging.

### 7. Voice agents on the office number — **not built, and not close**

You asked about using the office number, **(780) 230-1599**, for a voice agent.
Being straight about where this stands:

- The CRM's event contract *accepts* the shape a voice agent would send
  (`call.received`, `voice.summary`). **Nothing emits it. There is no telephony
  code in this system.**
- A voice agent needs a telephony provider (Twilio, Vonage or similar), a
  speech-to-text service and a text-to-speech service. All three charge **per
  minute**, every minute, forever.
- You cannot simply "use the current number". Either it is **ported** to the
  telephony provider — which can take days and briefly interrupts the line — or
  calls are **forwarded** to a new number the provider issues. Forwarding is
  reversible and much safer to try first.
- Realistic cost: a few pence/cents per minute of call, plus a monthly number
  fee. For a nursery taking a handful of calls a day that is small, but it is
  not zero and it is not one-off.

**Recommendation: leave this until last.** Everything above delivers more for
less. When you do want it, the honest first step is call forwarding to a trial
number — not touching the real line.

### 8. Calendly and Zoho — check the plan before promising anything

The live website sends tours to Calendly and registrations to Zoho Forms.
Both can call a webhook, but on **paid tiers**. Check what the Tiny Stars
accounts are actually on before anyone plans around it.

### 9. Lillio — no API exists

Checked directly. Lillio publishes no public API. Its own support pages point at
**Reports → Child Profile Report → Run Export**, which gives a spreadsheet.

The CRM already reads that file: drop the export into Import and the columns map
themselves, including the Active Enrolment Report, which has no parents in it.
That is the working path, and it needs no key.

If a live connection matters, ask Lillio whether your account can have API
access. Until somebody there says yes, nothing will pretend it does.

---

## Where to put these

They are secrets, so they go on the server, never in a file in the repository:

```bash
flyctl secrets set --app tiny-stars-crm GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
```

Setting a secret restarts the app. Check the **System** screen afterwards — it
names exactly what is missing for anything not connected, and shows nothing as
green unless it genuinely is.

---

## The order I would do them in

1. Tailscale, so the login page is not public. *(free, ~30 minutes)*
2. Ollama, for the AI features. *(free, ~20 minutes)*
3. Email, so follow-ups can actually go. *(free tier, ~30 minutes)*
4. Google Sheets, if anyone wants the data in Sheets. *(free, ~1 hour)*
5. Start Meta Business Verification **only if** Instagram matters — then wait.
6. Voice agents last, if at all.
