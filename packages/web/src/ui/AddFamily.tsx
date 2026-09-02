/**
 * Adding a family by hand.
 *
 * A daycare takes enrolments on the phone and at the door, so this is not a
 * secondary path — for a lot of centres it is the main one. Two things make it
 * bearable to use:
 *
 *   1. Only a guardian's name and one way to contact them are required. A
 *      parent standing at the desk will not have a date of birth to hand, and
 *      a form that demands one is a form staff work around by typing rubbish.
 *   2. Duplicates are caught BEFORE the record is written, not raised as a
 *      cleanup task afterwards. The person is right there and can just open the
 *      family they already have.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useRouter } from '../lib/router.tsx';
import { Button, Field, TextInput, SelectInput, TextArea, Modal } from './kit.tsx';

const AGE_BANDS = [
  'Under 12 months', '12-18 months', '18 months - 3 years',
  '3-5 years', '5-6 years', '6-12 years',
] as const;

const RELATIONSHIPS = ['Parent', 'Mother', 'Father', 'Guardian', 'Grandparent', 'Other'];

interface GuardianDraft { fullName: string; relationship: string; email: string; phone: string }
interface ChildDraft { firstName: string; lastName: string; dateOfBirth: string; ageBand: string }

interface Duplicate { familyId: string; familyName: string; confidence: number; reasons: string[] }

const blankGuardian = (): GuardianDraft => ({ fullName: '', relationship: 'Parent', email: '', phone: '' });
const blankChild = (): ChildDraft => ({ firstName: '', lastName: '', dateOfBirth: '', ageBand: '' });

/** Mirrors the server's ageBandFor so the field fills in as you type a date.
 *  The server still decides; this is only so the form is not a surprise. */
function bandFor(dob: string): string {
  if (!dob) return '';
  const from = new Date(dob);
  if (Number.isNaN(from.getTime())) return '';
  const now = new Date();
  let m = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
  if (now.getDate() < from.getDate()) m -= 1;
  if (m < 0) return '';
  if (m < 12) return 'Under 12 months';
  if (m < 18) return '12-18 months';
  if (m < 36) return '18 months - 3 years';
  if (m < 60) return '3-5 years';
  if (m < 72) return '5-6 years';
  if (m < 144) return '6-12 years';
  return '';
}

export function AddFamily({ onClose, onCreated }: { onClose: () => void; onCreated?: (id: string) => void }) {
  const { navigate } = useRouter();
  const [familyName, setFamilyName] = useState('');
  const [guardians, setGuardians] = useState<GuardianDraft[]>([blankGuardian()]);
  const [children, setChildren] = useState<ChildDraft[]>([blankChild()]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<Duplicate[] | null>(null);

  const setGuardian = (i: number, patch: Partial<GuardianDraft>) =>
    setGuardians((gs) => gs.map((g, n) => (n === i ? { ...g, ...patch } : g)));
  const setChild = (i: number, patch: Partial<ChildDraft>) =>
    setChildren((cs) => cs.map((c, n) => (n === i ? { ...c, ...patch } : c)));

  async function submit(confirmDuplicate = false) {
    setBusy(true); setError(null);
    try {
      const payload = {
        familyName: familyName.trim() || undefined,
        confirmDuplicate,
        guardians: guardians
          .filter((g) => g.fullName.trim())
          .map((g) => ({
            fullName: g.fullName.trim(),
            relationship: g.relationship || undefined,
            email: g.email.trim() || undefined,
            phone: g.phone.trim() || undefined,
          })),
        // A family with no child yet is normal: an expecting parent enquiring
        // is a lead worth keeping.
        children: children
          .filter((c) => c.firstName.trim())
          .map((c) => ({
            firstName: c.firstName.trim(),
            lastName: c.lastName.trim() || undefined,
            dateOfBirth: c.dateOfBirth || undefined,
            ageBand: (c.ageBand || bandFor(c.dateOfBirth)) || undefined,
          })),
        notes: notes.trim() || undefined,
      };
      const res = await api.post<{ familyId: string }>('/families', payload);
      onCreated?.(res.familyId);
      navigate(`/families/${res.familyId}`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const d = err.detail as { duplicates?: Duplicate[] } | undefined;
        setDuplicates(d?.duplicates ?? []);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not save this family');
      }
      setBusy(false);
    }
  }

  // ------------------------------------------------------- duplicate step
  if (duplicates) {
    return (
      <Modal
        title="This may already be in the CRM"
        description="Nothing has been saved yet. Open the family you already have, or add this one anyway."
        onClose={onClose}
        footer={
          <>
            <Button onClick={() => setDuplicates(null)}>Back to the form</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit(true)}>
              {busy ? 'Adding…' : 'Add as a separate family'}
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-2">
          {duplicates.map((d) => (
            <li key={d.familyId} className="rounded-lg border p-3" style={{ borderColor: 'var(--line-strong)' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="text-sm font-medium underline"
                  onClick={() => { navigate(`/families/${d.familyId}`); onClose(); }}
                >
                  {d.familyName}
                </button>
                <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {Math.round(d.confidence * 100)}% match
                </span>
              </div>
              <p className="mt-1 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {d.reasons.join('; ')}
              </p>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }

  // -------------------------------------------------------------- the form
  return (
    <Modal
      title="Add a family"
      description="A name and one way to get in touch is enough. Everything else can wait."
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !guardians.some((g) => g.fullName.trim())}
                  onClick={() => void submit(false)}>
            {busy ? 'Saving…' : 'Add family'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error && (
          <p className="rounded-lg px-3 py-2 text-[13px]"
             style={{ background: 'color-mix(in oklab, var(--color-crit-400) 16%, transparent)',
                      color: 'var(--color-crit-400)' }} role="alert">
            {error}
          </p>
        )}

        {/* ------------------------------------------------------ guardians */}
        <fieldset className="flex flex-col gap-3">
          <legend className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-faint)' }}>Guardians</legend>

          {guardians.map((g, i) => (
            <div key={i} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
                 style={{ borderColor: 'var(--line)' }}>
              <Field label="Full name" required>
                {(p) => (
                  <TextInput {...p} value={g.fullName} autoFocus={i === 0}
                             placeholder="Ngozi Okonkwo"
                             onChange={(e) => setGuardian(i, { fullName: e.target.value })} />
                )}
              </Field>
              <Field label="Relationship to the child">
                {(p) => (
                  <SelectInput {...p} value={g.relationship}
                               onChange={(e) => setGuardian(i, { relationship: e.target.value })}>
                    {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </SelectInput>
                )}
              </Field>
              <Field label="Email" hint={i === 0 ? 'An email or a phone number — at least one.' : undefined}>
                {(p) => (
                  <TextInput {...p} type="email" value={g.email} autoComplete="off"
                             onChange={(e) => setGuardian(i, { email: e.target.value })} />
                )}
              </Field>
              <Field label="Phone">
                {(p) => (
                  <TextInput {...p} type="tel" value={g.phone} autoComplete="off"
                             onChange={(e) => setGuardian(i, { phone: e.target.value })} />
                )}
              </Field>
              {guardians.length > 1 && (
                <div className="sm:col-span-2">
                  <Button size="sm" variant="ghost"
                          onClick={() => setGuardians((gs) => gs.filter((_, n) => n !== i))}>
                    Remove this guardian
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div>
            <Button size="sm" onClick={() => setGuardians((gs) => [...gs, blankGuardian()])}>
              + Another guardian
            </Button>
          </div>
        </fieldset>

        {/* ------------------------------------------------------- children */}
        <fieldset className="flex flex-col gap-3">
          <legend className="text-[11px] font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-faint)' }}>Children</legend>

          {children.map((c, i) => (
            <div key={i} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2"
                 style={{ borderColor: 'var(--line)' }}>
              <Field label="First name">
                {(p) => (
                  <TextInput {...p} value={c.firstName} placeholder="Chidi"
                             onChange={(e) => setChild(i, { firstName: e.target.value })} />
                )}
              </Field>
              <Field label="Last name">
                {(p) => (
                  <TextInput {...p} value={c.lastName}
                             onChange={(e) => setChild(i, { lastName: e.target.value })} />
                )}
              </Field>
              <Field label="Date of birth" hint="Sets the age group, and keeps it right as they grow.">
                {(p) => (
                  <TextInput {...p} type="date" value={c.dateOfBirth}
                             max={new Date().toISOString().slice(0, 10)}
                             onChange={(e) => setChild(i, {
                               dateOfBirth: e.target.value,
                               ageBand: bandFor(e.target.value),
                             })} />
                )}
              </Field>
              <Field label="Age group"
                     hint={c.dateOfBirth ? 'Worked out from the date of birth.' : 'Use this if you do not have a birthday yet.'}>
                {(p) => (
                  <SelectInput {...p} value={c.ageBand}
                               onChange={(e) => setChild(i, { ageBand: e.target.value })}>
                    <option value="">Not known yet</option>
                    {AGE_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                  </SelectInput>
                )}
              </Field>
              {children.length > 1 && (
                <div className="sm:col-span-2">
                  <Button size="sm" variant="ghost"
                          onClick={() => setChildren((cs) => cs.filter((_, n) => n !== i))}>
                    Remove this child
                  </Button>
                </div>
              )}
            </div>
          ))}
          <div>
            <Button size="sm" onClick={() => setChildren((cs) => [...cs, blankChild()])}>
              + Another child
            </Button>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
            No child yet is fine — an expecting parent asking about places is still worth recording.
          </p>
        </fieldset>

        <Field label="Note" hint="Anything you want to remember about this conversation.">
          {(p) => (
            <TextArea {...p} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
                      placeholder="Called about a September start for two mornings a week." />
          )}
        </Field>
      </div>
    </Modal>
  );
}
