/**
 * The AI layer.
 *
 * Four rules, and they are the whole design:
 *
 *   1. The CRM works completely with AI switched off. Not degraded: off. Every
 *      caller here has a deterministic fallback, and the fallback is what ships
 *      by default.
 *   2. AI reads a permission-filtered view. The filter runs BEFORE anything
 *      leaves the process, so an educator cannot obtain a date of birth by
 *      asking nicely. (spec 27)
 *   3. Nothing is sent to a parent. AI can draft; a person sends.
 *   4. Facts and inferences are separated in the output, and every fact names
 *      the record it came from.
 *
 * Providers are adapters. Ollama runs locally and is the default when present;
 * a cloud key is explicit opt-in and never assumed.
 */
import { one, many } from '../db/index.ts';
import { config } from './config.ts';
import { nowIso } from './util.ts';
import type { User } from './auth.ts';
import { can } from './auth.ts';

// ------------------------------------------------------------- providers

export interface AiProvider {
  name: string;
  /** Returns null rather than throwing, so a caller always has a fallback. */
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string | null>;
  available(): Promise<boolean>;
}

const TIMEOUT_MS = 20_000;

/** Local, private, free. Nothing leaves the machine. */
function ollama(url: string, model: string): AiProvider {
  return {
    name: `ollama:${model}`,
    async available() {
      try {
        const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
        return r.ok;
      } catch { return false; }
    },
    async complete(prompt, opts) {
      try {
        const r = await fetch(`${url}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model, prompt, stream: false,
            options: { temperature: 0.2, num_predict: opts?.maxTokens ?? 400 },
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { response?: string };
        return j.response?.trim() ?? null;
      } catch { return null; }
    },
  };
}

function anthropic(key: string, model: string): AiProvider {
  return {
    name: `anthropic:${model}`,
    async available() { return Boolean(key); },
    async complete(prompt, opts) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model, max_tokens: opts?.maxTokens ?? 600,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { content?: { text?: string }[] };
        return j.content?.[0]?.text?.trim() ?? null;
      } catch { return null; }
    },
  };
}

export function provider(): AiProvider | null {
  const kind = process.env.CRM_AI_PROVIDER?.trim();
  if (!kind) return null;
  if (kind === 'ollama') {
    return ollama(
      process.env.CRM_OLLAMA_URL?.trim() || 'http://127.0.0.1:11434',
      process.env.CRM_OLLAMA_MODEL?.trim() || 'llama3.2',
    );
  }
  if (kind === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) return null;
    return anthropic(key, process.env.CRM_AI_MODEL?.trim() || 'claude-sonnet-5');
  }
  return null;
}

export async function aiStatus() {
  const p = provider();
  if (!p) {
    return {
      configured: false, name: null as string | null, reachable: false,
      // Said plainly, because a greyed-out AI panel that implies it is thinking
      // is worse than one that admits it is off.
      detail: 'No AI provider configured. Everything in the CRM works without one.',
      cloud: false,
    };
  }
  const reachable = await p.available();
  return {
    configured: true,
    name: p.name,
    reachable,
    detail: reachable
      ? `Answering via ${p.name}`
      : `${p.name} is configured but not responding. The CRM is using its built-in summaries.`,
    cloud: p.name.startsWith('anthropic'),
  };
}

// ------------------------------------------------------- permission filter

export interface FamilyFacts {
  familyId: string;
  name: string;
  status: string;
  source: string;
  createdAt: string;
  guardians: { name: string; relationship: string | null; hasEmail: boolean; hasPhone: boolean }[];
  children: { firstName: string; ageBand: string | null; dateOfBirth?: string; status: string }[];
  tours: { status: string; scheduledFor: string | null }[];
  registrations: { status: string; steps: string }[];
  openTasks: { title: string; dueAt: string | null }[];
  nextAction: { text: string; dueAt: string | null; reason: string | null } | null;
  lastContactAt: string | null;
  noteCount: number;
  /** Set when the family is marked local-only or no-AI. */
  withheld: string | null;
}

/**
 * Builds the ONLY view of a family that AI ever sees.
 *
 * Contact details are reduced to whether they exist. A summary does not need a
 * phone number, and a model that never receives one cannot repeat it. Dates of
 * birth appear only for a caller who could already read them directly.
 */
export function factsForFamily(familyId: string, user: User): FamilyFacts | null {
  const f = one<{
    id: string; name: string; status: string; source: string; created_at: string;
    no_ai: number; local_only: number;
  }>('SELECT id, name, status, source, created_at, no_ai, local_only FROM families WHERE id = ?', familyId);
  if (!f) return null;

  const base: FamilyFacts = {
    familyId: f.id, name: f.name, status: f.status, source: f.source, createdAt: f.created_at,
    guardians: [], children: [], tours: [], registrations: [], openTasks: [],
    nextAction: null, lastContactAt: null, noteCount: 0, withheld: null,
  };

  // A flag on the record beats anything a prompt could ask for. (spec 108/169)
  if (f.no_ai === 1 || f.local_only === 1) {
    return { ...base, withheld: 'This family is marked as never to be sent to AI.' };
  }

  base.guardians = many<{ first_name: string; last_name: string | null; relationship: string | null; email: string | null; phone: string | null }>(
    'SELECT first_name, last_name, relationship, email, phone FROM guardians WHERE family_id = ? ORDER BY is_primary DESC',
    familyId,
  ).map((g) => ({
    name: `${g.first_name} ${g.last_name ?? ''}`.trim(),
    relationship: g.relationship,
    // Presence, not the value.
    hasEmail: Boolean(g.email),
    hasPhone: Boolean(g.phone),
  }));

  const sensitive = can(user, 'child:read_sensitive');
  base.children = many<{ first_name: string; age_band: string | null; date_of_birth: string | null; status: string }>(
    'SELECT first_name, age_band, date_of_birth, status FROM children WHERE family_id = ?', familyId,
  ).map((c) => ({
    firstName: c.first_name,
    ageBand: c.age_band,
    status: c.status,
    ...(sensitive && c.date_of_birth ? { dateOfBirth: c.date_of_birth } : {}),
  }));

  base.tours = many<{ status: string; scheduled_for: string | null }>(
    'SELECT status, scheduled_for FROM tours WHERE family_id = ? ORDER BY created_at DESC LIMIT 5', familyId,
  ).map((t) => ({ status: t.status, scheduledFor: t.scheduled_for }));

  base.registrations = many<{ status: string; completed_steps: number | null; total_steps: number | null }>(
    'SELECT status, completed_steps, total_steps FROM registrations WHERE family_id = ? ORDER BY created_at DESC LIMIT 5', familyId,
  ).map((r) => ({
    status: r.status,
    steps: r.total_steps ? `${r.completed_steps ?? 0} of ${r.total_steps}` : 'unknown',
  }));

  base.openTasks = many<{ title: string; due_at: string | null }>(
    `SELECT title, due_at FROM tasks WHERE related_id IN (
        SELECT ? UNION SELECT id FROM tours WHERE family_id = ?
        UNION SELECT id FROM registrations WHERE family_id = ?)
      AND status IN ('open','doing') LIMIT 10`, familyId, familyId, familyId,
  ).map((t) => ({ title: t.title, dueAt: t.due_at }));

  const lead = one<{ next_action: string | null; next_action_due: string | null; next_action_reason: string | null; last_contact_at: string | null }>(
    `SELECT l.next_action, l.next_action_due, l.next_action_reason, l.last_contact_at
       FROM leads l JOIN lead_stages s ON s.id = l.stage_id
      WHERE l.family_id = ? AND s.is_open = 1 ORDER BY l.created_at DESC LIMIT 1`, familyId);
  if (lead?.next_action) {
    base.nextAction = { text: lead.next_action, dueAt: lead.next_action_due, reason: lead.next_action_reason };
  }
  base.lastContactAt = lead?.last_contact_at ?? null;

  // Note BODIES are deliberately not included. Staff write candid things about
  // families in notes, and a count is enough for a summary.
  base.noteCount = Number(one<{ n: number }>(
    "SELECT COUNT(*) n FROM notes WHERE entity_type = 'family' AND entity_id = ?", familyId)?.n ?? 0);

  return base;
}

// -------------------------------------------------------------- summaries

export interface Summary {
  /** Statements traceable to a record. Safe to act on. */
  facts: string[];
  /** Inference. Clearly separated, and absent when there is no model. */
  insight: string | null;
  source: 'rules' | string;
  withheld: string | null;
}

const daysAgo = (iso: string | null): number | null =>
  iso === null ? null : Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);

/**
 * The deterministic summary. This is what ships with no AI configured, and it
 * is genuinely useful on its own: every line is a fact read from a record.
 */
export function ruleSummary(f: FamilyFacts): string[] {
  const out: string[] = [];
  const age = daysAgo(f.createdAt);
  out.push(`${f.name} has been known to Tiny Stars for ${age ?? 0} day${age === 1 ? '' : 's'}, arriving via ${f.source}.`);

  if (f.children.length) {
    out.push(`${f.children.length} ${f.children.length === 1 ? 'child' : 'children'}: ` +
      f.children.map((c) => `${c.firstName}${c.ageBand ? ` (${c.ageBand})` : ''}`).join(', ') + '.');
  } else out.push('No child is recorded yet.');

  const reachable = f.guardians.filter((g) => g.hasEmail || g.hasPhone).length;
  if (!reachable) out.push('There is no way to contact this family on file.');

  const completed = f.tours.filter((t) => t.status === 'completed').length;
  const pending = f.tours.filter((t) => t.status === 'requested').length;
  if (completed) out.push(`${completed} tour${completed === 1 ? '' : 's'} completed.`);
  if (pending) out.push(`${pending} tour request${pending === 1 ? '' : 's'} still without a time.`);

  const submitted = f.registrations.filter((r) => r.status === 'submitted').length;
  const incomplete = f.registrations.filter((r) => r.status === 'incomplete');
  if (submitted) out.push(`${submitted} registration${submitted === 1 ? '' : 's'} submitted and awaiting review.`);
  for (const r of incomplete) out.push(`A registration was left unfinished at ${r.steps} steps.`);

  const since = daysAgo(f.lastContactAt);
  if (since === null) out.push('No contact has been logged with this family yet.');
  else if (since > 7) out.push(`Last contact was ${since} days ago.`);

  if (f.nextAction) {
    out.push(`Next action: ${f.nextAction.text}${f.nextAction.reason ? ` (${f.nextAction.reason})` : ''}.`);
  } else out.push('No next action is planned.');

  if (f.openTasks.length) out.push(`${f.openTasks.length} open task${f.openTasks.length === 1 ? '' : 's'}.`);
  return out;
}

/** Rules always. A model adds one paragraph of interpretation, or nothing. */
export async function summariseFamily(familyId: string, user: User): Promise<Summary | null> {
  const facts = factsForFamily(familyId, user);
  if (!facts) return null;
  if (facts.withheld) {
    return { facts: [], insight: null, source: 'rules', withheld: facts.withheld };
  }

  const lines = ruleSummary(facts);
  const p = provider();
  if (!p || !(await p.available())) {
    return { facts: lines, insight: null, source: 'rules', withheld: null };
  }

  const prompt = [
    'You are helping a nursery administrator. Below are facts read from their CRM.',
    'Write ONE short paragraph, at most three sentences, saying what deserves attention and why.',
    'Rules you must follow:',
    '- Use only the facts given. Do not invent names, dates, fees or availability.',
    '- Do not repeat the facts back; interpret them.',
    '- If nothing needs attention, say so plainly in one sentence.',
    '- Write plainly, as a colleague would. No bullet points, no headings.',
    '',
    'FACTS:',
    ...lines.map((l) => `- ${l}`),
  ].join('\n');

  const text = await p.complete(prompt, { maxTokens: 220 });
  return {
    facts: lines,
    // A model that returns nothing, or something suspiciously long, is ignored
    // rather than trusted. The rules summary is always there underneath.
    insight: text && text.length > 10 && text.length < 1200 ? text : null,
    source: text ? p.name : 'rules',
    withheld: null,
  };
}

// ------------------------------------------------------------- daily brief

export interface Brief {
  generatedAt: string;
  facts: string[];
  insight: string | null;
  source: 'rules' | string;
}

export async function dailyBrief(user: User): Promise<Brief> {
  const n = (sql: string, ...p: string[]): number =>
    Number(one<{ n: number }>(sql, ...p)?.n ?? 0);
  const now = nowIso();
  const dayAgo = new Date(Date.now() - 864e5).toISOString();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);

  const facts: string[] = [];
  const push = (count: number, one_: string, many_: string) => {
    if (count > 0) facts.push(`${count} ${count === 1 ? one_ : many_}`);
  };

  push(n('SELECT COUNT(*) n FROM leads WHERE created_at >= ?', dayAgo), 'new enquiry today', 'new enquiries today');
  push(n(`SELECT COUNT(*) n FROM tours WHERE scheduled_for BETWEEN ? AND ? AND status IN ('scheduled','confirmed')`,
    todayStart.toISOString(), todayEnd.toISOString()), 'tour today', 'tours today');
  push(n(`SELECT COUNT(*) n FROM tours WHERE status = 'requested'`), 'tour request without a time', 'tour requests without a time');
  push(n(`SELECT COUNT(*) n FROM registrations WHERE status = 'submitted'`), 'registration awaiting review', 'registrations awaiting review');
  push(n(`SELECT COUNT(*) n FROM registrations WHERE status = 'incomplete'`), 'unfinished registration', 'unfinished registrations');
  push(n(`SELECT COUNT(*) n FROM tasks WHERE status IN ('open','doing') AND due_at < ?`, now), 'overdue task', 'overdue tasks');
  push(n('SELECT COUNT(*) n FROM leads WHERE next_action_due IS NOT NULL AND next_action_due < ?', now),
    'overdue follow-up', 'overdue follow-ups');

  if (!facts.length) facts.push('Nothing is overdue and nothing is waiting for review.');

  const p = provider();
  if (!p || !(await p.available())) {
    return { generatedAt: now, facts, insight: null, source: 'rules' };
  }

  const text = await p.complete([
    'You are briefing the person who runs a nursery, first thing in the morning.',
    'Below are counts from their CRM. Write at most two sentences saying what to do first and why.',
    'Use only these numbers. Invent nothing. If there is nothing pressing, say so.',
    '',
    ...facts.map((f) => `- ${f}`),
  ].join('\n'), { maxTokens: 160 });

  return {
    generatedAt: now, facts,
    insight: text && text.length > 10 && text.length < 800 ? text : null,
    source: text ? p.name : 'rules',
  };
}
