/**
 * Adding a task by hand.
 *
 * Most tasks here are created by the system, each with a reason attached — a
 * registration nobody reviewed, a tour with no time set. But a nursery's day
 * is full of things no rule will ever notice: ring the plumber, order more
 * wipes, ask the Okonkwos about the September start. Without a way to write
 * those down here, people keep a second list on paper, and then the CRM is no
 * longer where the work lives.
 *
 * A hand-written task records who wrote it and when, the same as any other.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Button, Field, TextInput, TextArea, SelectInput, Modal, ErrorNote } from './kit.tsx';

const PRIORITIES = [
  ['normal', 'Normal'],
  ['high', 'High — needs doing soon'],
  ['critical', 'Critical — today'],
  ['low', 'Low — when there is time'],
] as const;

interface FamilyOption { id: string; name: string }

export function AddTask({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState('normal');
  const [dueAt, setDueAt] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // So a task can be pinned to the family it is about, which is what makes it
  // show up on that family's page later.
  const families = useApi<{ families: FamilyOption[] }>('/families?limit=500');

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post('/tasks', {
        title: title.trim(),
        body: body.trim() || undefined,
        priority,
        // The browser knows the local date; a due date at the wrong end of a
        // timezone is a task that looks overdue the moment it is written.
        dueAt: dueAt ? new Date(`${dueAt}T17:00:00`).toISOString() : undefined,
        relatedType: familyId ? 'family' : undefined,
        relatedId: familyId || undefined,
        reason: 'Added by hand',
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that task');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a task"
      description="For the things no rule will ever notice."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !title.trim()} onClick={() => void save()}>
            {busy ? 'Adding…' : 'Add task'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <ErrorNote error={error} />}

        <Field label="What needs doing" required
               hint="Write it as an instruction: “Ring the plumber about the Comet Stars sink”.">
          {(p) => <TextInput {...p} value={title} autoFocus
                             onChange={(e) => setTitle(e.target.value)} />}
        </Field>

        <Field label="Anything else worth knowing">
          {(p) => <TextArea {...p} rows={3} value={body}
                            onChange={(e) => setBody(e.target.value)} />}
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="How urgent">
            {(p) => (
              <SelectInput {...p} value={priority} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </SelectInput>
            )}
          </Field>
          <Field label="Due by" hint="Leave blank if it is not time-critical.">
            {(p) => <TextInput {...p} type="date" value={dueAt}
                               onChange={(e) => setDueAt(e.target.value)} />}
          </Field>
        </div>

        <Field label="About a family" hint="Optional. Pinning it here makes it show on their page.">
          {(p) => (
            <SelectInput {...p} value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
              <option value="">Not about a particular family</option>
              {(families.data?.families ?? []).map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </SelectInput>
          )}
        </Field>
      </div>
    </Modal>
  );
}
