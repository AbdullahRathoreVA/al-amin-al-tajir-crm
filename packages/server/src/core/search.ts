/**
 * Universal search over the local FTS5 index. (spec 49 / 141)
 *
 * Keyword only, deliberately. Vector search is not here because at a daycare's
 * data volume it would add a dependency and an index to keep warm without
 * beating a well-built FTS5 query. Revisit when there is a measurement that
 * says otherwise, not before. (spec 7 / 61)
 */
import { one, many, run } from '../db/index.ts';
import { plainAll } from './util.ts';

export type Indexable =
  | 'family' | 'child' | 'guardian' | 'lead' | 'tour' | 'registration' | 'task' | 'note';

/**
 * `familyId` is the family this row belongs to, and it is a required argument
 * rather than an optional one on purpose: a child, guardian, note, lead or
 * tour indexed without it becomes a search result that cannot be opened, and
 * that failure is invisible until someone searches. Passing `null` is allowed
 * — a standalone task genuinely has no family — but it has to be written down.
 */
export function indexEntity(
  type: Indexable, id: string, title: string, body: string, familyId: string | null,
): void {
  run('DELETE FROM search_index WHERE entity_id = ?', id);
  run('INSERT INTO search_index (entity_type, entity_id, title, body, family_id) VALUES (?,?,?,?,?)',
    type, id, title, body, familyId);
}

/**
 * True when the index is empty but there is something to index — after the
 * FTS table was rebuilt by a migration, or after a partial write. Boot calls
 * this so a search box is never silently empty on a database full of families.
 */
export function searchIndexNeedsRebuild(): boolean {
  if ((one<{ n: number }>('SELECT COUNT(*) n FROM search_index')?.n ?? 0) > 0) return false;
  return (one<{ n: number }>('SELECT COUNT(*) n FROM families')?.n ?? 0) > 0;
}

export function unindexEntity(id: string): void {
  run('DELETE FROM search_index WHERE entity_id = ?', id);
}

/**
 * FTS5 MATCH takes an expression language, and raw user input is not one.
 * An unescaped quote or a bare `AND` throws. Each word becomes a quoted term
 * with a prefix wildcard, so typing "riv" finds "Rivera".
 */
function toMatchQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}@._-]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 8);
  if (!terms.length) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
}

export interface SearchHit {
  entity_type: Indexable;
  entity_id: string;
  title: string;
  snippet: string;
  rank: number;
  /** The family this result lives in, so the caller can open it. Null for
   *  things that genuinely belong to nobody, like a standalone task. */
  family_id: string | null;
}

export function search(query: string, limit = 25, types?: Indexable[]): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  const typeFilter = types?.length
    ? ` AND entity_type IN (${types.map(() => '?').join(',')})`
    : '';
  try {
    return plainAll(many<SearchHit>(
      `SELECT entity_type, entity_id, title, family_id,
              snippet(search_index, 3, '[', ']', '...', 12) AS snippet,
              bm25(search_index) AS rank
         FROM search_index
        WHERE search_index MATCH ?${typeFilter}
        ORDER BY rank
        LIMIT ?`,
      match, ...(types ?? []), limit,
    ));
  } catch {
    // A malformed MATCH must degrade to "no results", never to a 500 that makes
    // the search box look broken.
    return [];
  }
}

/**
 * Resolves a polymorphic (type, id) column pair to the family it belongs to.
 *
 * Both arguments are column names written in this file and never anything a
 * user supplied — SQL cannot parameterise an identifier, so they are
 * interpolated. Keep it that way: this is the one place in the codebase where
 * a string reaches a query unparameterised, and it is safe only because the
 * inputs are literals a few lines below.
 *
 * A type this does not know about resolves to NULL, which is the honest answer
 * rather than a wrong family.
 */
function relatedFamilySql(typeCol: string, idCol: string): string {
  return `CASE ${typeCol}
            WHEN 'family'       THEN ${idCol}
            WHEN 'child'        THEN (SELECT family_id FROM children      WHERE id = ${idCol})
            WHEN 'guardian'     THEN (SELECT family_id FROM guardians     WHERE id = ${idCol})
            WHEN 'lead'         THEN (SELECT family_id FROM leads         WHERE id = ${idCol})
            WHEN 'tour'         THEN (SELECT family_id FROM tours         WHERE id = ${idCol})
            WHEN 'registration' THEN (SELECT family_id FROM registrations WHERE id = ${idCol})
          END`;
}

/**
 * The runtime counterpart of `relatedFamilySql`, for the write paths that
 * index one row at a time. Same rules: an unknown type is null, not a guess.
 * The table name comes from a fixed map, never from the caller's string.
 */
const RELATED_TABLE: Record<string, string> = {
  child: 'children', guardian: 'guardians', lead: 'leads',
  tour: 'tours', registration: 'registrations',
};

export function familyForRelated(
  type: string | null | undefined, id: string | null | undefined,
): string | null {
  if (!type || !id) return null;
  if (type === 'family') return id;
  const table = RELATED_TABLE[type];
  if (!table) return null;
  return one<{ family_id: string }>(`SELECT family_id FROM ${table} WHERE id = ?`, id)?.family_id ?? null;
}

/** Rebuilds the whole index from the operational tables. Cheap at this scale,
 *  and the only honest way to recover from a partial write. */
export function reindexAll(): number {
  run('DELETE FROM search_index');
  let n = 0;

  for (const f of many<{ id: string; name: string; status: string; source: string }>(
    'SELECT id, name, status, source FROM families')) {
    const guardians = many<{ first_name: string; last_name: string | null; email: string | null; phone: string | null }>(
      'SELECT first_name, last_name, email, phone FROM guardians WHERE family_id = ?', f.id);
    const children = many<{ first_name: string; last_name: string | null }>(
      'SELECT first_name, last_name FROM children WHERE family_id = ?', f.id);
    const body = [
      f.status, f.source,
      ...guardians.flatMap((g) => [g.first_name, g.last_name, g.email, g.phone]),
      ...children.flatMap((c) => [c.first_name, c.last_name]),
    ].filter(Boolean).join(' ');
    // A family owns itself, so a family hit and a hit on one of its children
    // resolve the same way and the caller needs no special case.
    indexEntity('family', f.id, f.name, body, f.id); n++;
  }

  for (const c of many<{ id: string; family_id: string; first_name: string; last_name: string | null; age_band: string | null; status: string }>(
    'SELECT id, family_id, first_name, last_name, age_band, status FROM children')) {
    indexEntity('child', c.id, [c.first_name, c.last_name].filter(Boolean).join(' '),
      [c.age_band, c.status].filter(Boolean).join(' '), c.family_id); n++;
  }

  for (const g of many<{ id: string; family_id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; relationship: string | null }>(
    'SELECT id, family_id, first_name, last_name, email, phone, relationship FROM guardians')) {
    indexEntity('guardian', g.id, [g.first_name, g.last_name].filter(Boolean).join(' '),
      [g.email, g.phone, g.relationship].filter(Boolean).join(' '), g.family_id); n++;
  }

  for (const l of many<{ id: string; family_id: string; program_interest: string | null; source: string; family_name: string }>(
    `SELECT l.id, l.family_id, l.program_interest, l.source, f.name AS family_name
       FROM leads l JOIN families f ON f.id = l.family_id`)) {
    indexEntity('lead', l.id, `Lead: ${l.family_name}`,
      [l.program_interest, l.source].filter(Boolean).join(' '), l.family_id); n++;
  }

  for (const t of many<{ id: string; family_id: string; status: string; notes: string | null; family_name: string }>(
    `SELECT t.id, t.family_id, t.status, t.notes, f.name AS family_name
       FROM tours t JOIN families f ON f.id = t.family_id`)) {
    indexEntity('tour', t.id, `Tour: ${t.family_name}`,
      [t.status, t.notes].filter(Boolean).join(' '), t.family_id); n++;
  }

  for (const r of many<{ id: string; family_id: string; status: string; payload_json: string; family_name: string }>(
    `SELECT r.id, r.family_id, r.status, r.payload_json, f.name AS family_name
       FROM registrations r JOIN families f ON f.id = r.family_id`)) {
    indexEntity('registration', r.id, `Registration: ${r.family_name}`, r.status, r.family_id); n++;
  }

  // A task points at whatever it is about through related_type/related_id, so
  // "call the Rivera family back" can open the Riveras. One that is about
  // nothing in particular resolves to null, which is correct rather than a gap.
  for (const t of many<{ id: string; title: string; body: string | null; status: string; family_id: string | null }>(
    `SELECT id, title, body, status, ${relatedFamilySql('related_type', 'related_id')} AS family_id
       FROM tasks`)) {
    indexEntity('task', t.id, t.title, [t.body, t.status].filter(Boolean).join(' '), t.family_id); n++;
  }

  for (const nrow of many<{ id: string; body: string; entity_type: string; family_id: string | null }>(
    `SELECT id, body, entity_type, ${relatedFamilySql('entity_type', 'entity_id')} AS family_id
       FROM notes`)) {
    indexEntity('note', nrow.id, `Note on ${nrow.entity_type}`, nrow.body, nrow.family_id); n++;
  }

  return n;
}
