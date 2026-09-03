/**
 * Your account, and — for an owner — everyone else's.
 *
 * Both of these existed only over SSH, which had two consequences on a live
 * system: a placeholder password survived because rotating it was too much
 * trouble, and "I have forgotten mine" had no answer that did not involve a
 * developer. Neither is acceptable on a system a nursery runs on its own.
 */
import { useState } from 'react';
import { api, ApiError, type Me } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import {
  Panel, Badge, Button, Field, TextInput, SelectInput, PasswordInput,
  Modal, Spinner, ErrorNote, Empty, When,
} from '../ui/kit.tsx';

interface StaffUser {
  id: string; email: string; name: string; role: string;
  status: 'active' | 'suspended'; created_at: string;
  last_login_at: string | null; sessions: number;
}
interface UsersResponse { users: StaffUser[]; minPassword: number; roles: string[] }

const ROLE_HELP: Record<string, string> = {
  owner: 'Everything, including staff accounts.',
  director: 'Everything except creating staff accounts.',
  admissions: 'Enquiries, families, tours and registrations.',
  educator: 'Their own rooms. No dates of birth, no exporting.',
  accounting: 'Read-only, plus exporting. Cannot change the register.',
  readonly: 'Can look, cannot change anything.',
};

export function Account({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  const isOwner = me.capabilities.includes('user:manage');
  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Your account</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Signed in as <strong>{me.user.name}</strong> ({me.user.role}).
        </p>
      </header>

      <ChangePassword onSignedOut={onSignedOut} />
      {isOwner && <StaffAccounts myId={me.user.id} />}
    </div>
  );
}

// ------------------------------------------------------- your own password

function ChangePassword({ onSignedOut }: { onSignedOut: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ signedOut: number }>('/auth/password', {
        currentPassword: current, newPassword: next,
      });
      setCurrent(''); setNext(''); setConfirm('');
      setDone(r.signedOut > 0
        ? `Password changed. ${r.signedOut} other device${r.signedOut === 1 ? '' : 's'} signed out.`
        : 'Password changed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change your password');
    } finally { setBusy(false); }
  }

  return (
    <Panel title="Change your password">
      <form onSubmit={submit} className="grid max-w-lg gap-3">
        <Field label="Your current password" required
               hint="Asked for even though you are signed in — otherwise an unlocked screen is a permanent takeover.">
          {(p) => <PasswordInput {...p} autoComplete="current-password"
                                 value={current} onChange={(e) => setCurrent(e.target.value)} />}
        </Field>
        <Field label="New password" required hint="At least 12 characters. Press Show to check what you typed.">
          {(p) => <PasswordInput {...p} autoComplete="new-password"
                                 value={next} onChange={(e) => setNext(e.target.value)} />}
        </Field>
        <Field label="New password again" required
               error={mismatch ? 'These two do not match.' : null}>
          {(p) => <PasswordInput {...p} autoComplete="new-password"
                                 value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
        </Field>

        {error && <ErrorNote error={error} />}
        {done && (
          <p className="rounded-lg px-3 py-2 text-[13px]" role="status"
             style={{ background: 'color-mix(in oklab, var(--color-ok-400) 16%, transparent)',
                      color: 'var(--color-ok-600)' }}>{done}</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary"
                  disabled={busy || mismatch || next.length < 12 || !current}>
            {busy ? 'Changing…' : 'Change password'}
          </Button>
          <Button type="button" onClick={() => void api.post('/auth/logout').then(onSignedOut)}>
            Sign out
          </Button>
        </div>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------- staff accounts

function StaffAccounts({ myId }: { myId: string }) {
  const res = useApi<UsersResponse>('/users');
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<StaffUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function patch(u: StaffUser, body: Record<string, unknown>) {
    setBusy(u.id); setError(null);
    try {
      await api.patch(`/users/${u.id}`, body);
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally { setBusy(null); }
  }

  const users = res.data?.users ?? [];

  return (
    <Panel
      title="Staff accounts"
      action={<Button size="sm" onClick={() => setAdding(true)}>+ Add someone</Button>}
    >
      <p className="mb-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
        Give everyone their own account. The record of who did what is only worth
        having if each sign-in is one person.
      </p>

      {res.loading && !res.data && <Spinner label="Loading accounts" />}
      {res.error && <ErrorNote error={res.error} retry={res.reload} />}
      {error && <ErrorNote error={error} retry={() => setError(null)} />}

      {users.length === 0 && !res.loading && <Empty title="No accounts yet" />}

      {users.length > 0 && (
        <ul className="flex flex-col divide-y" style={{ borderColor: 'var(--line)' }}>
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3"
                style={{ borderColor: 'var(--line)' }}>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <strong className="text-[13px]">{u.name}</strong>
                  <Badge tone={u.status === 'active' ? 'ok' : 'warn'}>{u.status}</Badge>
                  {u.id === myId && <Badge tone="info">you</Badge>}
                </span>
                <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {u.email}
                </span>
                <span className="block text-[11px]" style={{ color: 'var(--text-faint)' }}>
                  {u.last_login_at
                    ? <>last signed in <When iso={u.last_login_at} /></>
                    : 'never signed in'}
                  {u.sessions > 0 && ` · ${u.sessions} device${u.sessions === 1 ? '' : 's'} signed in`}
                </span>
              </span>

              <SelectInput
                aria-label={`Role for ${u.name}`}
                value={u.role}
                disabled={u.id === myId || busy === u.id}
                onChange={(e) => void patch(u, { role: e.target.value })}
                className="w-auto min-w-36"
              >
                {(res.data?.roles ?? []).map((r) => <option key={r} value={r}>{r}</option>)}
              </SelectInput>

              <Button size="sm" onClick={() => setResetting(u)}>Reset password</Button>

              {u.id !== myId && (
                <Button
                  size="sm"
                  disabled={busy === u.id}
                  onClick={() => void patch(u, { status: u.status === 'active' ? 'suspended' : 'active' })}
                >
                  {u.status === 'active' ? 'Suspend' : 'Restore'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-[11px]" style={{ color: 'var(--text-faint)' }}>
        Suspending signs that person out everywhere immediately. Accounts are never
        deleted, so the history of what they did stays readable.
      </p>

      {adding && (
        <AddUser
          roles={res.data?.roles ?? []}
          minPassword={res.data?.minPassword ?? 12}
          onClose={() => setAdding(false)}
          onSaved={res.reload}
        />
      )}
      {resetting && (
        <ResetPassword
          user={resetting}
          minPassword={res.data?.minPassword ?? 12}
          onClose={() => setResetting(null)}
          onSaved={res.reload}
        />
      )}
    </Panel>
  );
}

function AddUser(
  { roles, minPassword, onClose, onSaved }:
  { roles: string[]; minPassword: number; onClose: () => void; onSaved: () => void },
) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('educator');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post('/users', { email: email.trim(), name: name.trim(), role, password });
      onSaved(); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that account');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add someone"
      description="They can change this password themselves once they are signed in."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}
                  disabled={busy || !email.trim() || !name.trim() || password.length < minPassword}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <ErrorNote error={error} />}
        <Field label="Email or username" required
               hint="A plain username works — it does not have to be an email address.">
          {(p) => <TextInput {...p} value={email} autoCapitalize="none" spellCheck={false}
                             onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Their name" required>
          {(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Role" hint={ROLE_HELP[role] ?? ''}>
          {(p) => (
            <SelectInput {...p} value={role} onChange={(e) => setRole(e.target.value)}>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectInput>
          )}
        </Field>
        <Field label="First password" required
               hint={`At least ${minPassword} characters. Tell it to them in person, not by email.`}>
          {(p) => <PasswordInput {...p} value={password} autoComplete="new-password"
                                 onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

function ResetPassword(
  { user, minPassword, onClose, onSaved }:
  { user: StaffUser; minPassword: number; onClose: () => void; onSaved: () => void },
) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true); setError(null);
    try {
      await api.post(`/users/${user.id}/password`, { password });
      onSaved(); onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset that password');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Reset the password for ${user.name}`}
      description="This is what to do when somebody has forgotten theirs. Every device they are signed in on will be signed out."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || password.length < minPassword}
                  onClick={() => void save()}>
            {busy ? 'Resetting…' : 'Reset password'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        {error && <ErrorNote error={error} />}
        <Field label="New password" required
               hint={`At least ${minPassword} characters. Give it to them in person and ask them to change it.`}>
          {(p) => <PasswordInput {...p} value={password} autoFocus autoComplete="new-password"
                                 onChange={(e) => setPassword(e.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}
