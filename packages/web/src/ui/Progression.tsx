/**
 * Growing up: who has outgrown their room, and whose birthday is coming.
 *
 * The move button is the point of the whole panel, and so is the fact that a
 * person has to press it. Age groups correct themselves overnight because a
 * birthday is a fact; a room does not, because it depends on space, on ratios,
 * on the educator a child has settled with, and on their parents. So this shows
 * the suggestion, the reason, and how much room there is — and then waits.
 */
import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { Link } from '../lib/router.tsx';
import { Panel, Badge, Button, Empty, Spinner, ErrorNote, NotMeasured } from './kit.tsx';

interface Outgrown {
  childId: string; name: string; familyId: string; familyName: string;
  ageMonths: number; ageLabel: string;
  currentProgramId: string | null; currentProgram: string | null;
  suggestedProgramId: string | null; suggestedProgram: string | null;
  suggestedClassroomId: string | null; suggestedClassroom: string | null;
  suggestedSpace: number | null;
  reason: string;
}
interface Birthday {
  childId: string; name: string; familyId: string; familyName: string;
  date: string; turning: number; inDays: number;
}
interface Summary {
  outgrown: Outgrown[];
  birthdays: Birthday[];
  programsWithoutAges: { id: string; name: string }[];
}

export function Progression({ canMove, onMoved }: { canMove: boolean; onMoved?: () => void }) {
  const res = useApi<Summary>('/progression');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function move(row: Outgrown) {
    // A child is placed in a room, not in a program. The program follows the
    // room, which the server keeps in step.
    if (!row.suggestedClassroomId) return;
    setBusy(row.childId); setError(null);
    try {
      await api.patch(`/children/${row.childId}/placement`, { classroomId: row.suggestedClassroomId });
      res.reload();
      onMoved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move that child.');
    } finally {
      setBusy(null);
    }
  }

  const d = res.data;

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Ready to move up">
        {res.loading && !d && <Spinner label="Checking ages" />}
        {res.error && <ErrorNote error={res.error} retry={res.reload} />}
        {error && <ErrorNote error={error} retry={() => setError(null)} />}

        {d && d.outgrown.length === 0 && (
          <Empty
            title="Every child is in a room that fits their age"
            hint="Age groups are worked out from each child's birthday and rechecked daily."
          />
        )}

        {d && d.outgrown.length > 0 && (
          <>
            <p className="mb-3 text-[13px]" style={{ color: 'var(--text-muted)' }}>
              Nothing has been changed. Moving a child depends on space, ratios and their
              parents, so the decision stays with you.
            </p>
            <ul className="flex flex-col gap-2">
              {d.outgrown.map((row) => (
                <li key={row.childId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
                    style={{ borderColor: 'var(--line-strong)' }}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {row.name}{' '}
                      <Link to={`/families/${row.familyId}`}
                            className="text-[12px] font-normal underline"
                            style={{ color: 'var(--text-muted)' }}>
                        {row.familyName}
                      </Link>
                    </p>
                    <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                      {row.reason}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px]">
                      <Badge tone="warn">{row.currentProgram ?? 'no room'}</Badge>
                      <span aria-hidden style={{ color: 'var(--text-faint)' }}>&rarr;</span>
                      {row.suggestedProgram
                        ? <Badge tone="ok">{row.suggestedProgram}</Badge>
                        : <Badge tone="crit">no room covers this age</Badge>}
                      {row.suggestedClassroom && (
                        <span style={{ color: 'var(--text-faint)' }}>
                          &middot; {row.suggestedClassroom} &middot;{' '}
                          {row.suggestedSpace === null
                            ? <NotMeasured why="No capacity has been set for that room" />
                            : <>{row.suggestedSpace} place{row.suggestedSpace === 1 ? '' : 's'} free</>}
                        </span>
                      )}
                    </p>
                  </div>

                  {row.suggestedClassroomId && canMove && (
                    <Button
                      size="sm"
                      variant={row.suggestedSpace === 0 ? 'default' : 'primary'}
                      disabled={busy === row.childId}
                      onClick={() => void move(row)}
                    >
                      {busy === row.childId
                        ? 'Moving…'
                        : row.suggestedSpace === 0
                          ? `Move anyway (${row.suggestedClassroom} is full)`
                          : `Move to ${row.suggestedClassroom}`}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {/* A room with no age range cannot be reasoned about, and saying so is
            more useful than quietly leaving its children out of the list. */}
        {d && d.programsWithoutAges.length > 0 && (
          <p className="mt-3 rounded-lg px-3 py-2 text-[12px]"
             style={{ background: 'color-mix(in oklab, var(--color-warn-400) 14%, transparent)',
                      color: 'var(--color-warn-600)' }}>
            No age range is set for {d.programsWithoutAges.map((p) => p.name).join(', ')}, so
            children in {d.programsWithoutAges.length === 1 ? 'it' : 'them'} are not checked here.
          </p>
        )}
      </Panel>

      <Panel title="Birthdays in the next two weeks">
        {d && d.birthdays.length === 0 && (
          <Empty title="No birthdays coming up"
                 hint="Only children with a date of birth recorded can appear here." />
        )}
        {d && d.birthdays.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {d.birthdays.map((b) => (
              <li key={b.childId} className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <span>
                  <strong>{b.name}</strong>{' '}
                  <Link to={`/families/${b.familyId}`} className="text-[12px] underline"
                        style={{ color: 'var(--text-muted)' }}>{b.familyName}</Link>
                </span>
                <span style={{ color: 'var(--text-muted)' }}>
                  turning {b.turning} &middot;{' '}
                  {b.inDays === 0 ? 'today' : b.inDays === 1 ? 'tomorrow' : `in ${b.inDays} days`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
