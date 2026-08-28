import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Panel, Badge, Button, Empty, Spinner, ErrorNote, When } from '../ui/kit.tsx';

interface Automation {
  id: string; name: string; description: string | null; trigger: string;
  conditions: { type: string; [k: string]: unknown }[];
  actions: { type: string; title?: string; text?: string; [k: string]: unknown }[];
  enabled: number; test_mode: number; max_per_run: number; built_in: number;
  run_count: number; last_run_at: string | null;
}
interface TriggerDef { id: string; label: string; when: string; scheduled: boolean }
interface Run {
  id: string; automation_id: string; automation_name?: string;
  outcome: 'acted' | 'skipped' | 'failed' | 'test';
  reason: string; actions_json: string | null; created_at: string;
}
interface Bundle { automations: Automation[]; triggers: TriggerDef[]; runs: Run[] }

const describeAction = (a: Automation['actions'][number]): string => {
  switch (a.type) {
    case 'create_task': return `create a task: "${a.title ?? ''}"`;
    case 'notify': return `raise an alert: "${a.title ?? ''}"`;
    case 'set_next_action': return `set the next action to "${a.text ?? ''}"`;
    case 'assign_owner': return 'assign an owner';
    case 'add_note': return 'add a note';
    default: return a.type;
  }
};

const describeCondition = (c: Automation['conditions'][number]): string => {
  switch (c.type) {
    case 'hours_since': return `more than ${c.moreThan}h since ${String(c.field).replace('_', ' ')}`;
    case 'no_contact_logged': return 'no contact has been logged since';
    case 'no_open_task': return 'there is no open task already';
    case 'program_is': return `the program is ${String(c.value)}`;
    case 'stage_is': return `the stage is ${String(c.value)}`;
    default: return c.type;
  }
};

/**
 * Rules a director can read, not behaviour buried in the pipeline.
 *
 * The important part of this screen is the run log underneath: it shows the
 * runs that did nothing and why, because "why didn't it fire?" is the question
 * people actually ask.
 */
export function Automations() {
  const res = useApi<Bundle>('/automations');
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try { await api.patch(`/automations/${id}`, body); res.reload(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Could not update'); }
    finally { setBusy(null); }
  }

  async function runNow(id: string) {
    setBusy(id);
    try {
      const s = await api.post<{ acted: number; skipped: number; failed: number }>(`/automations/${id}/run`);
      alert(`Acted on ${s.acted}, skipped ${s.skipped}, failed ${s.failed}.`);
      res.reload();
    } catch (e) { alert(e instanceof Error ? e.message : 'Could not run'); }
    finally { setBusy(null); }
  }

  async function killAll() {
    if (!confirm('Turn off every automation? Nothing will run until you switch them back on.')) return;
    setBusy('all');
    try { await api.post('/automations/disable-all'); res.reload(); }
    finally { setBusy(null); }
  }

  if (res.loading && !res.data) return <Spinner label="Loading automations" />;
  if (res.error) return <ErrorNote error={res.error} retry={res.reload} />;
  if (!res.data) return null;

  const { automations, triggers, runs } = res.data;
  const triggerOf = (id: string) => triggers.find((t) => t.id === id);
  const anyOn = automations.some((a) => a.enabled);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Automations</h1>
          <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Rules that watch for something and create work. None of them ever message a parent.
          </p>
        </div>
        {anyOn && (
          <Button variant="danger" onClick={killAll} disabled={busy === 'all'}>
            Turn everything off
          </Button>
        )}
      </header>

      {automations.length === 0 ? (
        <Panel><Empty title="No automations" /></Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {automations.map((a) => {
            const t = triggerOf(a.trigger);
            return (
              <div key={a.id} className="panel p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{a.name}</span>
                      {!a.enabled && <Badge tone="neutral">off</Badge>}
                      {a.test_mode === 1 && <Badge tone="warn">test mode</Badge>}
                      {a.built_in === 1 && <Badge tone="info">built in</Badge>}
                    </div>
                    {a.description && (
                      <p className="mt-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>{a.description}</p>
                    )}

                    {/* The rule in words, so nobody has to read JSON. */}
                    <div className="mt-2.5 rounded-lg p-3 text-[12px]" style={{ background: 'var(--surface-sunken)' }}>
                      <p><span style={{ color: 'var(--text-faint)' }}>When </span>{t?.label.toLowerCase() ?? a.trigger}</p>
                      {a.conditions.length > 0 && (
                        <p className="mt-1">
                          <span style={{ color: 'var(--text-faint)' }}>and </span>
                          {a.conditions.map(describeCondition).join(', and ')}
                        </p>
                      )}
                      <p className="mt-1">
                        <span style={{ color: 'var(--text-faint)' }}>then </span>
                        {a.actions.map(describeAction).join(', and ')}
                      </p>
                    </div>

                    <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                      {t?.scheduled ? t.when : 'Fires immediately'} &middot; at most {a.max_per_run} at a time
                      {a.last_run_at && <> &middot; last checked <When iso={a.last_run_at} /></>}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    <Button size="sm" disabled={busy === a.id}
                            onClick={() => patch(a.id, { enabled: !a.enabled })}>
                      {a.enabled ? 'Turn off' : 'Turn on'}
                    </Button>
                    <Button size="sm" disabled={busy === a.id}
                            onClick={() => patch(a.id, { test_mode: !a.test_mode })}>
                      {a.test_mode ? 'Go live' : 'Test only'}
                    </Button>
                    <Button size="sm" disabled={busy === a.id} onClick={() => runNow(a.id)}>Run now</Button>
                    <Button size="sm" variant="ghost"
                            onClick={() => setOpen(open === a.id ? null : a.id)}>
                      {open === a.id ? 'Hide log' : 'Log'}
                    </Button>
                  </div>
                </div>

                {open === a.id && <RunLog automationId={a.id} />}
              </div>
            );
          })}
        </div>
      )}

      <Panel title="Everything that has run" pad={false}>
        {runs.length === 0 ? (
          <Empty title="Nothing has run yet"
                 hint="Time-based rules are checked hourly. Event rules fire the moment something happens." />
        ) : (
          <ul>
            {runs.slice(0, 40).map((r) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 border-b px-4 py-2.5 last:border-b-0"
                  style={{ borderColor: 'var(--line)' }}>
                <Badge tone={r.outcome === 'acted' ? 'ok' : r.outcome === 'failed' ? 'crit'
                  : r.outcome === 'test' ? 'warn' : 'neutral'}>
                  {r.outcome}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px]">{r.automation_name ?? r.automation_id}</span>
                  <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>{r.reason}</span>
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  <When iso={r.created_at} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="What automations will never do">
        <ul className="flex flex-col gap-1.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          <li>Send anything to a parent. They can draft and remind; a person sends.</li>
          <li>Delete a record, or merge two families.</li>
          <li>Change anybody's permissions.</li>
          <li>Run without recording what they did, including when they did nothing.</li>
        </ul>
      </Panel>
    </div>
  );
}

function RunLog({ automationId }: { automationId: string }) {
  const res = useApi<{ runs: Run[] }>(`/automations/${automationId}/runs`);
  if (res.loading) return <div className="mt-3"><Spinner label="Loading" /></div>;
  const runs = res.data?.runs ?? [];
  if (!runs.length) {
    return <p className="mt-3 text-[12px]" style={{ color: 'var(--text-faint)' }}>This rule has not run yet.</p>;
  }
  return (
    <ul className="mt-3 flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg p-2"
        style={{ background: 'var(--surface-sunken)' }}>
      {runs.map((r) => (
        <li key={r.id} className="flex items-start gap-2 text-[11px]">
          <span className="w-14 shrink-0 font-medium"
                style={{ color: r.outcome === 'acted' ? 'var(--color-ok-400)'
                  : r.outcome === 'failed' ? 'var(--color-crit-400)' : 'var(--text-faint)' }}>
            {r.outcome}
          </span>
          <span className="flex-1" style={{ color: 'var(--text-muted)' }}>{r.reason}</span>
          <span className="shrink-0" style={{ color: 'var(--text-faint)' }}><When iso={r.created_at} /></span>
        </li>
      ))}
    </ul>
  );
}
