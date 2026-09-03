/**
 * Correcting a child's or a guardian's details.
 *
 * The rule that shapes both of these: a person typing here may OVERWRITE, and
 * may blank a field. That is the opposite of the website intake, which may only
 * ever fill a gap — a parent resubmitting a form must never wipe a phone number
 * staff corrected, but staff correcting it is the whole point of being here.
 *
 * Every change is an event, so the previous value is never actually lost.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { Button, Field, TextInput, SelectInput, Modal } from './kit.tsx';

const AGE_BANDS = [
  'Under 12 months', '12-18 months', '18 months - 3 years',
  '3-5 years', '5-6 years', '6-12 years',
] as const;

const CHILD_STATUSES = ['prospective', 'waitlisted', 'offered', 'enrolled', 'withdrawn'] as const;
const RELATIONSHIPS = ['Parent', 'Mother', 'Father', 'Guardian', 'Grandparent', 'Other'];

type Row = Record<string, string | number | null>;
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** Shared: derive the band from a birthday so the two cannot disagree. */
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

// -------------------------------------------------------------------- child

export function EditChild(
  { child, canSeeDob, onClose, onSaved }:
  { child: Row; canSeeDob: boolean; onClose: () => void; onSaved: () => void },
) {
  const [firstName, setFirstName] = useState(str(child.first_name));
  const [lastName, setLastName] = useState(str(child.last_name));
  const [dateOfBirth, setDateOfBirth] = useState(str(child.date_of_birth));
  const [ageBand, setAgeBand] = useState(str(child.age_band));
  const [status, setStatus] = useState(str(child.status) || 'prospective');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.patch(`/children/${String(child.id)}`, {
        firstName: firstName.trim(),
        lastName: lastName.trim() || null,
        // Only send a birthday if this role is allowed one, otherwise a blank
        // field on screen would clear a date the person cannot even see.
        ...(canSeeDob ? { dateOfBirth: dateOfBirth || null } : {}),
        ageBand: ageBand || null,
        status,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${str(child.first_name)}`}
      description="Corrections are recorded, so the previous value is never lost."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !firstName.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && (
          <p className="sm:col-span-2 rounded-lg px-3 py-2 text-[13px]" role="alert"
             style={{ background: 'color-mix(in oklab, var(--color-crit-400) 16%, transparent)',
                      color: 'var(--color-crit-400)' }}>{error}</p>
        )}

        <Field label="First name" required>
          {(p) => <TextInput {...p} value={firstName} autoFocus
                             onChange={(e) => setFirstName(e.target.value)} />}
        </Field>
        <Field label="Last name">
          {(p) => <TextInput {...p} value={lastName} onChange={(e) => setLastName(e.target.value)} />}
        </Field>

        {canSeeDob ? (
          <Field label="Date of birth" hint="Changing this updates the age group.">
            {(p) => (
              <TextInput {...p} type="date" value={dateOfBirth}
                         max={new Date().toISOString().slice(0, 10)}
                         onChange={(e) => {
                           setDateOfBirth(e.target.value);
                           setAgeBand(bandFor(e.target.value));
                         }} />
            )}
          </Field>
        ) : (
          <Field label="Date of birth" hint="Your role cannot see or change a date of birth.">
            {(p) => <TextInput {...p} value="—" disabled readOnly />}
          </Field>
        )}

        <Field label="Age group"
               hint={dateOfBirth ? 'Worked out from the date of birth.' : 'Used when no birthday is known.'}>
          {(p) => (
            <SelectInput {...p} value={ageBand} onChange={(e) => setAgeBand(e.target.value)}>
              <option value="">Not known</option>
              {AGE_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </SelectInput>
          )}
        </Field>

        <Field label="Status" hint="Enrolled children appear on the register.">
          {(p) => (
            <SelectInput {...p} value={status} onChange={(e) => setStatus(e.target.value)}>
              {CHILD_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </SelectInput>
          )}
        </Field>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- guardian

export function EditGuardian(
  { guardian, onClose, onSaved }:
  { guardian: Row; onClose: () => void; onSaved: () => void },
) {
  const [fullName, setFullName] = useState(
    [str(guardian.first_name), str(guardian.last_name)].filter(Boolean).join(' '));
  const [relationship, setRelationship] = useState(str(guardian.relationship) || 'Parent');
  const [email, setEmail] = useState(str(guardian.email));
  const [phone, setPhone] = useState(str(guardian.phone));
  const [isPrimary, setIsPrimary] = useState(guardian.is_primary === 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.patch(`/guardians/${String(guardian.id)}`, {
        fullName: fullName.trim(),
        relationship: relationship || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        isPrimary,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save that');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${fullName || 'guardian'}`}
      description="Corrections are recorded, so the previous value is never lost."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !fullName.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && (
          <p className="sm:col-span-2 rounded-lg px-3 py-2 text-[13px]" role="alert"
             style={{ background: 'color-mix(in oklab, var(--color-crit-400) 16%, transparent)',
                      color: 'var(--color-crit-400)' }}>{error}</p>
        )}

        <Field label="Full name" required>
          {(p) => <TextInput {...p} value={fullName} autoFocus
                             onChange={(e) => setFullName(e.target.value)} />}
        </Field>
        <Field label="Relationship to the child">
          {(p) => (
            <SelectInput {...p} value={relationship} onChange={(e) => setRelationship(e.target.value)}>
              {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectInput>
          )}
        </Field>
        <Field label="Email">
          {(p) => <TextInput {...p} type="email" value={email}
                             onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Phone">
          {(p) => <TextInput {...p} type="tel" value={phone}
                             onChange={(e) => setPhone(e.target.value)} />}
        </Field>

        <label className="flex items-center gap-2 text-[13px] sm:col-span-2">
          <input type="checkbox" checked={isPrimary} className="size-4"
                 onChange={(e) => setIsPrimary(e.target.checked)} />
          Main contact for this family
        </label>
        <p className="sm:col-span-2 -mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          A family has one main contact. Setting this here takes it off whoever holds it now.
        </p>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- adding

export function AddPerson(
  { familyId, kind, onClose, onSaved }:
  { familyId: string; kind: 'child' | 'guardian'; onClose: () => void; onSaved: () => void },
) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [ageBand, setAgeBand] = useState('');
  const [relationship, setRelationship] = useState('Parent');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isChild = kind === 'child';

  async function save() {
    setBusy(true); setError(null);
    try {
      if (isChild) {
        await api.post(`/families/${familyId}/children`, {
          firstName: firstName.trim(),
          lastName: lastName.trim() || undefined,
          dateOfBirth: dateOfBirth || undefined,
          ageBand: (ageBand || bandFor(dateOfBirth)) || undefined,
        });
      } else {
        await api.post(`/families/${familyId}/guardians`, {
          fullName: firstName.trim(),
          relationship: relationship || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isChild ? 'Add a child' : 'Add a guardian'}
      description={isChild
        ? 'A first name is enough. A birthday sets the age group and keeps it right as they grow.'
        : 'A name, and an email or phone number so somebody can reach them.'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !firstName.trim()} onClick={() => void save()}>
            {busy ? 'Adding…' : isChild ? 'Add child' : 'Add guardian'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {error && (
          <p className="sm:col-span-2 rounded-lg px-3 py-2 text-[13px]" role="alert"
             style={{ background: 'color-mix(in oklab, var(--color-crit-400) 16%, transparent)',
                      color: 'var(--color-crit-400)' }}>{error}</p>
        )}

        <Field label={isChild ? 'First name' : 'Full name'} required>
          {(p) => <TextInput {...p} value={firstName} autoFocus
                             onChange={(e) => setFirstName(e.target.value)} />}
        </Field>

        {isChild ? (
          <>
            <Field label="Last name">
              {(p) => <TextInput {...p} value={lastName}
                                 onChange={(e) => setLastName(e.target.value)} />}
            </Field>
            <Field label="Date of birth" hint="Sets the age group, and keeps it right as they grow.">
              {(p) => (
                <TextInput {...p} type="date" value={dateOfBirth}
                           max={new Date().toISOString().slice(0, 10)}
                           onChange={(e) => {
                             setDateOfBirth(e.target.value);
                             setAgeBand(bandFor(e.target.value));
                           }} />
              )}
            </Field>
            <Field label="Age group" hint={dateOfBirth ? 'Worked out from the birthday.' : 'If no birthday is known.'}>
              {(p) => (
                <SelectInput {...p} value={ageBand} onChange={(e) => setAgeBand(e.target.value)}>
                  <option value="">Not known yet</option>
                  {AGE_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
                </SelectInput>
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="Relationship to the child">
              {(p) => (
                <SelectInput {...p} value={relationship} onChange={(e) => setRelationship(e.target.value)}>
                  {RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}
                </SelectInput>
              )}
            </Field>
            <Field label="Email">
              {(p) => <TextInput {...p} type="email" value={email}
                                 onChange={(e) => setEmail(e.target.value)} />}
            </Field>
            <Field label="Phone">
              {(p) => <TextInput {...p} type="tel" value={phone}
                                 onChange={(e) => setPhone(e.target.value)} />}
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}
