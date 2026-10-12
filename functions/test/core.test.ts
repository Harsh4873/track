import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { ACTIVE_BOOK_IDS, type BookId, type BootstrapRequest, type Card, type LedgerEvent } from '../../shared/types.js';
import { applyCards, applyEvent, bootstrap, centralDay, parseBootstrap, parseCards, parseEvent, visibleState, type Ledger } from '../src/domain.js';
import { handle, hashToken, verifyPin, type SessionRecord, type Store } from '../src/service.js';

const now = new Date('2026-06-10T15:00:00.000Z');
const iso = now.toISOString();
const selection = (pick = 'Home', odds = 1.1) => ({ event: `Fixture ${pick}`, market: 'Full game moneyline', pick, odds, startTime: '2026-06-10T22:00:00.000Z', quotedAt: iso, sport: 'basketball', settlementRules: 'Includes overtime; postponed events void.', lineupConfirmed: true });
function initial(): BootstrapRequest {
  return { idempotencyKey: 'test.bootstrap', ledgerStart: '2026-06-10T14:00:00.000Z', books: ACTIVE_BOOK_IDS.map((id) => ({
    id, name: id, openingCents: 10_000, targetCents: 50_000,
    policy: { dailyCapCents: ['fliff', 'novig', 'underdog'].includes(id) ? 300 : id === 'underdog_streaks' ? 100 : null, maxBankrollFraction: 1, minimumBankrollFraction: id === 'polymarket' ? .25 : 0, tierFractions: [1, .5, .25], minStakeCents: 100, minReturn: ['polymarket', 'rebet'].includes(id) ? 1.2 : id === 'fliff' ? 2 : null, maxReturn: ['polymarket', 'rebet'].includes(id) ? 1.4 : id === 'fliff' ? 3 : null, minSelections: ['novig', 'underdog_streaks'].includes(id) ? 1 : 2, minLegImpliedProbability: ['polymarket', 'rebet'].includes(id) ? .90 : null, maxLegImpliedProbability: ['polymarket', 'rebet'].includes(id) ? .95 : null, quoteMaxAgeMinutes: 15 },
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
test('Novig requires actual exchange fills and counts later fills and fees toward its cap', () => {
  const event = placed('novig', 100); if (event.type !== 'place') return;
  event.ticket.selections = [selection('Home', 2)]; event.ticket.decimalOdds = 2;
  assert.throws(() => parseEvent(event), /exchange_fills_required/);
  event.ticket.fills = [{ id: 'novig.1', quantity: 2, priceCents: 50 }];
  let l = applyEvent(ledger(), parseEvent(event), now);
  const extra = { idempotencyKey: 'novig.2', type: 'fill', book: 'novig', occurredAt: iso, note: 'Confirmed partial fill', placementConfirmed: true, ticketId: 'ticket.1', fills: [{ id: 'novig.2', quantity: 2, priceCents: 50 }], feesCents: 5 };
  l = applyEvent(l, parseEvent(extra), now);
  assert.equal(b(l, 'novig').availableCents, 9795); assert.equal(b(l, 'novig').outstandingCents, 200);
  assert.throws(() => applyEvent(l, parseEvent({ ...extra, idempotencyKey: 'novig.3', fills: [{ id: 'novig.3', quantity: 2, priceCents: 50 }] }), now), /daily_limit_exceeded/);
  l = applyEvent(l, parseEvent({ ...settle('won', 400), book: 'novig' }), now);
  assert.equal(b(l, 'novig').availableCents, 10_195); assert.equal(b(l, 'novig').realizedProfitCents, 195);
});
test('research cards still enforce parlay range; confirmed placements record the actual slip', () => {
  const card = ready(); card.status = 'research'; card.proposedStakeCents = 0; card.returnCents = null; card.profitCents = null; card.plannedStakeCents = 1000;
  card.selections = [selection()];
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'short', cards: [{ book: 'rebet', card }] }), now), /insufficient_selections/);
  card.selections.push(selection('Away')); card.decimalOdds = 1.5;
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'wide', cards: [{ book: 'rebet', card }] }), now), /return_outside_range/);
  const event = placed('rebet'); if (event.type !== 'place') return;
  event.ticket.decimalOdds = 1.8;
  const recorded = applyEvent(ledger(), parseEvent(event), now);
  assert.equal(b(recorded).availableCents, 9000); assert.equal(b(recorded).tickets[0].decimalOdds, 1.8);
});
test('retired books leave the journal and a new book can be opened', () => {
  let l = ledger();
  l = applyEvent(l, parseEvent({ idempotencyKey: 'retire.rebet', type: 'retire_book', book: 'rebet', occurredAt: iso, note: 'Removed' }), now);
  assert.equal(visibleState(l, now).books.some((book) => book.id === 'rebet'), false);
  assert.throws(() => applyEvent(l, parseEvent(placed('rebet')), now), /book_retired/);
  const missing = structuredClone(l); missing.books = missing.books.filter((book) => book.id !== 'underdog_streaks');
  const policy = initial().books.find((book) => book.id === 'underdog_streaks')!.policy;
  l = applyEvent(missing, parseEvent({ idempotencyKey: 'open.streaks', type: 'open_book', book: 'underdog_streaks', occurredAt: iso, note: 'Opened', name: 'Underdog Streaks', openingCents: 100, targetCents: 40_000, policy }), now);
  assert.equal(b(l, 'underdog_streaks').availableCents, 100);
  assert.equal(visibleState(l, now).books.some((book) => book.id === 'underdog_streaks'), true);
});
test('caps span daily runs; winnings and new deposits cannot replenish daily risk allowance', () => {
  let l = applyEvent(ledger(), parseEvent(placed('fliff', 300)), now);
  l = applyEvent(l, parseEvent({ ...settle('won', 675), book: 'fliff' }), now);
  l = applyEvent(l, parseEvent({ idempotencyKey: 'deposit.1', type: 'adjust', book: 'fliff', occurredAt: iso, note: 'Confirmed deposit', kind: 'deposit', amountCents: 10_000 }), now);
  const again = placed('fliff', 100); if (again.type !== 'place') return; again.ticket.id = 'ticket.2';
  assert.throws(() => applyEvent(l, parseEvent(again), now), /daily_limit_exceeded/);
});
test('reported available balance preserves opening funds, exposure and realized profit', () => {
  let l = applyEvent(ledger(), parseEvent(placed()), now);
  l = applyEvent(l, parseEvent(settle()), now);
  const second = placed(); if (second.type !== 'place') return; second.ticket.id = 'ticket.2'; second.idempotencyKey = 'placed.2';
  l = applyEvent(l, parseEvent(second), now);
  const before = structuredClone(b(l));
  const event = { idempotencyKey: 'balance.1', type: 'balance_report', book: 'rebet', occurredAt: iso, note: 'User reported current available cash; origin unspecified.', availableCents: 12_345, previousAvailableCents: before.availableCents };
  l = applyEvent(l, parseEvent(event), now);
  const after = b(l);
  assert.equal(after.availableCents, 12_345);
  assert.equal(after.openingCents, before.openingCents);
  assert.equal(after.realizedProfitCents, before.realizedProfitCents);
  assert.equal(after.outstandingCents, before.outstandingCents);
  assert.deepEqual(after.tickets, before.tickets);
  assert.deepEqual(after.day, before.day);
  assert.deepEqual(after.lastBalanceReport, { reportedAt: iso, availableCents: 12_345, previousAvailableCents: before.availableCents, changeCents: 12_345 - before.availableCents, note: event.note, establishedDayBaseline: false });
  assert.deepEqual(visibleState(l, now).books.find((book) => book.id === 'rebet')!.lastBalanceReport, after.lastBalanceReport);
});
test('balance reports reject stale comparisons and invalid amounts', () => {
  const event = { idempotencyKey: 'balance.stale', type: 'balance_report', book: 'rebet', occurredAt: iso, note: 'Reported available cash', availableCents: 12_345, previousAvailableCents: 9999 };
  assert.throws(() => applyEvent(ledger(), parseEvent(event), now), /balance_report_conflict/);
  assert.throws(() => parseEvent({ ...event, availableCents: -1 }), /invalid_request/);
  assert.throws(() => parseEvent({ ...event, previousAvailableCents: 1.5 }), /invalid_request/);
  assert.throws(() => parseEvent({ ...event, establishDayBaseline: 'true' }), /invalid_request/);
});
test('an unused day may adopt a reported bankroll without rewriting opening balance', () => {
  const event = { idempotencyKey: 'balance.baseline', type: 'balance_report', book: 'rebet', occurredAt: iso, note: 'User reported opening available cash for this day', availableCents: 12_345, previousAvailableCents: 10_000, establishDayBaseline: true };
  const l = applyEvent(ledger(), parseEvent(event), now);
  assert.equal(b(l).day.bankrollCents, 12_345); assert.equal(b(l).day.spentCents, 0); assert.equal(b(l).openingCents, 10_000);
  assert.equal(b(l).realizedProfitCents, 0); assert.equal(b(l).lastBalanceReport?.establishedDayBaseline, true);
});
test('balance reports cannot reset consumed caps or bankrolls after settlement activity', () => {
  let l = applyEvent(ledger(), parseEvent(placed('fliff', 300)), now);
  const event = { idempotencyKey: 'balance.used', type: 'balance_report', book: 'fliff', occurredAt: iso, note: 'User reported current available cash', availableCents: 15_000, previousAvailableCents: 9700, establishDayBaseline: true };
  assert.throws(() => applyEvent(l, parseEvent(event), now), /balance_baseline_budget_consumed/);
  l = applyEvent(l, parseEvent({ ...event, establishDayBaseline: false }), now);
  assert.equal(b(l, 'fliff').day.spentCents, 300); assert.equal(b(l, 'fliff').day.bankrollCents, 10_000);
  const again = placed('fliff', 100); if (again.type !== 'place') return; again.ticket.id = 'ticket.2';
  assert.throws(() => applyEvent(l, parseEvent(again), now), /daily_limit_exceeded/);
  const next = new Date('2026-06-11T15:00:00Z');
  l = applyEvent(l, parseEvent({ ...settle('won', 675), book: 'fliff', occurredAt: next.toISOString() }), next);
  assert.equal(b(l, 'fliff').day.spentCents, 0);
  assert.throws(() => applyEvent(l, parseEvent({ ...event, occurredAt: next.toISOString(), previousAvailableCents: b(l, 'fliff').availableCents }), next), /balance_baseline_ticket_activity/);
  assert.throws(() => applyEvent(ledger(), parseEvent({ ...event, book: 'rebet', previousAvailableCents: 10_000 }), next), /balance_baseline_day_mismatch/);
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
test('comparison quotes may inform research but cannot be published as actionable app prices', () => {
  const card = ready(); card.selections[0].quoteBasis = 'comparison'; card.selections[0].quoteSource = 'Comparison operator';
  const input = { idempotencyKey: 'comparison.ready', cards: [{ book: 'rebet' as const, card }] };
  assert.throws(() => applyCards(ledger(), parseCards(input), now), /comparison_quote_not_actionable/);
  card.status = 'research'; card.proposedStakeCents = 0; card.returnCents = null; card.profitCents = null;
  const research = applyCards(ledger(), parseCards(input), now); assert.equal(b(research).card!.selections[0].quoteSource, 'Comparison operator');
  assert.throws(() => parseCards({ ...input, cards: [{ book: 'rebet', card: { ...card, selections: [{ ...card.selections[0], quoteBasis: 'unknown' }] } }] }), /invalid_request/);
  assert.throws(() => parseCards({ ...input, cards: [{ book: 'rebet', card: { ...card, selections: [{ ...card.selections[0], quoteSource: '' }] } }] }), /invalid_request/);
});
test('planned stakes stay on research cards, respect limits and never move funds', () => {
  const card = ready(); card.status = 'research'; card.proposedStakeCents = 0; card.returnCents = null; card.profitCents = null; card.plannedStakeCents = 10_000;
  card.selections = card.selections.map((s) => ({ ...s, quoteBasis: 'comparison' as const, quoteSource: 'Comparison operator' }));
  const input = { idempotencyKey: 'planned', cards: [{ book: 'rebet' as const, card }] };
  const l = applyCards(ledger(), parseCards(input), now);
  assert.equal(b(l).availableCents, 10_000); assert.equal(b(l).outstandingCents, 0); assert.equal(b(l).card!.plannedStakeCents, 10_000);
  assert.throws(() => applyCards(ledger(), parseCards({ ...input, cards: [{ book: 'rebet', card: { ...card, plannedStakeCents: 10_001 } }] }), now), /daily_limit_exceeded/);
  assert.throws(() => applyCards(ledger(), parseCards({ ...input, cards: [{ book: 'fliff', card: { ...card, decimalOdds: 2.25, plannedStakeCents: 301 } }] }), now), /daily_limit_exceeded/);
  assert.throws(() => applyCards(ledger(), parseCards({ ...input, cards: [{ book: 'rebet', card: { ...card, decimalOdds: 1.5 } }] }), now), /return_outside_range/);
  assert.throws(() => parseCards({ ...input, cards: [{ book: 'rebet', card: { ...ready(), plannedStakeCents: 1000 } }] }), /planned_stake_requires_research_card/);
  assert.throws(() => parseCards({ ...input, cards: [{ book: 'rebet', card: { ...card, status: 'skip' } }] }), /planned_stake_requires_research_card/);
  const underdog = { ...card, decimalOdds: null, plannedStakeCents: 200, selections: card.selections.map((s) => ({ ...s, odds: null })) };
  assert.equal(b(applyCards(ledger(), parseCards({ ...input, cards: [{ book: 'underdog', card: underdog }] }), now), 'underdog').card!.plannedStakeCents, 200);
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
