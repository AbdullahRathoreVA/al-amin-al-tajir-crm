/** Typed fetch wrapper. Same-origin, cookie session, no auth headers to leak. */

export class ApiError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Offline or the server is not running. Say which, plainly.
    throw new ApiError(0, 'Cannot reach the Command Center server. Is it running on port 4317?');
  }
  if (res.status === 204) return null as T;
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const d = data as { error?: string; detail?: unknown } | null;
    throw new ApiError(res.status, d?.error ?? `Request failed (${res.status})`, d?.detail);
  }
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

// ------------------------------------------------------------------- shapes

export type Role = 'owner' | 'director' | 'admissions' | 'educator' | 'accounting' | 'readonly';

export interface User { id: string; email: string; name: string; role: Role; last_login_at: string | null }

export interface Me { user: User; capabilities: string[]; mode: 'demo' | 'production'; sessions: unknown[] }

export interface AttentionItem {
  id: string; severity: 'critical' | 'warning' | 'info';
  label: string; count: number; link: string; detail: string;
}

export interface TodaySummary {
  toursToday: number; newLeads24h: number; registrations24h: number;
  tasksOverdue: number; tasksDueToday: number; unreadNotifications: number;
}

export interface Stage { id: string; label: string; sortOrder: number; count: number; isOpen: boolean }

export interface ProgramHealth {
  id: string; name: string; capacity: number | null;
  enrolled: number; waitlisted: number; inquiries: number; occupancy: number | null;
}

export interface DataHealth {
  score: number | null; measured: boolean; totalFamilies: number;
  issues: { id: string; label: string; count: number; link: string }[];
}

export interface Notification {
  id: string; tier: 'critical' | 'high' | 'normal' | 'digest' | 'log';
  title: string; body: string | null; link_type: string | null; link_id: string | null;
  state: string; created_at: string;
}

export interface TourRow {
  id: string; status: string; scheduled_for: string | null; notes: string | null;
  family_id: string; family_name: string; phone: string | null; email: string | null;
  owner_name?: string | null;
}

export interface FollowUp {
  id: string; next_action: string; next_action_due: string; next_action_reason: string;
  family_id: string; family_name: string; stage: string;
}

export interface Dashboard {
  mode: 'demo' | 'production';
  today: TodaySummary;
  attention: AttentionItem[];
  pipeline: Stage[];
  programs: ProgramHealth[];
  dataHealth: DataHealth;
  toursToday: TourRow[];
  overdueFollowUps: FollowUp[];
  notifications: Notification[];
  generatedAt: string;
}

export interface FamilyRow {
  id: string; name: string; status: string; source: string;
  children_count: number; primary_contact: string | null;
  email: string | null; phone: string | null;
  latest_activity: string | null; updated_at: string;
}

export interface EventRow {
  seq: number; id: string; entity_type: string; entity_id: string; type: string;
  actor_type: string; source: string; summary: string | null; created_at: string;
}

export interface TaskRow {
  id: string; title: string; body: string | null; priority: string; status: string;
  due_at: string | null; related_type: string | null; related_id: string | null;
  reason: string | null; owner_name: string | null; source: string;
}

export interface LeadRow {
  id: string; family_id: string; family_name: string; stage_id: string; stage_label: string;
  program_interest: string | null; next_action: string | null; next_action_due: string | null;
  next_action_reason: string | null; owner_name: string | null; source: string; updated_at: string;
}

export interface RegistrationRow {
  id: string; status: string; family_id: string; family_name: string;
  child_first_name: string | null; age_band: string | null;
  completed_steps: number | null; total_steps: number | null;
  desired_start: string | null; source: string; submitted_at: string | null; created_at: string;
}

export interface SearchHit {
  entity_type: string; entity_id: string; title: string; snippet: string; rank: number;
}
