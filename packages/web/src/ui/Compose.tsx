import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';
import { Panel, Badge, Button, Spinner, ErrorNote, When } from './kit.tsx';

// --------------------------------------------------------- completeness

export interface Gap {
  field: string; label: string; why: string;
  severity: 'required' | 'recommended';
  where: 'guardian' | 'child' | 'registration' | 'family';
}
export interface Completeness {
  status: 'complete' | 'incomplete' | 'needs_review';
  percent: number; gaps: Gap[];
  requiredMissing: number; recommendedMissing: number;
}

/**
 * What is missing from a registration, and why it matters.
 *
 * Deliberately not just a percentage: a number tells someone they have a
 * problem, a list tells them what to do about it.
 */
export function CompletenessPanel({ registrationId }: { registrationId: string }) {
  const [data, setData] = useState<Completeness | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.get<Completeness>(`/registrations/${registrationId}/completeness`)
      .then((d) => { if (live) setData(d); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Could not check'); });
    return () => { live = false; };
  }, [registrationId]);

  if (error) return <Panel title="Completeness"><ErrorNote error={error} /></Panel>;
  if (!data) return <Panel title="Completeness"><Spinner label="Checking" /></Panel>;

  const required = data.gaps.filter((g) => g.severity === 'required');
  const recommended = data.gaps.filter((g) => g.severity === 'recommended');
  const tone = data.requiredMissing === 0 ? 'var(--color-ok-400)'
    : data.requiredMissing > 3 ? 'var(--color-crit-400)' : 'var(--color-warn-400)';

  return (
    <Panel
      title="Completeness"
      action={
        <Badge tone={data.status === 'complete' ? 'ok' : data.status === 'needs_review' ? 'info' : 'warn'}>
          {data.status.replace('_', ' ')}
        </Badge>
      }
    >
      <div className="flex items-center gap-3">
        <span className="tabular text-2xl font-semibold" style={{ color: tone }}>{data.percent}%</span>
        <span className="h-2 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--surface-inset)' }}>
          <span className="block h-full rounded-full transition-[width]"
                style={{ width: `${data.percent}%`, background: tone }} />
        </span>
      </div>
      <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        Counted over required fields only, so optional details do not drag the score down.
      </p>

      {required.length === 0 ? (
        <p className="mt-3 text-[13px]" style={{ color: 'var(--color-ok-400)' }}>
          Nothing required is missing.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {required.map((g) => (
            <li key={g.field} className="rounded-lg p-2.5" style={{ background: 'var(--surface-sunken)' }}>
              <div className="flex items-center gap-2">
                <Badge tone="crit">needed</Badge>
                <span className="text-[13px] font-medium">{g.label}</span>
              </div>
              <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>{g.why}</p>
            </li>
          ))}
        </ul>
      )}

      {recommended.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[12px]" style={{ color: 'var(--text-muted)' }}>
            {recommended.length} other {recommended.length === 1 ? 'detail' : 'details'} worth having
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {recommended.map((g) => (
              <li key={g.field} className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                <span className="font-medium">{g.label}</span> &mdash; {g.why}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

// -------------------------------------------------------------- composer

interface Draft {
  templateId: string; templateName: string; channel: 'email' | 'sms';
  to: string | null; toName: string | null;
  subject: string | null; body: string;
  warnings: string[]; blocked: boolean;
}
interface Template { id: string; name: string; trigger: string }

/**
 * Writes the follow-up so a person does not have to, then gets out of the way.
 *
 * It does not send. Nothing in this system sends to a parent: the operator
 * copies it, or opens their mail client with it prefilled, reads it, and sends
 * it themselves. That one human beat is the whole safety model.
 */
export function DraftComposer({ familyId, onSent }: { familyId: string; onSent?: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ templates: Template[] }>('/templates')
      .then((d) => setTemplates(d.templates)).catch(() => { /* the picker just stays empty */ });
  }, []);

  useEffect(() => {
    let live = true;
    setDraft(null); setError(null);
    const q = templateId ? `?template=${encodeURIComponent(templateId)}` : '';
    api.get<{ draft: Draft; suggested: string }>(`/families/${familyId}/draft${q}`)
      .then((d) => {
        if (!live) return;
        setDraft(d.draft);
        setBody(d.draft.body);
        if (!templateId) setTemplateId(d.suggested);
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : 'Could not compose'); });
    return () => { live = false; };
  }, [familyId, templateId]);

  async function record(status: 'sent' | 'discarded') {
    setBusy(true);
    try {
      await api.post(`/families/${familyId}/draft`, { templateId, status, body, subject: draft?.subject });
      setDone(status === 'sent' ? 'Marked as sent. The follow-up clock has reset.' : 'Discarded.');
      onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not record that');
    } finally { setBusy(false); }
  }

  const mailto = draft && draft.to
    ? `mailto:${encodeURIComponent(draft.to)}?subject=${encodeURIComponent(draft.subject ?? '')}&body=${encodeURIComponent(body)}`
    : null;

  if (error) return <Panel title="Write a follow-up"><ErrorNote error={error} /></Panel>;
  if (!draft) return <Panel title="Write a follow-up"><Spinner label="Composing" /></Panel>;

  return (
    <Panel title="Write a follow-up">
      {templates.length > 0 && (
        <label className="mb-3 block">
          <span className="mb-1 block text-[12px] font-medium">Situation</span>
          <select
            value={templateId ?? ''} onChange={(e) => setTemplateId(e.target.value)}
            className="w-full rounded-lg border px-3 py-2 text-[13px] outline-none"
            style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)' }}
          >
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
      )}

      {/* The recipient is shown before the message, always. The failure this
          prevents is sending a family's details to a different family. */}
      <div className="mb-3 rounded-lg px-3 py-2" style={{ background: 'var(--surface-inset)' }}>
        <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>To</span>
        <p className="text-[13px] font-medium">
          {draft.toName ?? 'Nobody'} {draft.to && <span style={{ color: 'var(--text-muted)' }}>&lt;{draft.to}&gt;</span>}
        </p>
      </div>

      {draft.warnings.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {draft.warnings.map((w) => (
            <li key={w} className="rounded-lg px-3 py-2 text-[12px]"
                style={{
                  background: `color-mix(in oklab, var(--color-${draft.blocked ? 'crit' : 'warn'}-400) 16%, transparent)`,
                  color: `var(--color-${draft.blocked ? 'crit' : 'warn'}-400)`,
                }}>
              {w}
            </li>
          ))}
        </ul>
      )}

      {draft.blocked ? (
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Nothing can be composed until that is resolved.
        </p>
      ) : (
        <>
          {draft.subject && (
            <p className="mb-2 text-[13px]"><span style={{ color: 'var(--text-muted)' }}>Subject: </span>{draft.subject}</p>
          )}
          <textarea
            value={body} onChange={(e) => setBody(e.target.value)} rows={12}
            className="w-full resize-y rounded-lg border p-3 text-[13px] leading-relaxed outline-none"
            style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)' }}
          />
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            Edit it freely. Nothing is sent from here &mdash; you send it yourself.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {mailto && (
              <a href={mailto} className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium"
                 style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
                Open in email
              </a>
            )}
            <Button onClick={() => { void navigator.clipboard?.writeText(body); }}>Copy</Button>
            <Button disabled={busy} onClick={() => void record('sent')}>Mark as sent</Button>
            <Button variant="ghost" disabled={busy} onClick={() => void record('discarded')}>Discard</Button>
          </div>
        </>
      )}

      {done && (
        <p className="mt-3 text-[13px]" style={{ color: 'var(--color-ok-400)' }}>{done}</p>
      )}
    </Panel>
  );
}

/** What has already been written to this family. */
export function DraftHistory({ familyId }: { familyId: string }) {
  const [rows, setRows] = useState<Record<string, string | null>[]>([]);
  useEffect(() => {
    api.get<{ drafts: Record<string, string | null>[] }>(`/families/${familyId}/drafts`)
      .then((d) => setRows(d.drafts)).catch(() => { /* history is not critical */ });
  }, [familyId]);

  if (!rows.length) return null;
  return (
    <Panel title="Messages written" pad={false}>
      <ul>
        {rows.map((r) => (
          <li key={String(r.id)} className="border-b px-4 py-2.5 last:border-b-0" style={{ borderColor: 'var(--line)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={r.status === 'sent' ? 'ok' : r.status === 'discarded' ? 'neutral' : 'info'}>
                {String(r.status)}
              </Badge>
              <span className="text-[13px]">{r.subject ?? 'No subject'}</span>
              <span className="ml-auto text-[11px]" style={{ color: 'var(--text-faint)' }}>
                <When iso={String(r.created_at)} />
              </span>
            </div>
            <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              to {r.to_address ?? 'nobody'}{r.created_by_name ? ` · by ${r.created_by_name}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
