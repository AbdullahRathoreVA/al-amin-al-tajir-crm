# Handing this over

For the person who is going to run Tiny Stars with this. You do not need to be
technical to read this page. Nothing here assumes you have seen the code.

---

## What you are being given

A private system for running the daycare: the families who have enquired, the
children who attend, the daily register, what needs chasing, and what you spent.

It is **not** the public website. The website talks to parents; this talks to
your team. They are deliberately separate, because this one holds records about
children and the website does not.

**There is a Help tab inside the app.** It is the fullest guide there is —
every screen, every button, who is allowed to do what, and what the software
cannot do. You can also type a question into it in your own words. Start there;
this page is only the handover.

---

## The five minutes that matter

1. **Sign in.** You will be given an email and a password. There is no sign-up
   page on purpose — anyone who could sign themselves up could read records
   about children.
2. **Open Help.** Read "What this is, in one minute" and "The dashboard".
3. **Press Ctrl+K** and type a name. That is how you find anything, from
   anywhere.
4. **Look at "Needs attention"** on the dashboard. If it is empty, nothing is
   wrong. It is never padded out.
5. **Open the Register.** That is the screen for the doorway.

---

## Getting your existing children in

You almost certainly have them in a spreadsheet already. Do not retype them.

- **Import** in the left menu takes an Excel `.xlsx` file directly — tabs and
  all. There is no need to save it as a CSV first, and no need to reformat the
  dates. A `.csv` works too.
- It reads your column headings and matches them for you. You check that, then
  it shows you **exactly** what will happen — how many are new, how many match
  someone already there, and anything that looks wrong — **before** anything is
  written.
- Up to 5,000 rows at a time.

If a family arrives by phone instead: **Families → "+ Add a family"**. A
guardian's name and one way to contact them is enough.

---

## What it does for you without being asked

- **Website registrations arrive by themselves**, if the website is connected
  (see below). Nobody retypes them, and the same one twice does not make two.
- **Age groups keep themselves right.** Type a child's birthday once and the age
  group updates as they grow.
- **Children who have outgrown their room are listed** on the Register, with the
  room that fits and how many places are free. It **never moves anybody for
  you** — that depends on space, ratios and their parents.
- **Tasks are created with a reason.** A registration nobody reviewed, a tour
  with no time set, a follow-up gone past its date.
- **A backup is taken every day** and tested, not just written.

---

## What it will never do

These are deliberate, not missing:

- **It never sends a message to a parent on its own.** It writes the draft; a
  signed-in person presses send. That is enforced in three separate places.
- **It never merges two families for you** on a weak signal like a shared
  surname. It flags them and leaves the decision to you.
- **It never shows a number nobody measured.** Where something has not been set
  up it says "not measured" rather than showing a reassuring zero.
- **AI never invents anything.** It is off unless switched on, and even then it
  can only summarise records or answer from the Help.

---

## What is not built

Stated plainly so you do not go hunting:

- Documents, incident records, staff files and certificate expiry.
- Billing and invoicing. The logbook records what you spend; it does not bill.
- **Facebook, Instagram and WhatsApp.** This one is worth understanding: it is
  not a missing feature, it is an **approval process**. Meta requires business
  verification and app review on your own account, which takes weeks and is
  nobody's code. Until that exists, nothing will pretend to be connected.
- Reading Google Sheets back in (sending out is built, and needs your Google
  account details).
- Asking questions in plain language across your records.
- Using it on two computers at once.

The **System** screen shows this same list inside the app, so you can check it
rather than remember it.

---

## The three things to set up, in order

### 1. Real accounts, and delete the demo ones

The practice accounts (`owner@demo.local` and the rest) must not exist on a
system holding real families. Whoever set this up runs:

```bash
npm run user:create -- you@tinystars.ca "Your Name" owner
npm run prod:check
npm run prod:harden -- --force
```

`prod:check` refuses to pass while anything is unsafe. `prod:harden` removes the
demo accounts and the invented families.

Give people the **smallest role that lets them work**:

| Person | Role |
|---|---|
| You | `owner` |
| Manager | `director` |
| Whoever handles enquiries | `admissions` |
| Room staff | `educator` |
| Bookkeeper | `accounting` |

An educator cannot see a date of birth, cannot export, and only sees the rooms
they are assigned to. That is the point of the roles — use them.

### 2. Get it off the open internet

Right now the system is reachable at a public web address. Sign-in throttling,
role checks and a strict security policy are all in place, **but a login page
for a system holding children's records should not be reachable by the whole
internet.**

The cheapest fix is a private network such as Tailscale's free tier: your staff
install it once, and the address stops existing for everybody else. No code
changes. `docs/DEPLOYMENT.md` lists three options.

**Do this before real family records go in.**

### 3. Connect the website — carefully

Today the public site sends **tours to Calendly, registrations to Zoho Forms and
the waitlist to Lillio**. None of those three reach this CRM, because they never
touch the website's own server.

That is a website decision, not a CRM one, and it needs a conversation before
anybody changes anything — families are mid-application in Lillio right now.
The full audit and the exact steps are in
[TINYSTARS-WEBSITE-INTEGRATION.md](TINYSTARS-WEBSITE-INTEGRATION.md).

**Do not switch the Lillio link off** without deciding what replaces it.

---

## Things not to do

- **Do not put the database file in Dropbox, Google Drive or OneDrive.** Two
  copies syncing will corrupt it. Backups are handled for you.
- **Do not email the families export around.** It identifies children. It is
  recorded in the access log when you create one, and it should be deleted when
  you are done with it.
- **Do not run it on two computers pointing at the same file.** One at a time.
- **Do not share a login.** The record of who did what is only worth having if
  each account is one person.
- **Do not delete the `data` folder.** That is everything.

---

## If something looks wrong

1. **Check the System screen.** It says honestly what is connected and what is
   not, and anything that failed is listed with the reason.
2. **Check the Help tab** — there is a topic called "When something goes wrong"
   that covers the common messages.
3. **Nothing is silently thrown away.** A registration that could not be
   processed is kept and shown, not dropped.
4. **Backups exist for the last fortnight** and have been tested by restoring
   them, not just written.

---

## A message you can forward

> The Tiny Stars Command Center is the private staff system for the daycare —
> families, children, the daily register, enquiries and expenses. The public
> website stays exactly as it is; this is separate, and it is the one that holds
> records about children, so it stays private.
>
> Everything is explained in the Help tab inside the app, including a box where
> you can type a question in your own words. Your existing list of children can
> be imported straight from Excel without retyping.
>
> Three things need doing before real records go in: create proper accounts and
> remove the practice ones, put the system behind a private network so its login
> page is not on the open internet, and decide what happens with the website
> forms that currently go to Calendly, Zoho and Lillio. The first two are quick.
> The third is a conversation, not a technical job, and nothing should be
> switched off until it has been had.
