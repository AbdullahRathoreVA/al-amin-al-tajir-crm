import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { useRouter } from '../lib/router.tsx';
import { Panel, Badge, Button, Empty, Spinner, ErrorNote, When, type Tone } from '../ui/kit.tsx';
import { SyncPanel } from './SyncPanel.tsx';

interface Check { id: string; label: string; state: 'good' | 'warning' | 'critical' | 'unknown'; detail: string }

interface SystemData {
  checks: Check[];
  outbox: Record<string, string | number | null>[];
  ingest: Record<string, string | number | null>[];
  mode: 'demo' | 'production';
}

const STATE_TONE: Record<Check['state'], Tone> = {
  good: 'ok', warning: 'warn', critical: 'crit', unknown: 'neutral',
};

export function System() {
  const [busy, setBusy] = useState(false);
  const { query } = useRouter();
  const tab = query.get('tab') ?? 'health';
  const res = useApi<SystemData>('/system/health');
  const me = useApi<{ capabilities: string[] }>('/auth/me');

  if (res.loading && !res.data) return <Spinner label="Checking the system" />;
  if (res.error) return <ErrorNote error={res.error} retry={res.reload} />;
  if (!res.data) return null;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">System</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Real states only. Anything not connected reads as unknown rather than green.
        </p>
      </header>

      <Panel title="Health" pad={false}>
        <ul className="grid sm:grid-cols-2">
          {res.data.checks.map((c) => (
            <li key={c.id} className="flex items-start gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--line)' }}>
              <Badge tone={STATE_TONE[c.state]}>{c.state}</Badge>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium">{c.label}</span>
                <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <SyncPanel canEdit={me.data?.capabilities.includes('settings:write') ?? false} />

      <Panel
        title="Inbound events from the website"
        pad={false}
        action={res.data.ingest.some((e) => e.status === 'failed') ? (
          <Button size="sm" disabled={busy} onClick={async () => {
            if (!confirm('Clear the failed events? Do this once the cause is fixed.')) return;
            setBusy(true);
            try { await api.post('/system/ingest/dismiss-failed'); res.reload(); }
            finally { setBusy(false); }
          }}>Clear failed</Button>
        ) : undefined}
      >
        {res.data.ingest.length === 0 ? (
          <Empty
            title="No events received yet"
            hint="When the website is wired up and a parent submits a registration, every attempt appears here with its outcome."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide"
                    style={{ borderColor: 'var(--line)', color: 'var(--text-faint)' }}>
                  <th className="px-4 py-2.5 font-semibold">Event</th>
                  <th className="px-4 py-2.5 font-semibold">Type</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  <th className="px-4 py-2.5 font-semibold">Received</th>
                  <th className="px-4 py-2.5 font-semibold">Error</th>
                </tr>
              </thead>
              <tbody>
                {res.data.ingest.map((e) => (
                  <tr key={String(e.event_id)} className="border-b last:border-b-0" style={{ borderColor: 'var(--line)' }}>
                    <td className="px-4 py-2.5 font-mono text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      {String(e.event_id).slice(0, 8)}
                    </td>
                    <td className="px-4 py-2.5">{String(e.type)}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={e.status === 'processed' ? 'ok' : e.status === 'failed' ? 'crit' : 'warn'}>
                        {String(e.status)}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5" style={{ color: 'var(--text-faint)' }}>
                      <When iso={String(e.received_at)} />
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-2.5" style={{ color: 'var(--color-crit-400)' }}>
                      {e.error ? String(e.error) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Outbound queue" pad={false}>
        {res.data.outbox.length === 0 ? (
          <Empty title="Nothing queued"
                 hint="Outbound syncs (Google Sheets, email) queue here so a failure never loses the record that caused it." />
        ) : (
          <ul>
            {res.data.outbox.map((o) => (
              <li key={String(o.id)} className="flex flex-wrap items-center gap-3 border-b px-4 py-3 last:border-b-0"
                  style={{ borderColor: 'var(--line)' }}>
                <Badge tone={o.status === 'sent' ? 'ok' : o.status === 'pending' ? 'warn' : 'crit'}>
                  {String(o.status)}
                </Badge>
                <span className="flex-1 text-[13px]">{String(o.channel)}</span>
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {Number(o.attempts)} attempt{Number(o.attempts) === 1 ? '' : 's'} &middot; <When iso={String(o.created_at)} />
                </span>
                {o.last_error && (
                  <span className="w-full text-[11px]" style={{ color: 'var(--color-crit-400)' }}>{String(o.last_error)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Not built yet">
        {/* Stating what does not exist is more useful than a screen of greyed
            out buttons that imply it nearly does. Keep this honest: an item
            stays here until it actually works. (spec 218) */}
        <ul className="flex flex-col gap-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          <li>Google Sheets two-way sync. The outbound queue above already records what would be sent.</li>
          <li>Sending email or SMS to a parent. The CRM drafts; a person sends.</li>
          <li>Documents, incidents, staff records.</li>
          <li>Billing and payments.</li>
          <li>
            Posting to Facebook or Instagram. This is not a code gap: it needs Meta Business
            verification and App Review, which is an approval process rather than a build.
          </li>
          <li>Voice agents. The event contract accepts their shape already; nothing emits it.</li>
        </ul>
        <p className="mt-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Spreadsheet import, message drafting, registration completeness, automations, backups and
          the AI layer are built and in use. AI is off unless a provider is configured.
        </p>
      </Panel>
    </div>
  );
}
