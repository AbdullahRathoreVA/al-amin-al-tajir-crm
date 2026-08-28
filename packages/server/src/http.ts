/**
 * A small router over node:http.
 *
 * This exists instead of a framework because the whole server has zero runtime
 * dependencies, which on an application holding children's records is a feature:
 * there is no transitive supply chain to audit or patch. It is ~150 lines and
 * does exactly what these routes need.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, createHmac } from 'node:crypto';
import { userForToken, can, type User, type Capability } from './core/auth.ts';

/** Note: no TypeScript parameter properties anywhere in this codebase. Node
 *  strips types rather than transforming them, so `constructor(public x)` is a
 *  syntax error at runtime. Assign explicitly. */
export class HttpError extends Error {
  status: number;
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const unauthorized = (m = 'Sign in required') => new HttpError(401, m);
export const forbidden = (m = 'You do not have permission to do that') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  rawBody: string;
  user: User | null;
  cookies: Record<string, string>;
  /** Throws 403 unless the signed-in user holds the capability. */
  require(cap: Capability): User;
  setCookie(name: string, value: string, opts?: { maxAge?: number; expires?: string }): void;
  clearCookie(name: string): void;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; parts: string[]; handler: Handler; anonymous: boolean }

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { anonymous?: boolean } = {}): void {
    this.routes.push({
      method,
      parts: pattern.split('/').filter(Boolean),
      handler,
      anonymous: opts.anonymous ?? false,
    });
  }
  get(p: string, h: Handler, o?: { anonymous?: boolean }) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: { anonymous?: boolean }) { this.add('POST', p, h, o); }
  patch(p: string, h: Handler, o?: { anonymous?: boolean }) { this.add('PATCH', p, h, o); }
  del(p: string, h: Handler, o?: { anonymous?: boolean }) { this.add('DELETE', p, h, o); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = path.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.parts.length; i++) {
        const rp = route.parts[i]!;
        const pp = parts[i]!;
        if (rp.startsWith(':')) params[rp.slice(1)] = decodeURIComponent(pp);
        else if (rp !== pp) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=');
    if (i === -1) continue;
    const k = pair.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

const MAX_BODY = 1_000_000; // 1 MB. A registration is kilobytes. (spec 173)

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Constant-time HMAC-SHA256 comparison for inbound webhook signatures. */
export function verifySignature(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const provided = header.startsWith('sha256=') ? header.slice(7) : header;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the request reached us over TLS, directly or via a proxy. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim();
  if (first) return first === 'https';
  return 'encrypted' in req.socket;
}

/**
 * Headers applied to every response.
 *
 * The CSP is genuinely restrictive because this app loads nothing remote: no
 * CDN, no font host, no analytics script, no embedded anything. If a future
 * change needs an external asset, widen this deliberately rather than dropping
 * it.
 */
export function securityHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'content-security-policy': [
      "default-src 'self'",
      // Vite emits a couple of inline style attributes; scripts stay strict.
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  };
  // Only over TLS. Sending HSTS on plain http is meaningless, and sending it
  // from localhost can poison the browser for every other localhost app.
  if (isSecureRequest(req)) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

export function json(res: ServerResponse, status: number, payload: unknown, req?: IncomingMessage): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(req ? securityHeaders(req) : {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    }),
  });
  res.end(body);
}

export async function handle(router: Router, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const found = router.match(req.method ?? 'GET', url.pathname);
  if (!found) return false;

  const cookies = parseCookies(req.headers.cookie);
  const rawBody = req.method === 'GET' || req.method === 'DELETE' ? '' : await readBody(req);

  let body: unknown = undefined;
  if (rawBody) {
    try { body = JSON.parse(rawBody); }
    catch { json(res, 400, { error: 'Request body is not valid JSON' }, req); return true; }
  }

  const setCookies: string[] = [];
  const user = found.route.anonymous ? null : userForToken(cookies.crm_session);

  const ctx: Ctx = {
    req, res, method: req.method ?? 'GET', path: url.pathname,
    params: found.params, query: url.searchParams, body, rawBody, user, cookies,
    require(cap) {
      if (!this.user) throw unauthorized();
      if (!can(this.user, cap)) throw forbidden(`Your role (${this.user.role}) cannot ${cap}`);
      return this.user;
    },
    setCookie(name, value, opts = {}) {
      const bits = [
        `${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
      ];
      // Secure whenever the request arrived over TLS. Set unconditionally and
      // localhost breaks; never set and the session travels in clear over the
      // internet. The proxy header is the only thing that knows which it is.
      if (isSecureRequest(req)) bits.push('Secure');
      if (opts.maxAge !== undefined) bits.push(`Max-Age=${opts.maxAge}`);
      if (opts.expires) bits.push(`Expires=${new Date(opts.expires).toUTCString()}`);
      setCookies.push(bits.join('; '));
    },
    clearCookie(name) {
      const secure = isSecureRequest(req) ? '; Secure' : '';
      setCookies.push(`${name}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
    },
  };

  try {
    if (!found.route.anonymous && !ctx.user) throw unauthorized();
    const result = await found.route.handler(ctx);
    if (res.writableEnded) return true;
    if (setCookies.length) res.setHeader('set-cookie', setCookies);
    json(res, result === undefined ? 204 : 200, result ?? null, req);
  } catch (err) {
    if (setCookies.length && !res.headersSent) res.setHeader('set-cookie', setCookies);
    if (err instanceof HttpError) {
      json(res, err.status, { error: err.message, ...(err.detail ? { detail: err.detail } : {}) }, req);
    } else {
      // Never leak internals to the client; the operator gets the real thing on
      // stderr, which stays local. (spec 175 / 176)
      console.error('[crm] unhandled error on', req.method, url.pathname, err);
      json(res, 500, { error: 'Something went wrong on the server. Check the server log.' }, req);
    }
  }
  return true;
}
