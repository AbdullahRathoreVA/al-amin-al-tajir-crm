/**
 * Outbound sync, on /system.
 *
 * The one thing this screen must never do is imply a sync is happening when
 * nothing is connected. A channel with no credentials shows as "not connected"
 * with the reason and the exact number of rows waiting — which is a setup step
 * a person can act on, not a red light they learn to ignore.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Panel, Badge, Button, Spinner, ErrorNote, When } from '../ui/kit.tsx';

interface ChannelStatus {
  channel: string;
  connected: boolean;
  notConnectedReason: string | null;
  pending: number;
  sent: number;
  dead: number;
  suppressed: number;
  lastSyncAt: string | null;
  lastRun: Record<string, string | number | null> | null;
}

interface Target {
  channel: string; label: string; external_id: string | null;
  tab_name: string | null; enabled: number;
}

interface SyncData {
  targets: Target[];
  channels: ChannelStatus[];
  defaultMapping: Record<string, string>;
  runs: Record<string, string | number | null>[];
}

export function SyncPanel({ canEdit }: { canEdit: boolean }) {
  const res = useApi<SyncData>('/sync');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runNow(channel: string) {
    setBusy(channel); setError(null);
    try {
      await api.post(`/sync/${channel}/run`);
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run the sync.');
    } finally { setBusy(null); }
  }

  if (res.loading && !res.data) return <Panel title="Outbound sync"><Spinner label="Checking sync" /></Panel>;
  if (res.error) return <Panel title="Outbound sync"><ErrorNote error={res.error} retry={res.reload} /></Panel>;
  if (!res.data) return null;

  const targetFor = (channel: string) => res.data!.targets.find((t) => t.channel === channel);

  return (
    <Panel title="Outbound sync" pad={false}>
      {error && <div className="px-4 pt-3"><ErrorNote error={error} retry={() => setError(null)} /></div>}

      {res.data.channels.map((c) => {
        const target = targetFor(c.channel);
        return (
          <div key={c.channel} className="border-b px-4 py-3.5 last:border-b-0"
               style={{ borderColor: 'var(--line)' }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-medium">{target?.label ?? c.channel}</span>
              {/* "not connected" is neutral, never a warning: nobody has done a
                  setup step, which is different from something being broken. */}
              <Badge tone={c.connected ? (c.dead > 0 ? 'crit' : 'ok') : 'neutral'}>
                {c.connected ? (c.dead > 0 ? 'failing' : 'connected') : 'not connected'}
              </Badge>
              {canEdit && c.connected && (
                <Button size="sm" variant="ghost" disabled={busy === c.channel}
                        onClick={() => void runNow(c.channel)}>
                  {busy === c.channel ? 'Running…' : 'Sync now'}
                </Button>
              )}
            </div>

            {!c.connected && c.notConnectedReason && (
              <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {c.notConnectedReason}
              </p>
            )}

            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px]"
                style={{ color: 'var(--text-muted)' }}>
              <span><dt className="inline font-medium">Queued</dt>{' '}
                <dd className="tabular inline">{c.pending}</dd></span>
              <span><dt className="inline font-medium">Sent</dt>{' '}
                <dd className="tabular inline">{c.sent}</dd></span>
              {c.dead > 0 && (
                <span style={{ color: 'var(--color-crit-400)' }}>
                  <dt className="inline font-medium">Gave up</dt>{' '}
                  <dd className="tabular inline">{c.dead}</dd></span>
              )}
              {/* Not a silent omission: a family asked not to be synced. */}
              {c.suppressed > 0 && (
                <span><dt className="inline font-medium">Held back by “never sync”</dt>{' '}
                  <dd className="tabular inline">{c.suppressed}</dd></span>
              )}
              <span><dt className="inline font-medium">Last sent</dt>{' '}
                <dd className="inline">
                  {c.lastSyncAt ? <When iso={c.lastSyncAt} /> : 'never'}
                </dd></span>
            </dl>

            {c.lastRun && (
              <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                Last run: {String(c.lastRun.outcome).replace(/_/g, ' ')}
                {c.lastRun.detail ? ` — ${c.lastRun.detail}` : ''}
                {' · '}<When iso={String(c.lastRun.started_at)} />
              </p>
            )}
          </div>
        );
      })}

      {res.data.runs.length > 0 && (
        <details className="border-t px-4 py-3" style={{ borderColor: 'var(--line)' }}>
          <summary className="cursor-pointer text-[12px] font-medium">
            Recent sync runs ({res.data.runs.length})
          </summary>
          <ul className="mt-2 flex flex-col gap-1">
            {res.data.runs.map((r) => (
              <li key={String(r.id)} className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span className="tabular">{String(r.started_at).slice(0, 16).replace('T', ' ')}</span>
                {' · '}{String(r.channel)}
                {' · '}{String(r.outcome).replace(/_/g, ' ')}
                {Number(r.sent) > 0 && ` · sent ${r.sent}`}
                {Number(r.failed) > 0 && ` · failed ${r.failed}`}
                {r.detail ? ` · ${String(r.detail)}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
