/**
 * The user guide, inside the app.
 *
 * This is the only support channel the person running the daycare has, so it
 * has to work for somebody who has never used a CRM: a question box that
 * answers in plain words, and a browsable guide underneath for when they would
 * rather read.
 *
 * The content is not in this file. It is served from the server so that the
 * words on this screen and the words the AI answers from are the same words —
 * two copies would drift, and the AI would end up describing a CRM that no
 * longer exists.
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Panel, Badge, Button, Spinner, ErrorNote, TextInput } from '../ui/kit.tsx';

interface Topic {
  id: string; section: string; title: string; summary: string;
  body: string[]; steps?: string[]; notes?: string[]; who?: string;
  related?: string[]; keywords?: string[];
}
interface Guide { sections: string[]; topics: Topic[] }

interface Answer {
  question: string;
  answer: string | null;
  answeredBy: 'ai' | 'search' | 'none';
  note: string;
  topics: { id: string; title: string; summary: string; section: string }[];
}

export function Help() {
  const guide = useApi<Guide>('/help');
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const topics = guide.data?.topics ?? [];
  const bySection = useMemo(() => {
    const map = new Map<string, Topic[]>();
    for (const t of topics) {
      const list = map.get(t.section) ?? [];
      list.push(t);
      map.set(t.section, list);
    }
    return map;
  }, [topics]);

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!question.trim()) return;
    setAsking(true); setError(null);
    try {
      setAnswer(await api.post<Answer>('/help/ask', { question }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not look that up');
    } finally { setAsking(false); }
  }

  const show = (id: string) => { setOpen(id); setAnswer(null); };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Help</h1>
        <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-muted)' }}>
          How everything here works, in plain words. Ask a question, or read through below.
        </p>
      </header>

      {/* ------------------------------------------------------------- ask */}
      <Panel title="Ask a question">
        <form onSubmit={ask} className="flex flex-wrap gap-2">
          <TextInput
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How do I add a child? What can an educator see?"
            aria-label="Ask a question about using the CRM"
            className="min-w-0 flex-1"
          />
          <Button type="submit" variant="primary" disabled={asking || !question.trim()}>
            {asking ? 'Looking…' : 'Ask'}
          </Button>
        </form>

        {error && <div className="mt-3"><ErrorNote error={error} /></div>}

        {answer && (
          <div className="mt-4 flex flex-col gap-3">
            {answer.answer && (
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--line-strong)' }}>
                <p className="text-[14px] leading-relaxed">{answer.answer}</p>
              </div>
            )}

            {/* Always say where the answer came from. An AI answer and a list of
                matching topics are different things and should never look alike. */}
            <p className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: 'var(--text-faint)' }}>
              <Badge tone={answer.answeredBy === 'ai' ? 'info' : 'neutral'}>
                {answer.answeredBy === 'ai' ? 'written by AI, from this guide only'
                  : answer.answeredBy === 'search' ? 'from the guide'
                  : 'no match'}
              </Badge>
              {answer.note}
            </p>

            {answer.topics.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {answer.topics.map((t) => (
                  <li key={t.id}>
                    <button type="button" onClick={() => show(t.id)}
                            className="text-left text-[13px] font-medium underline">
                      {t.title}
                    </button>
                    <span className="ml-2 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {t.summary}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Panel>

      {guide.loading && !guide.data && <Spinner label="Loading the guide" />}
      {guide.error && <ErrorNote error={guide.error} retry={guide.reload} />}

      {/* ---------------------------------------------------------- guide */}
      {(guide.data?.sections ?? []).map((section) => (
        <Panel key={section} title={section}>
          <ul className="flex flex-col divide-y" style={{ borderColor: 'var(--line)' }}>
            {(bySection.get(section) ?? []).map((t) => {
              const isOpen = open === t.id;
              return (
                <li key={t.id} className="py-2 first:pt-0 last:pb-0"
                    style={{ borderColor: 'var(--line)' }}>
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : t.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-2 py-1 text-left"
                  >
                    <span aria-hidden className="mt-0.5 w-3 shrink-0 text-[11px]"
                          style={{ color: 'var(--text-faint)' }}>{isOpen ? '▾' : '▸'}</span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">{t.title}</span>
                      <span className="block text-[12px]" style={{ color: 'var(--text-muted)' }}>
                        {t.summary}
                      </span>
                    </span>
                  </button>

                  {isOpen && (
                    <div className="mt-1 flex flex-col gap-3 pl-5 pr-1 pb-2">
                      {t.body.map((p, i) => (
                        <p key={i} className="text-[13px] leading-relaxed">{p}</p>
                      ))}

                      {t.steps && (
                        <ol className="flex list-decimal flex-col gap-1 pl-5 text-[13px]">
                          {t.steps.map((s, i) => <li key={i}>{s}</li>)}
                        </ol>
                      )}

                      {t.notes && (
                        <ul className="flex flex-col gap-1.5">
                          {t.notes.map((n, i) => (
                            <li key={i} className="rounded-lg px-3 py-2 text-[12px]"
                                style={{ background: 'var(--surface-inset)', color: 'var(--text-muted)' }}>
                              {n}
                            </li>
                          ))}
                        </ul>
                      )}

                      {t.who && (
                        <p className="text-[12px]" style={{ color: 'var(--text-faint)' }}>
                          <strong style={{ color: 'var(--text-muted)' }}>Who can do this:</strong> {t.who}
                        </p>
                      )}

                      {t.related && t.related.length > 0 && (
                        <p className="flex flex-wrap items-center gap-2 text-[12px]">
                          <span style={{ color: 'var(--text-faint)' }}>See also</span>
                          {t.related.map((id) => {
                            const r = topics.find((x) => x.id === id);
                            return r ? (
                              <button key={id} type="button" onClick={() => show(id)}
                                      className="underline" style={{ color: 'var(--text-muted)' }}>
                                {r.title}
                              </button>
                            ) : null;
                          })}
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Panel>
      ))}
    </div>
  );
}
