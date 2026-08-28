/**
 * Universal search over the local FTS5 index. (spec 49 / 141)
 *
 * Keyword only, deliberately. Vector search is not here because at a daycare's
 * data volume it would add a dependency and an index to keep warm without
 * beating a well-built FTS5 query. Revisit when there is a measurement that
 * says otherwise, not before. (spec 7 / 61)
 */
import { many, run } from '../db/index.ts';
import { plainAll } from './util.ts';

export type Indexable =
  | 'family' | 'child' | 'guardian' | 'lead' | 'tour' | 'registration' | 'task' | 'note';

export function indexEntity(type: Indexable, id: string, title: string, body: string): void {
  run('DELETE FROM search_index WHERE entity_id = ?', id);
  run('INSERT INTO search_index (entity_type, entity_id, title, body) VALUES (?,?,?,?)',
    type, id, title, body);
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
}

export function search(query: string, limit = 25, types?: Indexable[]): SearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];
  const typeFilter = types?.length
    ? ` AND entity_type IN (${types.map(() => '?').join(',')})`
    : '';
  try {
    return plainAll(many<SearchHit>(
      `SELECT entity_type, entity_id, title,
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
    indexEntity('family', f.id, f.name, body); n++;
  }

  for (const c of many<{ id: string; first_name: string; last_name: string | null; age_band: string | null; status: string }>(
    'SELECT id, first_name, last_name, age_band, status FROM children')) {
    indexEntity('child', c.id, [c.first_name, c.last_name].filter(Boolean).join(' '),
      [c.age_band, c.status].filter(Boolean).join(' ')); n++;
  }

  for (const g of many<{ id: string; first_name: string; last_name: string | null; email: string | null; phone: string | null; relationship: string | null }>(
    'SELECT id, first_name, last_name, email, phone, relationship FROM guardians')) {
    indexEntity('guardian', g.id, [g.first_name, g.last_name].filter(Boolean).join(' '),
      [g.email, g.phone, g.relationship].filter(Boolean).join(' ')); n++;
  }

  for (const l of many<{ id: string; program_interest: string | null; source: string; family_name: string }>(
    `SELECT l.id, l.program_interest, l.source, f.name AS family_name
       FROM leads l JOIN families f ON f.id = l.family_id`)) {
    indexEntity('lead', l.id, `Lead: ${l.family_name}`,
      [l.program_interest, l.source].filter(Boolean).join(' ')); n++;
  }

  for (const t of many<{ id: string; status: string; notes: string | null; family_name: string }>(
    `SELECT t.id, t.status, t.notes, f.name AS family_name
       FROM tours t JOIN families f ON f.id = t.family_id`)) {
    indexEntity('tour', t.id, `Tour: ${t.family_name}`,
      [t.status, t.notes].filter(Boolean).join(' ')); n++;
  }

  for (const r of many<{ id: string; status: string; payload_json: string; family_name: string }>(
    `SELECT r.id, r.status, r.payload_json, f.name AS family_name
       FROM registrations r JOIN families f ON f.id = r.family_id`)) {
    indexEntity('registration', r.id, `Registration: ${r.family_name}`, r.status); n++;
  }

  for (const t of many<{ id: string; title: string; body: string | null; status: string }>(
    'SELECT id, title, body, status FROM tasks')) {
    indexEntity('task', t.id, t.title, [t.body, t.status].filter(Boolean).join(' ')); n++;
  }

  for (const nrow of many<{ id: string; body: string; entity_type: string }>(
    'SELECT id, body, entity_type FROM notes')) {
    indexEntity('note', nrow.id, `Note on ${nrow.entity_type}`, nrow.body); n++;
  }

  return n;
}
