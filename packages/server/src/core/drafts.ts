/**
 * Composing follow-up messages.
 *
 * This is the safe shape of "let AI reply to leads by itself": the CRM writes
 * the message with the family's real details filled in, and a person reads it
 * and sends it. When a model arrives in Phase 4 it replaces the template as the
 * author; the approval step does not move.
 *
 * Nothing in this file sends anything. There is no outbound mail in the system,
 * which is deliberate — a wrong message to a parent about their child cannot be
 * unsent. (spec 297 / 300 / 301 / 313)
 */
import { one, many, run, tx } from '../db/index.ts';
import { newId, nowIso, plain, plainAll } from './util.ts';
import { recordEvent, type Actor } from './events.ts';
import { queue } from './sync.ts';
import type { User } from './auth.ts';

export type Trigger =
  | 'tour_followup' | 'registration_incomplete' | 'registration_received'
  | 'waitlist_checkin' | 'no_response' | 'general';

export interface TemplateRow {
  id: string; name: string; trigger: Trigger; channel: 'email' | 'sms';
  subject: string | null; body: string; active: number; built_in: number;
}

/**
 * Built-in wording. Written to sound like a person at a nursery, not a system:
 * short, warm, specific, and it never promises anything the CRM cannot know —
 * no fees, no availability, no dates that were not actually booked.
 *
 * Placeholders are {{name}} style and are replaced from real records only. An
 * unresolved placeholder is a hard error, not a blank, so "Hi {{firstName}},"
 * can never reach a parent.
 */
const BUILT_IN: Omit<TemplateRow, 'active' | 'built_in'>[] = [
  {
    id: 'tpl_tour_followup',
    name: 'After a tour',
    trigger: 'tour_followup',
    channel: 'email',
    subject: 'Lovely to meet you at Tiny Stars',
    body:
      `Hi {{guardianFirstName}},\n\n` +
      `Thank you for coming to see us — it was lovely to meet you and {{childFirstName}}.\n\n` +
      `If anything came to mind after your visit, just reply here and I'll answer it. ` +
      `And whenever you're ready to take the next step, I can walk you through registration.\n\n` +
      `No rush at all.\n\n` +
      `Warmly,\n{{staffName}}\nTiny Stars`,
  },
  {
    id: 'tpl_registration_incomplete',
    name: 'Unfinished registration',
    trigger: 'registration_incomplete',
    channel: 'email',
    subject: 'Picking up where you left off',
    body:
      `Hi {{guardianFirstName}},\n\n` +
      `I noticed you started a registration for {{childFirstName}} and didn't get to finish it. ` +
      `That form asks a lot, so it's completely normal to stop partway.\n\n` +
      `If you tell me where you got stuck, I'm happy to fill in the rest with you over the phone — ` +
      `it usually takes about ten minutes.\n\n` +
      `Warmly,\n{{staffName}}\nTiny Stars`,
  },
  {
    id: 'tpl_registration_received',
    name: 'Registration received',
    trigger: 'registration_received',
    channel: 'email',
    subject: "We've got {{childFirstName}}'s registration",
    body:
      `Hi {{guardianFirstName}},\n\n` +
      `Your registration for {{childFirstName}} has reached us and I'm looking at it now.\n\n` +
      `I'll come back to you shortly with what happens next. If anything changes in the ` +
      `meantime, just reply here.\n\n` +
      `Warmly,\n{{staffName}}\nTiny Stars`,
  },
  {
    id: 'tpl_waitlist_checkin',
    name: 'Waitlist check-in',
    trigger: 'waitlist_checkin',
    channel: 'email',
    subject: 'Checking in about your place',
    body:
      `Hi {{guardianFirstName}},\n\n` +
      `Just checking in — you're still on our list for {{childFirstName}}, and I wanted you ` +
      `to know you haven't been forgotten.\n\n` +
      `If your plans have changed, or your timing has shifted, do let me know so I can keep ` +
      `our notes accurate.\n\n` +
      `Warmly,\n{{staffName}}\nTiny Stars`,
  },
  {
    id: 'tpl_no_response',
    name: 'No reply yet',
    trigger: 'no_response',
    channel: 'email',
    subject: 'Still here whenever you need us',
    body:
      `Hi {{guardianFirstName}},\n\n` +
      `I got in touch a little while ago about {{childFirstName}} and haven't heard back — ` +
      `which is completely fine, I know how full life gets.\n\n` +
      `I'll leave it with you. If the timing isn't right, no need to reply at all; and if it ` +
      `is, I'm here.\n\n` +
      `Warmly,\n{{staffName}}\nTiny Stars`,
  },
];

export function seedTemplates(): number {
  const now = nowIso();
  let added = 0;
  for (const t of BUILT_IN) {
    if (one('SELECT id FROM message_templates WHERE id = ?', t.id)) continue;
    run(
      `INSERT INTO message_templates (id, name, trigger, channel, subject, body, active, built_in, created_at, updated_at)
       VALUES (?,?,?,?,?,?,1,1,?,?)`,
      t.id, t.name, t.trigger, t.channel, t.subject, t.body, now, now,
    );
    added++;
  }
  return added;
}

export function templates(): TemplateRow[] {
  return plainAll(many<TemplateRow>(
    'SELECT * FROM message_templates WHERE active = 1 ORDER BY built_in DESC, name'));
}

// ------------------------------------------------------------------ compose

export interface Draft {
  id?: string;
  templateId: string;
  templateName: string;
  channel: 'email' | 'sms';
  to: string | null;
  toName: string | null;
  subject: string | null;
  body: string;
  /** Things a person must look at before sending. Never silently ignored. */
  warnings: string[];
  /** true when there is no way to contact this family at all. */
  blocked: boolean;
}

interface Ctx {
  guardianFirstName: string;
  childFirstName: string;
  familyName: string;
  staffName: string;
}

/** Replaces {{token}}. An unknown or empty token throws rather than rendering
 *  a blank, because "Hi ," reaching a parent is worse than an error here. */
function render(text: string, ctx: Ctx): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = (ctx as unknown as Record<string, string>)[key];
    if (!value) throw new Error(`Cannot compose: no value for {{${key}}}`);
    return value;
  });
}

export function composeDraft(
  familyId: string, templateId: string, staffName: string,
): Draft {
  const tpl = one<TemplateRow>('SELECT * FROM message_templates WHERE id = ? AND active = 1', templateId);
  if (!tpl) throw new Error('No such template');

  const family = one<{ id: string; name: string; status: string }>(
    'SELECT id, name, status FROM families WHERE id = ?', familyId);
  if (!family) throw new Error('No such family');

  const guardian = one<{
    id: string; first_name: string; last_name: string | null;
    email: string | null; phone: string | null; opted_out: number;
  }>(
    `SELECT id, first_name, last_name, email, phone, opted_out FROM guardians
      WHERE family_id = ? ORDER BY is_primary DESC, created_at LIMIT 1`, familyId);

  const child = one<{ first_name: string }>(
    'SELECT first_name FROM children WHERE family_id = ? ORDER BY created_at LIMIT 1', familyId);

  const warnings: string[] = [];
  let blocked = false;

  if (!guardian) {
    warnings.push('This family has no guardian recorded, so there is nobody to write to.');
    blocked = true;
  }
  if (guardian?.opted_out) {
    // Consent is not a warning to click past.
    warnings.push('This guardian has opted out of contact. Do not send this.');
    blocked = true;
  }
  const to = tpl.channel === 'sms' ? guardian?.phone ?? null : guardian?.email ?? null;
  if (!to && !blocked) {
    warnings.push(
      tpl.channel === 'sms'
        ? 'No phone number on file for this guardian.'
        : 'No email address on file for this guardian.');
    blocked = true;
  }
  if (!child) {
    warnings.push('No child recorded for this family, so the message cannot name one.');
    blocked = true;
  }

  const siblings = Number(one<{ n: number }>(
    'SELECT COUNT(*) n FROM children WHERE family_id = ?', familyId)?.n ?? 0);
  if (siblings > 1) {
    warnings.push(
      `This family has ${siblings} children on file. The draft names only the first — ` +
      `check it is the right one before sending.`);
  }

  if (blocked) {
    return {
      templateId: tpl.id, templateName: tpl.name, channel: tpl.channel,
      to, toName: guardian ? `${guardian.first_name} ${guardian.last_name ?? ''}`.trim() : null,
      subject: tpl.subject, body: '', warnings, blocked: true,
    };
  }

  const ctx: Ctx = {
    guardianFirstName: guardian!.first_name,
    childFirstName: child!.first_name,
    familyName: family.name,
    staffName,
  };

  return {
    templateId: tpl.id,
    templateName: tpl.name,
    channel: tpl.channel,
    to,
    toName: `${guardian!.first_name} ${guardian!.last_name ?? ''}`.trim(),
    subject: tpl.subject ? render(tpl.subject, ctx) : null,
    body: render(tpl.body, ctx),
    warnings,
    blocked: false,
  };
}

/** Picks the template that fits what is actually going on with this family. */
export function suggestTemplate(familyId: string): string {
  const has = (sql: string): boolean => !!one(sql, familyId);

  if (has(`SELECT 1 FROM registrations WHERE family_id = ? AND status = 'incomplete' LIMIT 1`)) {
    return 'tpl_registration_incomplete';
  }
  if (has(`SELECT 1 FROM registrations WHERE family_id = ? AND status = 'submitted' LIMIT 1`)) {
    return 'tpl_registration_received';
  }
  if (has(`SELECT 1 FROM tours WHERE family_id = ? AND status = 'completed' LIMIT 1`)) {
    return 'tpl_tour_followup';
  }
  if (has(`SELECT 1 FROM waitlist WHERE family_id = ? AND status = 'waiting' LIMIT 1`)) {
    return 'tpl_waitlist_checkin';
  }
  return 'tpl_no_response';
}

// ------------------------------------------------------------------- record

export function saveDraft(
  familyId: string, draft: Draft, actor: Actor, status: 'composed' | 'sent' | 'discarded' = 'composed',
): string {
  const id = newId();
  const now = nowIso();
  const guardianId = one<{ id: string }>(
    'SELECT id FROM guardians WHERE family_id = ? ORDER BY is_primary DESC LIMIT 1', familyId)?.id ?? null;
  const leadId = one<{ id: string }>(
    `SELECT l.id FROM leads l JOIN lead_stages s ON s.id = l.stage_id
      WHERE l.family_id = ? AND s.is_open = 1 ORDER BY l.created_at DESC LIMIT 1`, familyId)?.id ?? null;

  run(
    `INSERT INTO message_drafts (id, family_id, guardian_id, lead_id, template_id, channel,
       to_address, subject, body, status, author, created_by, created_at, resolved_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'template',?,?,?)`,
    id, familyId, guardianId, leadId, draft.templateId, draft.channel,
    draft.to, draft.subject, draft.body, status, actor.id, now,
    status === 'composed' ? null : now,
  );

  recordEvent({
    entityType: 'family', entityId: familyId,
    type: status === 'sent' ? 'message_sent' : 'draft_composed',
    actor,
    summary: status === 'sent'
      ? `Marked sent to ${draft.to}: ${draft.subject ?? draft.templateName}`
      : `Draft composed (${draft.templateName})`,
    after: { template: draft.templateId, to: draft.to, status },
  });

  // Marking a message sent IS contact, so the follow-up clock resets. Otherwise
  // the dashboard keeps nagging about a family somebody already wrote to.
  if (status === 'sent' && leadId) {
    run('UPDATE leads SET last_contact_at = ?, updated_at = ? WHERE id = ?', now, now, leadId);
  }
  return id;
}

export function draftsFor(familyId: string) {
  return plainAll(many(
    `SELECT d.*, u.name AS created_by_name FROM message_drafts d
       LEFT JOIN users u ON u.id = d.created_by
      WHERE d.family_id = ? ORDER BY d.created_at DESC LIMIT 25`, familyId));
}


// ------------------------------------------------------------------ sending

/**
 * Refusals a person should read. Every one of these is a reason a message is
 * not going out, and the person who pressed send needs to know which.
 */
export class SendRefused extends Error {}

/**
 * Queue a draft for delivery.
 *
 * This is the only path to sending anything to a parent, and it exists to be
 * narrow. The rule is that the CRM drafts and a person sends, so:
 *
 *   - the actor must be a real signed-in user. An automation, a scheduled
 *     rule or the AI layer runs as 'system' or 'ai' and is refused here, not
 *     merely discouraged by convention;
 *   - the person's name is recorded on the draft, and a database trigger
 *     rejects any delivery row that cannot name one;
 *   - a guardian who opted out is refused, because an opt-out that only the
 *     UI honours is not an opt-out.
 *
 * Queuing is all this does. Actual delivery is the outbox worker's job, so a
 * mail provider being down cannot fail the click or lose the record.
 */
export function requestSend(draftId: string, user: User, actor: Actor): Record<string, unknown> {
  if (actor.type !== 'user' || !actor.id) {
    // The load-bearing line in this file.
    throw new SendRefused('Only a signed-in person can send a message to a family');
  }

  const draft = plain(one<Record<string, unknown>>(
    'SELECT * FROM message_drafts WHERE id = ?', draftId));
  if (!draft) throw new SendRefused('No such draft');

  if (draft.delivery_state === 'queued') throw new SendRefused('That message is already queued to send');
  if (draft.delivery_state === 'sent') {
    throw new SendRefused(`That message was already sent at ${String(draft.delivered_at).slice(11, 16)}`);
  }
  if (draft.status === 'discarded') throw new SendRefused('That draft was discarded');

  const to = typeof draft.to_address === 'string' ? draft.to_address.trim() : '';
  if (!to) throw new SendRefused('That draft has no email address to send to');

  // An opt-out recorded against the guardian must hold whatever the UI offers.
  if (draft.guardian_id) {
    const g = one<{ opted_out: number; email: string | null }>(
      'SELECT opted_out, email FROM guardians WHERE id = ?', String(draft.guardian_id));
    if (g?.opted_out) throw new SendRefused('That guardian has opted out of messages');
  }

  const now = nowIso();
  let result!: Record<string, unknown>;
  tx(() => {
    const outboxId = queue('email', {
      draftId,
      to,
      subject: draft.subject ?? '',
      body: draft.body,
      requestedBy: user.id,
    }, String(draft.family_id));

    run(`UPDATE message_drafts
            SET delivery_state = 'queued', requested_by = ?, requested_at = ?,
                outbox_id = ?, delivery_error = NULL,
                status = CASE WHEN status = 'composed' THEN 'edited' ELSE status END
          WHERE id = ?`, user.id, now, outboxId, draftId);

    recordEvent({
      entityType: 'family', entityId: String(draft.family_id), type: 'message_queued', actor,
      // Names the person, because "the system emailed a parent" is never the
      // true description of what happened here.
      summary: `${user.name} sent a message to ${to}: ${String(draft.subject ?? 'no subject')}`,
      before: { delivery_state: draft.delivery_state ?? 'none' },
      after: { delivery_state: 'queued', to, requestedBy: user.id },
    });

    result = plain(one<Record<string, unknown>>(
      'SELECT * FROM message_drafts WHERE id = ?', draftId))!;
  });
  return result;
}

/**
 * Brings each queued draft into line with what the outbox actually did.
 *
 * Called after every email sweep. Reads the outbox rather than being told, so
 * a draft cannot end up claiming a delivery the queue never made.
 */
export function reconcileDeliveries(): number {
  const rows = many<{ id: string; status: string; last_error: string | null; updated_at: string }>(
    `SELECT d.id, o.status, o.last_error, o.updated_at
       FROM message_drafts d JOIN outbox o ON o.id = d.outbox_id
      WHERE d.delivery_state = 'queued' AND o.status IN ('sent','dead')`);

  let changed = 0;
  for (const r of rows) {
    const delivered = r.status === 'sent';
    run(`UPDATE message_drafts
            SET delivery_state = ?, delivered_at = ?, delivery_error = ?,
                status = CASE WHEN ? THEN 'sent' ELSE status END,
                resolved_at = COALESCE(resolved_at, ?)
          WHERE id = ?`,
      delivered ? 'sent' : 'failed',
      delivered ? r.updated_at : null,
      delivered ? null : (r.last_error ?? 'Delivery gave up after repeated failures'),
      delivered ? 1 : 0,
      r.updated_at, r.id);
    changed++;
  }
  return changed;
}

/** Drafts waiting on the queue, for /system and the family timeline. */
export function pendingDeliveries(): Record<string, unknown>[] {
  return plainAll(many<Record<string, unknown>>(
    `SELECT d.id, d.family_id, d.to_address, d.subject, d.delivery_state, d.requested_at,
            d.delivery_error, u.name AS requested_by_name
       FROM message_drafts d LEFT JOIN users u ON u.id = d.requested_by
      WHERE d.delivery_state IN ('queued','failed')
      ORDER BY d.requested_at DESC LIMIT 50`));
}
