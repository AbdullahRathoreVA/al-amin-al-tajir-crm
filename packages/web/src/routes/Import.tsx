import { useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { Link } from '../lib/router.tsx';
import { Panel, Badge, Button, Spinner, ErrorNote } from '../ui/kit.tsx';

interface FieldDef { id: string; label: string }
interface ParseResult {
  headers: string[]; rowCount: number; truncated: boolean;
  mapping: Record<string, number>; fields: FieldDef[]; sampleRows: string[][];
}
interface Issue { row: number; field: string; message: string; severity: 'error' | 'warning' }
interface Preview {
  totalRows: number; willCreate: number; willUpdate: number; willSkip: number;
  issues: Issue[];
  sample: { row: number; guardian: string; child: string; email: string; action: string }[];
  truncated: boolean;
}
interface Result { batchId: string; created: number; updated: number; skipped: number; issues: Issue[] }

/**
 * Import in three steps, because a spreadsheet of real families is not
 * something to write on a single click: choose the file, check the columns,
 * then see exactly what will happen before it happens.
 */
export function Import() {
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setCsv(null); setFileName(''); setParsed(null); setMapping({});
    setPreview(null); setResult(null); setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(null); setPreview(null); setResult(null);
    try {
      const text = await file.text();
      setCsv(text); setFileName(file.name);
      const p = await api.post<ParseResult>('/import/parse', { csv: text });
      setParsed(p);
      setMapping(p.mapping);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file');
    } finally { setBusy(false); }
  }

  async function doPreview() {
    if (!csv) return;
    setBusy(true); setError(null);
    try { setPreview(await api.post<Preview>('/import/preview', { csv, mapping })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not check the file'); }
    finally { setBusy(false); }
  }

  async function doCommit() {
    if (!csv) return;
    setBusy(true); setError(null);
    try { setResult(await api.post<Result>('/import/commit', { csv, mapping, source: fileName })); }
    catch (err) { setError(err instanceof Error ? err.message : 'The import failed'); }
    finally { setBusy(false); }
  }

  async function doExport() {
    setBusy(true); setError(null);
    try {
      const r = await api.get<{ filename: string; csv: string; rows: number }>('/export/families');
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = r.filename; a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export');
    } finally { setBusy(false); }
  }

  const selectStyle = {
    borderColor: 'var(--line-strong)', background: 'var(--surface-sunken)', color: 'var(--text)',
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Import and export</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Bring an existing list of families in from a spreadsheet. Nothing is written until you have
          seen exactly what will happen.
        </p>
      </header>

      {error && <ErrorNote error={error} />}

      {/* ------------------------------------------------------- step 1 */}
      <Panel title="1. Choose a file">
        <input
          ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile}
          className="block w-full text-[13px] file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-lg file:border-0 file:px-4 file:text-sm file:font-medium"
          style={{ color: 'var(--text-muted)' }}
        />
        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          CSV. In Excel or Google Sheets: File &rarr; Download / Save As &rarr; CSV. Up to 5&nbsp;MB
          and 5,000 rows.
        </p>
        {fileName && (
          <p className="mt-2 text-[13px]">
            <strong>{fileName}</strong>
            {parsed && <> &mdash; {parsed.rowCount} {parsed.rowCount === 1 ? 'row' : 'rows'}, {parsed.headers.length} columns</>}
          </p>
        )}
        {parsed?.truncated && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--color-warn-400)' }}>
            Only the first 5,000 rows were read. Split the file and import it in parts.
          </p>
        )}
      </Panel>

      {/* ------------------------------------------------------- step 2 */}
      {parsed && (
        <Panel title="2. Check the columns">
          <p className="mb-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
            These were matched from your column names. Correct anything that is wrong.
          </p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            {parsed.fields.map((f) => (
              <label key={f.id} className="flex items-center gap-2">
                <span className="w-40 shrink-0 text-[12px]">{f.label}</span>
                <select
                  value={mapping[f.id] ?? ''}
                  onChange={(e) => {
                    const next = { ...mapping };
                    if (e.target.value === '') delete next[f.id];
                    else next[f.id] = Number(e.target.value);
                    setMapping(next); setPreview(null);
                  }}
                  className="min-h-9 flex-1 rounded-lg border px-2 text-[12px] outline-none"
                  style={selectStyle}
                >
                  <option value="">— not in this file —</option>
                  {parsed.headers.map((h, i) => <option key={h + i} value={i}>{h}</option>)}
                </select>
              </label>
            ))}
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[520px] text-[11px]">
              <thead>
                <tr style={{ color: 'var(--text-faint)' }}>
                  {parsed.headers.map((h, i) => <th key={h + i} className="px-2 py-1 text-left font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {parsed.sampleRows.map((r, i) => (
                  <tr key={i} className="border-t" style={{ borderColor: 'var(--line)' }}>
                    {parsed.headers.map((_, j) => (
                      <td key={j} className="max-w-[140px] truncate px-2 py-1" style={{ color: 'var(--text-muted)' }}>
                        {r[j] ?? ''}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4">
            <Button variant="primary" onClick={doPreview} disabled={busy}>
              {busy ? 'Checking…' : 'Check what will happen'}
            </Button>
          </div>
        </Panel>
      )}

      {/* ------------------------------------------------------- step 3 */}
      {preview && !result && (
        <Panel title="3. Confirm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['New families', preview.willCreate, 'ok'],
              ['Existing, updated', preview.willUpdate, 'info'],
              ['Skipped', preview.willSkip, preview.willSkip ? 'crit' : 'neutral'],
              ['Rows read', preview.totalRows, 'neutral'],
            ].map(([label, n, tone]) => (
              <div key={String(label)} className="rounded-lg px-3 py-2.5" style={{ background: 'var(--surface-sunken)' }}>
                <div className="tabular text-xl font-semibold"
                     style={{ color: tone === 'ok' ? 'var(--color-ok-400)'
                       : tone === 'crit' ? 'var(--color-crit-400)'
                       : tone === 'info' ? 'var(--color-teal-400)' : 'var(--text)' }}>
                  {String(n)}
                </div>
                <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>{String(label)}</div>
              </div>
            ))}
          </div>

          {preview.sample.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[520px] text-[12px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase" style={{ color: 'var(--text-faint)' }}>
                    <th className="px-2 py-1">Row</th><th className="px-2 py-1">Parent</th>
                    <th className="px-2 py-1">Child</th><th className="px-2 py-1">Contact</th>
                    <th className="px-2 py-1">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.sample.map((r) => (
                    <tr key={r.row} className="border-t" style={{ borderColor: 'var(--line)' }}>
                      <td className="tabular px-2 py-1.5" style={{ color: 'var(--text-faint)' }}>{r.row}</td>
                      <td className="px-2 py-1.5">{r.guardian}</td>
                      <td className="px-2 py-1.5">{r.child}</td>
                      <td className="max-w-[180px] truncate px-2 py-1.5" style={{ color: 'var(--text-muted)' }}>{r.email}</td>
                      <td className="px-2 py-1.5">
                        <Badge tone={r.action === 'create' ? 'ok' : r.action === 'update' ? 'info' : 'crit'}>
                          {r.action}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.issues.length > 0 && (
            <details className="mt-4" open={preview.issues.some((i) => i.severity === 'error')}>
              <summary className="cursor-pointer text-[13px] font-medium">
                {preview.issues.length} thing{preview.issues.length === 1 ? '' : 's'} to look at
              </summary>
              <ul className="mt-2 flex max-h-64 flex-col gap-1.5 overflow-y-auto">
                {preview.issues.map((i, k) => (
                  <li key={k} className="text-[12px]"
                      style={{ color: i.severity === 'error' ? 'var(--color-crit-400)' : 'var(--color-warn-400)' }}>
                    Row {i.row}: {i.message}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={doCommit} disabled={busy || preview.willCreate + preview.willUpdate === 0}>
              {busy ? 'Importing…' : `Import ${preview.willCreate + preview.willUpdate} families`}
            </Button>
            <Button variant="ghost" onClick={reset}>Cancel</Button>
          </div>
        </Panel>
      )}

      {result && (
        <Panel title="Imported">
          <p className="text-[13px]">
            <strong>{result.created}</strong> created, <strong>{result.updated}</strong> updated,{' '}
            <strong>{result.skipped}</strong> skipped.
          </p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
            Batch {result.batchId.slice(0, 8)}. Every record carries the file name and this batch id
            in its history, so this import can always be identified later.
          </p>
          <div className="mt-3 flex gap-2">
            <Link to="/families" className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-medium"
                  style={{ background: 'var(--accent)', color: 'var(--accent-text)' }}>
              See the families
            </Link>
            <Button variant="ghost" onClick={reset}>Import another file</Button>
          </div>
        </Panel>
      )}

      {/* ---------------------------------------------------------- export */}
      <Panel title="Export">
        <p className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
          Every family, guardian and child as a CSV.
        </p>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-faint)' }}>
          Exports are recorded in the access log. This file contains personal information about
          children &mdash; treat it accordingly, and delete it when you are done.
        </p>
        <div className="mt-3">
          <Button onClick={doExport} disabled={busy}>Download CSV</Button>
        </div>
      </Panel>

      {busy && !parsed && <Spinner label="Reading the file" />}
    </div>
  );
}
