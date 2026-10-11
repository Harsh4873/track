import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { BOOK_IDS, type BookId, type BootstrapRequest, type Card, type LedgerEvent } from '../../shared/types.js';
import { applyCards, applyEvent, bootstrap, centralDay, parseBootstrap, parseCards, parseEvent, visibleState, type Ledger } from '../src/domain.js';
import { handle, hashToken, verifyPin, type SessionRecord, type Store } from '../src/service.js';

const now = new Date('2026-06-10T15:00:00.000Z');
const iso = now.toISOString();
const selection = (pick = 'Home', odds = 1.1) => ({ event: `Fixture ${pick}`, market: 'Full game moneyline', pick, odds, startTime: '2026-06-10T22:00:00.000Z', quotedAt: iso, sport: 'basketball', settlementRules: 'Includes overtime; postponed events void.', lineupConfirmed: true });
function initial(): BootstrapRequest {
  return { idempotencyKey: 'test.bootstrap', ledgerStart: '2026-06-10T14:00:00.000Z', books: BOOK_IDS.map((id) => ({
    id, name: id, openingCents: 10_000, targetCents: 50_000,
    policy: { dailyCapCents: ['fliff', 'novig', 'underdog'].includes(id) ? 300 : null, maxBankrollFraction: 1, minimumBankrollFraction: id === 'polymarket' ? .25 : 0, tierFractions: [1, .5, .25], minStakeCents: 100, minReturn: ['polymarket', 'rebet', 'onyx'].includes(id) ? 1.2 : id === 'fliff' ? 2 : null, maxReturn: ['polymarket', 'rebet', 'onyx'].includes(id) ? 1.4 : id === 'fliff' ? 3 : null, minSelections: id === 'novig' ? 1 : 2, minLegImpliedProbability: ['polymarket', 'rebet', 'onyx'].includes(id) ? .90 : null, maxLegImpliedProbability: ['polymarket', 'rebet', 'onyx'].includes(id) ? .95 : null, quoteMaxAgeMinutes: 15 },
  })) };
}
function ledger() { return bootstrap(parseBootstrap(initial()), now); }
function placed(book: BookId = 'rebet', stakeCents = 1000): LedgerEvent {
  return { idempotencyKey: 'placed.1', type: 'place', book, occurredAt: iso, note: 'Confirmed test slip', placementConfirmed: true, ticket: { id: 'ticket.1', stakeCents, feesCents: 0, decimalOdds: book === 'fliff' ? 2.25 : 1.21, selections: [selection('Home', book === 'fliff' ? 1.5 : 1.1), selection('Away', book === 'fliff' ? 1.5 : 1.1)], tier: 1 } };
}
function settle(outcome: 'won'|'lost'|'void' = 'won', returnCents = 1210): LedgerEvent { return { idempotencyKey: 'settled.1', book: 'rebet', type: 'settle', occurredAt: iso, note: 'App confirmed', appSettlementConfirmed: true, ticketId: 'ticket.1', outcome, returnCents, settlementFeeCents: 0 }; }
function ready(): Card { return { date: '2026-06-10', status: 'ready', summary: 'Synthetic reviewed fixture', updatedAt: iso, tier: 1, proposedStakeCents: 1000, minimumStakeCents: 100, feesCents: 0, decimalOdds: 1.21, returnCents: 1210, profitCents: 210, selections: [selection(), selection('Away')], sources: [{ label: 'Official fixture', url: 'https://example.com/fixture' }], invalidations: ['Recheck if lineup changes'], verification: { actualAppPrice: true, settlementRules: true, essentialLineups: true, combinedPrice: true, correlationReviewed: true, jurisdiction: 'US' } }; }
const b = (l: Ledger, id: BookId = 'rebet') => l.books.find((x) => x.id === id)!;

test('bootstrap and display never expose server policies or budgets', () => {
  const state = visibleState(ledger(), now); assert.equal(state.books.length, 6);
  assert.equal('policy' in state.books[0], false); assert.equal('day' in state.books[0], false); assert.equal('budgets' in state.books[0], false);
});
test('proposals never deduct funds; a missing actual combined quote is rejected', () => {
  const input = { idempotencyKey: 'card.1', cards: [{ book: 'rebet' as const, card: ready() }] };
  const l = applyCards(ledger(), parseCards(input), now); assert.equal(b(l).availableCents, 10_000);
  input.cards[0].card.verification!.combinedPrice = false;
  assert.throws(() => applyCards(ledger(), parseCards(input), now), /unverified_card/);
});
test('placement, calculated result, and confirmed win move funds separately', () => {
  let l = applyEvent(ledger(), parseEvent(placed()), now); assert.equal(b(l).availableCents, 9000); assert.equal(b(l).outstandingCents, 1000);
  l = applyEvent(l, parseEvent({ idempotencyKey: 'result.1', type: 'result', book: 'rebet', occurredAt: iso, note: 'Result checked', ticketId: 'ticket.1', resultNote: 'Official result verified, app pending' }), now);
  assert.equal(b(l).availableCents, 9000); assert.equal(b(l).tickets[0].status, 'result_pending');
  l = applyEvent(l, parseEvent(settle()), now); assert.equal(b(l).availableCents, 10_210); assert.equal(b(l).realizedProfitCents, 210); assert.equal(b(l).outstandingCents, 0);
  assert.throws(() => applyEvent(l, parseEvent(settle()), now), /ticket_closed/);
});
test('loss, void and correction reconcile without double counting', () => {
  const open = applyEvent(ledger(), parseEvent(placed()), now);
  const loss = applyEvent(open, parseEvent(settle('lost', 0)), now); assert.equal(b(loss).realizedProfitCents, -1000);
  const refund = applyEvent(open, parseEvent(settle('void', 1000)), now); assert.equal(b(refund).availableCents, 10_000); assert.equal(b(refund).realizedProfitCents, 0);
  const corrected = applyEvent(loss, parseEvent({ ...settle('void', 1000), type: 'correct_settlement', relatedEventId: 'settled.1' }), now); assert.equal(b(corrected).availableCents, 10_000); assert.equal(b(corrected).realizedProfitCents, 0);
});
test('exchange fills and fees are recorded once and preserve exact cash accounting', () => {
  const event = placed('polymarket', 3000); if (event.type !== 'place') return;
  event.ticket.fills = [{ id: 'fill.1', quantity: 40, priceCents: 75 }]; event.ticket.feesCents = 20;
  let l = applyEvent(ledger(), parseEvent(event), now); assert.equal(b(l, 'polymarket').availableCents, 6980);
  const extra = { idempotencyKey: 'fill.2', type: 'fill', book: 'polymarket', occurredAt: iso, note: 'Second confirmed fill', placementConfirmed: true, ticketId: 'ticket.1', fills: [{ id: 'fill.2', quantity: 10, priceCents: 76 }], feesCents: 5 };
  l = applyEvent(l, parseEvent(extra), now); assert.equal(b(l, 'polymarket').availableCents, 6215); assert.equal(b(l, 'polymarket').tickets[0].stakeCents, 3760);
  assert.throws(() => applyEvent(l, parseEvent(extra), now), /duplicate_fill/);
  l = applyEvent(l, parseEvent({ ...settle('won', 5000), book: 'polymarket', settlementFeeCents: 10 }), now);
  assert.equal(b(l, 'polymarket').availableCents, 11_205); assert.equal(b(l, 'polymarket').realizedProfitCents, 1205);
});
test('Polymarket minimum allocation is 25%, not a maximum; full balance remains eligible', () => {
  const event = placed('polymarket', 10_000); if (event.type !== 'place') return;
  event.ticket.fills = [{ id: 'fill.full', quantity: 125, priceCents: 80 }];
  assert.equal(b(applyEvent(ledger(), parseEvent(event), now), 'polymarket').availableCents, 0);
  event.ticket.stakeCents = 2000; event.ticket.fills = [{ id: 'fill.small', quantity: 25, priceCents: 80 }];
  assert.throws(() => applyEvent(ledger(), parseEvent(event), now), /below_minimum_allocation/);
});
test('parlays are required for the three allocation accounts and must stay in return range', () => {
  for (const book of ['rebet', 'onyx'] as const) {
    const event = placed(book); if (event.type !== 'place') continue;
    event.ticket.selections = [selection()]; assert.throws(() => applyEvent(ledger(), parseEvent(event), now), /insufficient_selections/);
    event.ticket.selections.push(selection('Away')); event.ticket.decimalOdds = 1.5; assert.throws(() => applyEvent(ledger(), parseEvent(event), now), /return_outside_range/);
  }
});
test('caps span daily runs; winnings and new deposits cannot replenish daily risk allowance', () => {
  let l = applyEvent(ledger(), parseEvent(placed('fliff', 300)), now);
  l = applyEvent(l, parseEvent({ ...settle('won', 675), book: 'fliff' }), now);
  l = applyEvent(l, parseEvent({ idempotencyKey: 'deposit.1', type: 'adjust', book: 'fliff', occurredAt: iso, note: 'Confirmed deposit', kind: 'deposit', amountCents: 10_000 }), now);
  const again = placed('fliff', 100); if (again.type !== 'place') return; again.ticket.id = 'ticket.2';
  assert.throws(() => applyEvent(l, parseEvent(again), now), /daily_limit_exceeded/);
});
test('late confirmations retain original date and the earlier daily cap', () => {
  let l = ledger(); const next = new Date('2026-06-11T15:00:00Z');
  l = applyCards(l, parseCards({ idempotencyKey: 'next.card', cards: [{ book: 'rebet', card: { ...ready(), date: '2026-06-11', status: 'skip', proposedStakeCents: 0, returnCents: null, profitCents: null } }] }), next);
  l = applyEvent(l, parseEvent(placed()), next); assert.equal(b(l).tickets[0].placedAt, iso); assert.equal(b(l).dailyStakedCents, 0); assert.equal(b(l).day.bankrollCents, 9000);
});
test('stale quotes, started events, excluded sports and absent confirmations fail closed', () => {
  const card = ready(); card.selections[0].quotedAt = '2026-06-10T14:00:00Z';
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'stale', cards: [{ book: 'rebet', card }] }), now), /stale_quote/);
  card.selections[0].quotedAt = iso; card.selections[0].startTime = iso;
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'started', cards: [{ book: 'rebet', card }] }), now), /market_started/);
  const event = placed(); if (event.type !== 'place') return; event.ticket.selections[0].sport = 'tennis'; assert.throws(() => parseEvent(event), /excluded_sport/);
  assert.throws(() => parseEvent({ ...placed(), placementConfirmed: false }), /placement_confirmation_required/);
  assert.throws(() => parseEvent({ ...settle(), appSettlementConfirmed: false }), /settlement_confirmation_required/);
});
test('target pauses new proposals and old cards lose actionable status', () => {
  const l = ledger(); b(l).availableCents = b(l).targetCents;
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'target', cards: [{ book: 'rebet', card: ready() }] }), now), /target_reached/);
  const active = applyCards(ledger(), parseCards({ idempotencyKey: 'active', cards: [{ book: 'rebet', card: ready() }] }), now);
  const stale = visibleState(active, new Date(now.getTime() + 16 * 60_000)).books.find((x) => x.id === 'rebet')!.card!;
  assert.equal(stale.status, 'research'); assert.equal(stale.proposedStakeCents, 0);
});
test('Central calendar dates remain correct across DST transitions', () => {
  assert.equal(centralDay(new Date('2026-03-08T05:59:00Z')), '2026-03-07');
  assert.equal(centralDay(new Date('2026-03-08T08:01:00Z')), '2026-03-08');
  assert.equal(centralDay(new Date('2026-11-01T06:59:00Z')), '2026-11-01');
  assert.equal(centralDay(new Date('2026-11-01T07:01:00Z')), '2026-11-01');
});

class MemoryStore implements Store {
  value: Ledger | null = null; sessions = new Map<string, SessionRecord>(); keys = new Map<string, string>(); attempts = new Map<string, number>();
  async read() { return this.value; }
  async mutate(key: string, hash: string, _body: unknown, update: (old: Ledger | null) => Ledger) {
    if (this.keys.has(key)) { if (this.keys.get(key) !== hash) throw new Error('conflict'); return { applied: false, ledger: this.value! }; }
    this.value = update(this.value); this.keys.set(key, hash); return { applied: true, ledger: this.value };
  }
  async attempt(ip: string) { const n = (this.attempts.get(ip) ?? 0) + 1; this.attempts.set(ip, n); return n > 5 ? 900 : 0; }
  async createSession(hash: string, record: SessionRecord) { this.sessions.set(hash, record); }
  async session(hash: string) { return this.sessions.get(hash) ?? null; }
  async deleteSession(hash: string) { this.sessions.delete(hash); }
}
const testPin = '8427'; const salt = 'a'.repeat(64); const encoded = `${salt}:${scryptSync(testPin, salt, 64).toString('hex')}`; const serviceToken = 'T'.repeat(64);
function req(path: string, method = 'GET', data?: unknown, token?: string, origin?: string) { return new Request(`https://test.invalid${path}`, { method, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-track-authorization': `Bearer ${token}` } : {}), ...(origin ? { origin } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) }); }
test('PIN hashing validates format and rejects incorrect values', () => { assert.equal(verifyPin(testPin, encoded), true); assert.equal(verifyPin('1111', encoded), false); assert.equal(verifyPin(null, encoded), false); });
test('API denies unauthenticated reads and wrong-origin access', async () => {
  const context = { store: new MemoryStore(), pinHash: encoded, serviceToken, now: () => now };
  assert.equal((await handle(req('/v1/state'), context, 'test')).status, 401);
  assert.equal((await handle(req('/v1/state', 'GET', undefined, serviceToken, 'https://other.invalid'), context, 'test')).status, 403);
});
test('sessions expire, cannot mutate, revoke on logout and rate-limit failed unlocks', async () => {
  const store = new MemoryStore(); const context = { store, pinHash: encoded, serviceToken, now: () => now };
  const response = await handle(req('/v1/session', 'POST', { pin: testPin }, undefined, 'https://harsh.bet'), context, 'test');
  assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://harsh.bet');
  const session = await response.json() as { token: string };
  assert.equal((await handle(req('/v1/state', 'GET', undefined, session.token), context, 'test')).status, 200);
  assert.equal((await handle(req('/v1/bootstrap', 'POST', initial(), session.token), context, 'test')).status, 403);
  assert.equal((await handle(req('/v1/state', 'GET', undefined, session.token), { ...context, now: () => new Date(now.getTime() + 13 * 3600_000) }, 'test')).status, 401);
  await handle(req('/v1/session', 'DELETE', undefined, session.token), context, 'test'); assert.equal(store.sessions.has(hashToken(session.token)), false);
  for (let i = 0; i < 5; i++) await handle(req('/v1/session', 'POST', { pin: '1111' }), context, 'other');
  const denied = await handle(req('/v1/session', 'POST', { pin: testPin }), context, 'other'); assert.equal(denied.status, 429); assert.ok(denied.headers.get('Retry-After'));
});
test('service can initialize and retry same mutation without duplicating funds', async () => {
  const store = new MemoryStore(); const context = { store, pinHash: encoded, serviceToken, now: () => now };
  assert.equal((await handle(req('/v1/bootstrap', 'POST', initial(), serviceToken), context, 'test')).status, 200);
  const first = await handle(req('/v1/events', 'POST', placed(), serviceToken), context, 'test'); assert.equal(first.status, 200);
  const again = await handle(req('/v1/events', 'POST', placed(), serviceToken), context, 'test'); assert.equal((await again.json() as { applied: boolean }).applied, false); assert.equal(b(store.value!).availableCents, 9000);
});
