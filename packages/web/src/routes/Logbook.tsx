/**
 * The logbook. Say what you did; it writes it down and asks about the rest.
 *
 * Speech is the browser's own — SpeechRecognition to listen, speechSynthesis to
 * answer. No API key, no per-minute charge, nothing leaves the machine to a
 * transcription service. It also means it is not available everywhere, so the
 * microphone is only rendered where it actually works: a button that silently
 * does nothing is worse than no button.
 *
 * The questions come from the server, which computes them by rule. This screen
 * never decides an entry is complete — it asks what it is told to ask.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import {
  Panel, Button, Badge, Stat, Spinner, ErrorNote, Empty, NotMeasured,
} from '../ui/kit.tsx';

// ------------------------------------------------------------- speech typing

/** The Web Speech API is not in lib.dom for every TS version; keep it narrow. */
interface SpeechResultEvent { results: ArrayLike<ArrayLike<{ transcript: string }>> }
interface Recogniser {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void;
  onresult: ((e: SpeechResultEvent) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type RecogniserCtor = new () => Recogniser;

function recogniserCtor(): RecogniserCtor | null {
  const w = window as unknown as Record<string, RecogniserCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const canSpeak = () => typeof window !== 'undefined' && 'speechSynthesis' in window;

function say(text: string) {
  if (!canSpeak()) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02;
    window.speechSynthesis.speak(u);
  } catch {
    // A browser that refuses to speak is not a reason to lose the entry.
  }
}

// ---------------------------------------------------------------------- types

type LogKind = 'purchase' | 'supply' | 'task' | 'note';

interface Draft {
  kind: LogKind;
  happenedOn?: string;
  summary?: string;
  vendor?: string;
  amountCents?: number | null;
  category?: string;
  classroomId?: string | null;
  rawText: string;
  source?: 'typed' | 'voice';
}
interface Gap { field: string; question: string }
interface Entry {
  id: string; kind: string; happened_on: string; summary: string;
  vendor: string | null; amount_cents: number | null; category: string | null;
  classroom_name: string | null; raw_text: string; created_by_name: string | null;
  source: string;
}
interface Totals { measured: boolean; entries: number; spentCents: number | null; purchases: number }

const money = (cents: number | null | undefined) =>
  cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`;

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const KIND_TONE: Record<string, 'ok' | 'info' | 'warn' | 'neutral'> = {
  purchase: 'info', supply: 'warn', task: 'ok', note: 'neutral',
};

// ----------------------------------------------------------------- component

export function Logbook() {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spoken, setSpoken] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);

  const res = useApi<{ entries: Entry[]; totals: Totals }>('/logbook');
  const recognition = useRef<Recogniser | null>(null);
  const answerRef = useRef<HTMLInputElement>(null);
  const speechSupported = typeof window !== 'undefined' && recogniserCtor() !== null;

  const gap = gaps[0] ?? null;

  // Read the next question aloud, but only when the entry arrived by voice —
  // somebody typing at a desk does not want the computer talking at them.
  useEffect(() => {
    if (gap && spoken && voiceOn) say(gap.question);
    if (gap) answerRef.current?.focus();
  }, [gap, spoken, voiceOn]);

  const listen = useCallback(() => {
    const Ctor = recogniserCtor();
    if (!Ctor) return;
    try {
      const r = new Ctor();
      recognition.current = r;
      r.lang = 'en-CA';
      r.interimResults = false;
      r.continuous = false;
      r.onresult = (e) => {
        const said = Array.from(e.results)
          .map((alt) => alt[0]?.transcript ?? '').join(' ').trim();
        if (!said) return;
        if (gap) { setAnswer(said); }
        else { setText(said); setSpoken(true); void parse(said, true); }
      };
      r.onerror = (e) => {
        setListening(false);
        setError(e.error === 'not-allowed'
          ? 'The microphone is blocked. Allow it for this site and try again.'
          : 'I did not catch that.');
      };
      r.onend = () => setListening(false);
      setError(null);
      setListening(true);
      r.start();
    } catch {
      setListening(false);
      setError('The microphone could not start.');
    }
  }, [gap]);

  async function parse(sentence: string, byVoice = false) {
    const said = sentence.trim();
    if (!said) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ draft: Draft; gaps: Gap[] }>('/logbook/parse', {
        text: said,
        // The browser knows the local date; the server only knows UTC, and
        // "yesterday" at 6pm in Alberta is a different day in UTC.
        today: localToday(),
      });
      setDraft({ ...r.draft, source: byVoice ? 'voice' : 'typed' });
      setGaps(r.gaps);
      if (!r.gaps.length && byVoice && voiceOn) say('Got it. Saving that now.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'I could not read that.');
    } finally { setBusy(false); }
  }

  /** Applies one answer to the draft and re-asks the server what is still missing. */
  function answerGap() {
    if (!gap || !draft) return;
    const value = answer.trim();
    if (!value) return;

    const next: Draft = { ...draft };
    if (gap.field === 'summary') next.summary = value;
    else if (gap.field === 'vendor') next.vendor = value;
    else if (gap.field === 'category') next.category = value;
    else if (gap.field === 'happenedOn') {
      next.happenedOn = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
      if (!next.happenedOn) { setError('Give me a date like 2026-08-29.'); return; }
    } else if (gap.field === 'amountCents') {
      const cents = Math.round(Number(value.replace(/[^0-9.]/g, '')) * 100);
      if (!Number.isFinite(cents) || cents < 0) { setError('Give me an amount like 84.32.'); return; }
      next.amountCents = cents;
    }

    setDraft(next);
    setGaps(gaps.slice(1));
    setAnswer('');
    setError(null);
  }

  async function save() {
    if (!draft || gaps.length) return;
    setBusy(true); setError(null);
    try {
      await api.post('/logbook', draft);
      if (spoken && voiceOn) say('Written down.');
      setText(''); setDraft(null); setGaps([]); setSpoken(false);
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not save.');
    } finally { setBusy(false); }
  }

  async function download() {
    setBusy(true); setError(null);
    try {
      const r = await api.get<{ filename: string; base64: string; contentType: string }>(
        '/logbook/workbook');
      const bytes = Uint8Array.from(atob(r.base64), (ch) => ch.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.contentType }));
      const a = document.createElement('a');
      a.href = url; a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The spreadsheet could not be built.');
    } finally { setBusy(false); }
  }

  const [editing, setEditing] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; summary: string } | null>(null);
  const [binOpen, setBinOpen] = useState(false);
  const bin = useApi<{ removed: Entry[] }>(binOpen ? '/logbook/removed' : null, [binOpen]);

  async function act(path: string, body?: unknown) {
    setBusy(true); setError(null);
    try {
      await api.post(path, body ?? {});
      res.reload();
      if (binOpen) bin.reload();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work.');
      return false;
    } finally { setBusy(false); }
  }

  async function saveEdit(id: string, patch: Record<string, unknown>) {
    setBusy(true); setError(null);
    try {
      await api.patch(`/logbook/${id}`, patch);
      setEditing(null);
      res.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That edit did not save.');
    } finally { setBusy(false); }
  }

  async function removeEntry(e: Entry) {
    // Offer the undo immediately. It is what people want about four seconds
    // after pressing remove, and a confirm dialog beforehand does not help
    // because nobody reads it.
    if (await act(`/logbook/${e.id}/remove`)) setUndo({ id: e.id, summary: e.summary });
  }

  const entries = res.data?.entries ?? [];
  const totals = res.data?.totals;
  const field = 'w-full rounded-lg border px-3 py-2.5 text-sm outline-none';
  const fieldStyle = {
    borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)',
  };

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Logbook</h1>
          <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            Say what you bought or did. It gets written down, and it comes back as a spreadsheet.
          </p>
        </div>
        <div className="flex gap-1.5">
          {canSpeak() && (
            <Button size="sm" variant="ghost" onClick={() => setVoiceOn((v) => !v)}
                    aria-pressed={voiceOn}>
              {voiceOn ? 'Voice replies on' : 'Voice replies off'}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy || !entries.length} onClick={() => void download()}>
            Download spreadsheet
          </Button>
        </div>
      </header>

      {error && <ErrorNote error={error} retry={() => setError(null)} />}

      {/* ------------------------------------------------------------ input */}
      <Panel>
        {!draft ? (
          <div className="flex flex-col gap-2.5">
            <label htmlFor="log-input" className="text-[13px] font-medium">
              What happened?
            </label>
            <textarea
              id="log-input" rows={2} value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void parse(text); }
              }}
              placeholder="I bought $84.32 of milk and fruit from Costco yesterday"
              className={field} style={{ ...fieldStyle, resize: 'vertical' }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void parse(text)}>
                {busy ? 'Reading…' : 'Write it down'}
              </Button>
              {/* Only rendered where it actually works. */}
              {speechSupported && (
                <Button variant={listening ? 'primary' : 'ghost'} disabled={busy}
                        onClick={listen} aria-pressed={listening}>
                  {listening ? 'Listening…' : 'Speak instead'}
                </Button>
              )}
              {!speechSupported && (
                <span className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                  Speaking to it needs Chrome or Edge. Typing works everywhere.
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={KIND_TONE[draft.kind] ?? 'neutral'}>{draft.kind}</Badge>
              <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                “{draft.rawText}”
              </span>
            </div>

            <dl className="grid gap-x-5 gap-y-1.5 text-[13px] sm:grid-cols-2">
              <Understood label="What" value={draft.summary} />
              <Understood label="Day" value={draft.happenedOn} />
              <Understood label="Amount" value={draft.amountCents != null ? money(draft.amountCents) : undefined} />
              <Understood label="Where" value={draft.vendor} />
              <Understood label="Category" value={draft.category} />
            </dl>

            {gap ? (
              <div className="rounded-lg border px-3.5 py-3" style={{ borderColor: 'var(--line-strong)' }}>
                <label htmlFor="log-answer" className="block text-[13px] font-medium">
                  {gap.question}
                </label>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    id="log-answer" ref={answerRef} value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); answerGap(); } }}
                    className={`${field} flex-1 sm:max-w-xs`} style={fieldStyle}
                  />
                  <Button variant="primary" onClick={answerGap} disabled={!answer.trim()}>Answer</Button>
                  {speechSupported && (
                    <Button variant={listening ? 'primary' : 'ghost'} onClick={listen}>
                      {listening ? 'Listening…' : 'Say it'}
                    </Button>
                  )}
                </div>
                {gaps.length > 1 && (
                  <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
                    {gaps.length - 1} more to go.
                  </p>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" disabled={busy} onClick={() => void save()}>
                  {busy ? 'Saving…' : 'Save it'}
                </Button>
                <Button variant="ghost" onClick={() => { setDraft(null); setGaps([]); setSpoken(false); }}>
                  Start again
                </Button>
              </div>
            )}
          </div>
        )}
      </Panel>

      {/* ----------------------------------------------------------- totals */}
      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Entries" value={totals.entries} />
          <Stat label="Purchases" value={totals.purchases} />
          <Stat
            label="Spent"
            value={totals.measured && totals.spentCents !== null
              ? money(totals.spentCents)
              : <NotMeasured why="Nothing has been written down yet, which is not the same as having spent nothing." />}
          />
        </div>
      )}

      {/* ---------------------------------------------------------- entries */}
      {undo && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-2.5"
             style={{ borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)' }}>
          <span className="flex-1 text-[13px]">
            Removed “{undo.summary}”. It is out of the totals and the spreadsheet.
          </span>
          <Button size="sm" variant="ghost" disabled={busy}
                  onClick={async () => { if (await act(`/logbook/${undo.id}/restore`)) setUndo(null); }}>
            Put it back
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setUndo(null)}>Dismiss</Button>
        </div>
      )}

      <Panel title="Written down" pad={false}>
        {res.loading && !res.data && <Spinner label="Loading the logbook" />}
        {res.error && <ErrorNote error={res.error} retry={res.reload} />}
        {res.data && !entries.length && (
          <Empty title="Nothing written down yet"
                 hint="Tell it what you bought or did and it will start keeping track." />
        )}
        <div className="flex flex-col divide-y" style={{ borderColor: 'var(--line)' }}>
          {entries.map((e) => (
            <EntryRow
              key={e.id} entry={e} busy={busy}
              editing={editing === e.id}
              onEdit={() => setEditing(e.id)}
              onCancel={() => setEditing(null)}
              onSave={(patch) => void saveEdit(e.id, patch)}
              onRemove={() => void removeEntry(e)}
            />
          ))}
        </div>
      </Panel>

      {/* -------------------------------------------------------------- bin */}
      <Panel pad={false}>
        <button
          onClick={() => setBinOpen((o) => !o)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-[13px] font-medium"
          aria-expanded={binOpen}
        >
          <span>Removed entries</span>
          <span style={{ color: 'var(--text-faint)' }}>{binOpen ? 'Hide' : 'Show'}</span>
        </button>
        {binOpen && (
          <div className="border-t" style={{ borderColor: 'var(--line)' }}>
            {bin.loading && <Spinner label="Looking in the bin" />}
            {bin.error && <ErrorNote error={bin.error} retry={bin.reload} />}
            {bin.data && !bin.data.removed.length && (
              <p className="px-4 py-5 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
                Nothing has been removed.
              </p>
            )}
            {bin.data?.removed.map((e) => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-4 py-2.5 last:border-b-0"
                   style={{ borderColor: 'var(--line)' }}>
                <span className="tabular text-[12px]" style={{ color: 'var(--text-faint)' }}>{e.happened_on}</span>
                <span className="min-w-0 flex-1 text-[13px]" style={{ color: 'var(--text-muted)' }}>{e.summary}</span>
                <span className="tabular text-[12px]" style={{ color: 'var(--text-faint)' }}>{money(e.amount_cents)}</span>
                <Button size="sm" variant="ghost" disabled={busy}
                        onClick={() => void act(`/logbook/${e.id}/restore`)}>Put back</Button>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/** One parsed field. Blank reads as "still to come", never as an empty claim. */
function Understood({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2">
      <dt className="min-w-16 font-medium" style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className={value ? '' : 'italic'} style={{ color: value ? 'var(--text)' : 'var(--text-faint)' }}>
        {value || 'still to come'}
      </dd>
    </div>
  );
}

/**
 * One line of the book, which becomes a small form when you edit it.
 *
 * Editing in place rather than in a dialog: a correction is usually one field
 * and the row you are fixing is the context you need to fix it.
 */
function EntryRow(
  { entry, busy, editing, onEdit, onCancel, onSave, onRemove }: {
    entry: Entry;
    busy: boolean;
    editing: boolean;
    onEdit: () => void;
    onCancel: () => void;
    onSave: (patch: Record<string, unknown>) => void;
    onRemove: () => void;
  },
) {
  const [summary, setSummary] = useState(entry.summary);
  const [vendor, setVendor] = useState(entry.vendor ?? '');
  const [category, setCategory] = useState(entry.category ?? '');
  const [day, setDay] = useState(entry.happened_on);
  const [amount, setAmount] = useState(
    entry.amount_cents === null ? '' : (entry.amount_cents / 100).toFixed(2));
  const [localError, setLocalError] = useState<string | null>(null);

  const field = 'rounded-lg border px-2.5 py-1.5 text-[13px] outline-none';
  const fieldStyle = {
    borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)',
  };

  function submit() {
    if (!summary.trim()) { setLocalError('It needs a description.'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { setLocalError('The date must look like 2026-08-29.'); return; }

    let cents: number | null = null;
    if (amount.trim()) {
      // Parsed here as well as on the server, so a typo is caught in front of
      // the person who made it rather than after a round trip.
      const n = Number(amount.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(n) || n < 0) { setLocalError('Give an amount like 84.32.'); return; }
      cents = Math.round(n * 100);
    }
    setLocalError(null);
    onSave({
      summary: summary.trim(),
      vendor: vendor.trim() || null,
      category: category.trim() || null,
      happenedOn: day,
      amountCents: cents,
    });
  }

  if (!editing) {
    return (
      <div className="group flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
        <span className="tabular text-[12px]" style={{ color: 'var(--text-faint)' }}>
          {entry.happened_on}
        </span>
        <Badge tone={KIND_TONE[entry.kind] ?? 'neutral'}>{entry.kind}</Badge>
        <span className="min-w-0 flex-1 text-[13px] font-medium">{entry.summary}</span>
        {entry.vendor && (
          <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{entry.vendor}</span>
        )}
        {entry.category && (
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }}>{entry.category}</span>
        )}
        {entry.source === 'voice' && (
          <span className="text-[11px]" style={{ color: 'var(--text-faint)' }} title="Recorded by voice">spoken</span>
        )}
        <span className="tabular text-[13px] font-semibold">{money(entry.amount_cents)}</span>
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>Remove</Button>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3" style={{ background: 'var(--surface-sunken)' }}>
      <div className="flex flex-wrap gap-2">
        <input aria-label="Day" value={day} onChange={(e) => setDay(e.target.value)}
               className={`${field} w-32`} style={fieldStyle} />
        <input aria-label="What" value={summary} onChange={(e) => setSummary(e.target.value)}
               className={`${field} min-w-48 flex-1`} style={fieldStyle} autoFocus />
        <input aria-label="Where" value={vendor} onChange={(e) => setVendor(e.target.value)}
               placeholder="Where" className={`${field} w-36`} style={fieldStyle} />
        <input aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}
               placeholder="Category" className={`${field} w-36`} style={fieldStyle} />
        <input aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)}
               placeholder="0.00" inputMode="decimal" className={`${field} w-24 text-right`} style={fieldStyle} />
      </div>

      {/* What was actually said, so a wrong parse can be corrected from it. */}
      <p className="text-[11px]" style={{ color: 'var(--text-faint)' }}>
        You said: “{entry.raw_text}”
      </p>

      {localError && (
        <p className="text-[12px]" style={{ color: 'var(--color-crit-400)' }}>{localError}</p>
      )}

      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={submit} disabled={busy}>Save changes</Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
