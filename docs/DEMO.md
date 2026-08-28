# Demo mode

## What it is

`CRM_MODE=demo` (the default) seeds synthetic records and shows a banner on
every screen. `CRM_MODE=production` refuses to seed or reset.

```bash
npm run db:seed     # reference data + 8 synthetic families, if empty
npm run db:reset    # wipe operational data and re-seed. Blocked in production
```

## The data

Every person is invented. Emails all end in `.invalid`, a TLD reserved by
RFC 2606 precisely so it can never resolve.

Children get a first name and an age band. No surnames, no dates of birth, no
health information, no photographs. A demo of a childcare system should model
good data hygiene rather than just look full.

Two programs are left with **no capacity recorded** on purpose, so the "not
measured" path is exercised by real data instead of assumed to work.

The seed produces overdue follow-ups, an unfinished registration, an
unconfirmed tour request and a tour today, because a dashboard that only ever
shows a happy state has not been tested.

## Accounts

`owner@` / `director@` / `admissions@` / `educator@` at `demo.local`, password
`demo1234`. Sign in as the educator to see permissions actually working: no
dates of birth, no export, no pipeline.

## The banner

Shown on every screen, not just the dashboard, so a screenshot of any page
carries the caveat with it.

## Before production

1. `CRM_MODE=production`
2. Create real accounts
3. Delete every `@demo.local` user
4. `npm run db:reset` is now refused, by design
