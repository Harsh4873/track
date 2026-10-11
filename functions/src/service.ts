import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError, applyCards, applyEvent, bootstrap, digest, ensure, parseBootstrap, parseCards, parseEvent, visibleState, type Ledger } from './domain.js';
import type { TrackState } from '../../shared/types.js';

export interface SessionRecord { expiresAt: number }
export interface Store {
  read(): Promise<Ledger | null>;
  mutate(key: string, hash: string, body: unknown, update: (old: Ledger | null) => Ledger, related?: { key: string; book: string; ticketId?: string }): Promise<{ applied: boolean; ledger: Ledger }>;
  attempt(ip: string, now: number): Promise<number>;
  createSession(hash: string, record: SessionRecord): Promise<void>;
  session(hash: string): Promise<SessionRecord | null>;
  deleteSession(hash: string): Promise<void>;
}
export interface Context { store: Store; pinHash: string; serviceToken: string; now?: () => Date }
const ALLOWED_ORIGIN = 'https://harsh.bet';
const SESSION_MS = 12 * 60 * 60 * 1000;
export function hashToken(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function equalSecret(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(hashToken(a), 'hex'), Buffer.from(hashToken(b), 'hex')); }
export function verifyPin(pin: unknown, encoded: string): boolean {
  const [salt, hash] = encoded.split(':');
  if (typeof pin !== 'string' || !/^\d{4,12}$/.test(pin) || !/^[a-f0-9]{64}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hash ?? '')) return false;
  return timingSafeEqual(scryptSync(pin, salt, 64), Buffer.from(hash, 'hex'));
}
function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
async function body(request: Request): Promise<unknown> {
  ensure(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'json_required', 415);
  const raw = await request.text();
  ensure(Buffer.byteLength(raw) <= 250_000, 'request_too_large', 413);
  try { return JSON.parse(raw); } catch { throw new ApiError(400, 'invalid_json'); }
}
const emptyState: TrackState = { updatedAt: null, ledgerStart: null, books: [] };
export async function handle(request: Request, context: Context, clientIp: string): Promise<Response> {
  const origin = request.headers.get('origin');
  const cors: Record<string, string> = origin === ALLOWED_ORIGIN ? {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Track-Authorization, Content-Type',
    'Access-Control-Expose-Headers': 'Retry-After', Vary: 'Origin',
  } : {};
  try {
    ensure(!origin || origin === ALLOWED_ORIGIN, 'origin_denied', 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Cache-Control': 'no-store' } });
    const now = context.now?.() ?? new Date();
    const path = new URL(request.url).pathname.replace(/^\/trackApi(?=\/)/, '').replace(/\/$/, '');
    if (path === '/v1/session' && request.method === 'POST') {
      const retry = await context.store.attempt(hashToken(clientIp), now.getTime());
      if (retry > 0) return json({ error: 'too_many_attempts' }, 429, { ...cors, 'Retry-After': String(retry) });
      const input = await body(request) as { pin?: unknown };
      ensure(verifyPin(input?.pin, context.pinHash), 'invalid_code', 401);
      const token = randomBytes(48).toString('base64url');
      const expiresAt = now.getTime() + SESSION_MS;
      await context.store.createSession(hashToken(token), { expiresAt });
      return json({ token, expiresAt: new Date(expiresAt).toISOString() }, 200, cors);
    }
    const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/.exec(request.headers.get('x-track-authorization') ?? '');
    ensure(match, 'unauthorized', 401);
    const token = match[1];
    const service = context.serviceToken.length >= 40 && equalSecret(token, context.serviceToken);
    const session = service ? null : await context.store.session(hashToken(token));
    ensure(service || (session && session.expiresAt > now.getTime()), 'unauthorized', 401);
    if (path === '/v1/session' && request.method === 'DELETE') {
      ensure(!service, 'session_required', 403);
      await context.store.deleteSession(hashToken(token));
      return json({ locked: true }, 200, cors);
    }
    if (path === '/v1/state' && request.method === 'GET') {
      const ledger = await context.store.read();
      return json(ledger ? visibleState(ledger, now) : emptyState, 200, cors);
    }
    ensure(service, 'read_only_session', 403);
    ensure(request.method === 'POST', 'method_not_allowed', 405);
    const input = await body(request);
    let result: { applied: boolean; ledger: Ledger };
    if (path === '/v1/bootstrap') {
      const parsed = parseBootstrap(input);
      result = await context.store.mutate(parsed.idempotencyKey, digest(parsed), parsed, (old) => {
        ensure(!old, 'already_initialized', 409); return bootstrap(parsed, now);
      });
    } else if (path === '/v1/events') {
      const parsed = parseEvent(input);
      const related = 'relatedEventId' in parsed && parsed.relatedEventId ? { key: parsed.relatedEventId, book: parsed.book, ticketId: 'ticketId' in parsed ? parsed.ticketId : undefined } : undefined;
      result = await context.store.mutate(parsed.idempotencyKey, digest(parsed), parsed, (old) => {
        ensure(old, 'not_initialized', 409); return applyEvent(old, parsed, now);
      }, related);
    } else if (path === '/v1/cards') {
      const parsed = parseCards(input);
      result = await context.store.mutate(parsed.idempotencyKey, digest(parsed), parsed, (old) => {
        ensure(old, 'not_initialized', 409); return applyCards(old, parsed, now);
      });
    } else throw new ApiError(404, 'not_found');
    return json({ applied: result.applied, state: visibleState(result.ledger, now) }, 200, cors);
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.code }, error.status, cors);
    return json({ error: 'service_unavailable' }, 503, cors);
  }
}
