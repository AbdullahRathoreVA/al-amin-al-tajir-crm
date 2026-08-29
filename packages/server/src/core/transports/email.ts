/**
 * Email transport.
 *
 * ---------------------------------------------------------------------------
 * NOT YET VERIFIED AGAINST A REAL PROVIDER, for the same reason as the Sheets
 * transport: it needs an account and an API key that cannot be created from a
 * build. The queueing, the approval gate, the backoff and the dead-letter are
 * all tested; the single HTTP call in here is not. Watch the first real send.
 * ---------------------------------------------------------------------------
 *
 * Speaks to a generic HTTPS mail API rather than SMTP, because SMTP from a
 * serverless-adjacent host is mostly a lesson in blocked ports and deliverability.
 * Configured entirely from the environment; no key touches the database.
 *
 * This transport is dumb on purpose. It sends what it is handed. Every question
 * about whether a message *should* go — was it reviewed, did a person ask for
 * it, is that person allowed to — is settled in core/drafts.ts before a row
 * reaches this queue, and a database trigger backs that up. A transport that
 * also tried to make that decision would be a second place for the rule to live
 * and therefore a second place for it to be wrong.
 */
import type { OutboxRow, SyncTarget, Transport } from '../sync.ts';
import { safeJson } from '../util.ts';
import { reconcileDeliveries } from '../drafts.ts';

const TIMEOUT_MS = 15_000;

interface EmailPayload {
  draftId: string;
  to: string;
  subject: string;
  body: string;
  requestedBy: string;
}

function config(): { url: string; key: string; from: string } | null {
  const url = process.env.EMAIL_API_URL?.trim();
  const key = process.env.EMAIL_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!url || !key || !from) return null;
  return { url, key, from };
}

export const emailTransport: Transport = {
  channel: 'email',

  notReadyReason(): string | null {
    if (!config()) {
      return 'Email is not connected. Set EMAIL_API_URL, EMAIL_API_KEY and EMAIL_FROM '
           + 'as platform secrets. Until then the CRM will keep drafting and a person sends.';
    }
    return null;
  },

  /** Bring each draft into line with what the queue actually did. */
  afterRun(): void { reconcileDeliveries(); },

  async send(_target: SyncTarget | null, rows: OutboxRow[]): Promise<{ sent: number; detail?: string }> {
    const cfg = config()!;
    let sent = 0;

    // One request per message, unlike Sheets. A batch endpoint that partially
    // fails would leave us unable to say which parent was written to, and for
    // a message to a family that ambiguity is worse than the extra requests.
    for (const row of rows) {
      const p = safeJson<Partial<EmailPayload>>(row.payload_json, {});
      if (!p.to || !p.body) {
        throw new Error(`Draft ${p.draftId ?? row.id} has no recipient or no body`);
      }

      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${cfg.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: cfg.from,
          to: [p.to],
          subject: p.subject ?? '(no subject)',
          text: p.body,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        const message = safeJson<{ message?: string; error?: string }>(detail, {});
        // Throwing stops the batch here. Rows already sent stay sent; the rest
        // retry. Better a duplicate risk on one message than silently skipping
        // a family because an earlier one failed.
        throw new Error(
          `Email send failed after ${sent} of ${rows.length}: `
          + (message.message ?? message.error ?? `HTTP ${res.status}`));
      }
      sent++;
    }

    return { sent, detail: `Sent ${sent} message(s)` };
  },
};
