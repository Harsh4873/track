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
    id, name: id, openingCents: id === 'novig_credit' ? 1_000 : 10_000, targetCents: id === 'novig_credit' ? 1_000 : 50_000,
    policy: { dailyCapCents: id === 'novig_credit' ? null : ['fliff', 'novig', 'underdog'].includes(id) ? 300 : id === 'underdog_streaks' ? 100 : null, maxBankrollFraction: 1, minimumBankrollFraction: id === 'polymarket' ? .25 : 0, tierFractions: [1, .5, .25], minStakeCents: 100, minReturn: id === 'novig_credit' ? null : ['polymarket', 'rebet'].includes(id) ? 1.2 : id === 'fliff' ? 2 : null, maxReturn: id === 'novig_credit' ? null : ['polymarket', 'rebet'].includes(id) ? 1.4 : id === 'fliff' ? 3 : null, minSelections: ['novig', 'novig_credit', 'underdog_streaks'].includes(id) ? 1 : 2, minLegImpliedProbability: ['polymarket', 'rebet'].includes(id) ? .90 : null, maxLegImpliedProbability: ['polymarket', 'rebet'].includes(id) ? .95 : null, quoteMaxAgeMinutes: 15, playthrough: id === 'novig_credit' ? true : undefined },
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
  const state = visibleState(ledger(), now); assert.equal(state.books.length, 7);
  assert.equal('policy' in state.books[0], false); assert.equal('day' in state.books[0], false); assert.equal('budgets' in state.books[0], false);
  const credit = state.books.find((book) => book.id === 'novig_credit')!;
  assert.equal(credit.openingCents, 1000); assert.equal(credit.targetCents, 1000); assert.equal(credit.availableCents, 1000); assert.equal(credit.playthrough, true);
  assert.equal('policy' in credit, false); assert.equal('day' in credit, false);
  assert.equal(state.books.some((book) => book.id !== 'novig_credit' && book.playthrough), false);
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
  assert.equal(b(applyEvent(ledger(), parseEvent(event), now), 'polymarket').availableCents, 8000);
  const card = ready(); card.proposedStakeCents = 2000; card.returnCents = 2420; card.profitCents = 420;
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'pm.floor', cards: [{ book: 'polymarket', card }] }), now), /below_minimum_allocation/);
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
  const card = ready(); card.proposedStakeCents = 100; card.decimalOdds = 2.25; card.returnCents = 225; card.profitCents = 125;
  card.selections = [selection('Home', 1.5), selection('Away', 1.5)];
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'fliff.cap.card', cards: [{ book: 'fliff', card }] }), now), /daily_limit_exceeded/);
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
  const card = ready(); card.status = 'research'; card.proposedStakeCents = 0; card.returnCents = null; card.profitCents = null; card.decimalOdds = 2.25; card.plannedStakeCents = 100;
  card.selections = [selection('Home', 1.5), selection('Away', 1.5)];
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'fliff.cap.plan', cards: [{ book: 'fliff', card }] }), now), /daily_limit_exceeded/);
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
test('correct_place supersede and reinsert does not double-count day spend or available cash', () => {
  const event = placed('rebet', 1000); if (event.type !== 'place') return; event.ticket.feesCents = 25;
  let l = applyEvent(ledger(), parseEvent(event), now);
  assert.equal(b(l).availableCents, 8975); assert.equal(b(l).day.spentCents, 1025); assert.equal(b(l).day.stakedCents, 1000); assert.equal(b(l).realizedProfitCents, 0);
  l = applyEvent(l, parseEvent({
    idempotencyKey: 'correct.rebet.same', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Replace the recorded slip with the same stake', placementConfirmed: true, relatedEventId: 'placed.1', supersede: ['ticket.1'], targetCents: 60_000,
    tickets: [{ id: 'ticket.1', stakeCents: 1000, feesCents: 25, decimalOdds: 1.21, selections: [selection(), selection('Away')], tier: 1, placedAt: iso }],
  }), now);
  assert.equal(b(l).availableCents, 8975); assert.equal(b(l).outstandingCents, 1000); assert.equal(b(l).day.spentCents, 1025); assert.equal(b(l).day.stakedCents, 1000);
  assert.equal(b(l).realizedProfitCents, 0); assert.equal(b(l).targetCents, 60_000); assert.equal(b(l).tickets.length, 1); assert.equal(b(l).tickets[0].id, 'ticket.1');
  assert.equal(b(l).tickets[0].status, 'open'); assert.equal(b(l).tickets[0].returnCents, null); assert.equal(b(l).tickets[0].placedAt, iso);
});
test('confirmed placement above the daily cap succeeds when cash, minimum stake, and target allow it', () => {
  let l = applyEvent(ledger(), parseEvent(placed('fliff', 300)), now);
  const extra = placed('fliff', 200); if (extra.type !== 'place') return; extra.ticket.id = 'ticket.overcap'; extra.idempotencyKey = 'placed.overcap';
  l = applyEvent(l, parseEvent(extra), now);
  assert.equal(b(l, 'fliff').availableCents, 9500); assert.equal(b(l, 'fliff').day.spentCents, 500); assert.equal(b(l, 'fliff').outstandingCents, 500);
  l = applyEvent(l, parseEvent({
    idempotencyKey: 'correct.fliff.overcap', type: 'correct_place', book: 'fliff', occurredAt: iso, note: 'Confirmed slip above the research cap', placementConfirmed: true,
    tickets: [{ id: 'ticket.correct.overcap', stakeCents: 200, feesCents: 0, decimalOdds: 2.25, selections: [selection('Home', 1.5), selection('Away', 1.5)], tier: 1 }],
  }), now);
  assert.equal(b(l, 'fliff').availableCents, 9300); assert.equal(b(l, 'fliff').day.spentCents, 700);
});
test('planned stake and ready card still fail the cap and the Polymarket 25% floor', () => {
  const readyOverCap = ready(); readyOverCap.proposedStakeCents = 301; readyOverCap.decimalOdds = 2.25; readyOverCap.returnCents = 677; readyOverCap.profitCents = 376;
  readyOverCap.selections = [selection('Home', 1.5), selection('Away', 1.5)];
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'fliff.ready.cap', cards: [{ book: 'fliff', card: readyOverCap }] }), now), /daily_limit_exceeded/);
  const plannedOverCap = { ...readyOverCap, status: 'research' as const, proposedStakeCents: 0, returnCents: null, profitCents: null, plannedStakeCents: 301 };
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'fliff.plan.cap', cards: [{ book: 'fliff', card: plannedOverCap }] }), now), /daily_limit_exceeded/);
  const small = ready(); small.proposedStakeCents = 2000; small.returnCents = 2420; small.profitCents = 420;
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'pm.ready.floor', cards: [{ book: 'polymarket', card: small }] }), now), /below_minimum_allocation/);
  const plannedSmall = { ...small, status: 'research' as const, proposedStakeCents: 0, returnCents: null, profitCents: null, plannedStakeCents: 2000 };
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'pm.plan.floor', cards: [{ book: 'polymarket', card: plannedSmall }] }), now), /below_minimum_allocation/);
});
test('void restores cash and leaves the placement day spend in place', () => {
  let l = applyEvent(ledger(), parseEvent(placed('fliff', 300)), now);
  l = applyEvent(l, parseEvent({ ...settle('void', 300), book: 'fliff' }), now);
  assert.equal(b(l, 'fliff').availableCents, 10_000); assert.equal(b(l, 'fliff').outstandingCents, 0); assert.equal(b(l, 'fliff').realizedProfitCents, 0);
  assert.equal(b(l, 'fliff').day.spentCents, 300); assert.equal(b(l, 'fliff').day.stakedCents, 300);
});
test('correct_place accepts out-of-range decimal odds and null leg odds', () => {
  const recorded = applyEvent(ledger(), parseEvent({
    idempotencyKey: 'correct.rebet.odds', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Slip price sits outside the research range', placementConfirmed: true,
    tickets: [{ id: 'ticket.wide', stakeCents: 100, feesCents: 0, decimalOdds: 9, selections: [{ ...selection('Home'), odds: null }], tier: 1 }],
  }), now);
  assert.equal(b(recorded).tickets[0].decimalOdds, 9); assert.equal(b(recorded).tickets[0].selections[0].odds, null);
  assert.equal(b(recorded).tickets[0].placedAt, iso); assert.equal(b(recorded).tickets[0].status, 'open'); assert.equal(b(recorded).tickets[0].returnCents, null);
  assert.equal(b(recorded).availableCents, 9900);
});
test('corrected placement timestamps cannot be future or predate the ledger', () => {
  const original = applyEvent(ledger(), parseEvent(placed()), now);
  const event = {
    idempotencyKey: 'correct.timestamp', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Correct the recorded placement time', placementConfirmed: true, supersede: ['ticket.1'],
    tickets: [{ id: 'ticket.1', stakeCents: 1000, feesCents: 0, decimalOdds: 1.21, selections: [selection(), selection('Away')], tier: 1, placedAt: new Date(now.getTime() + 1).toISOString() }],
  };
  assert.throws(() => applyEvent(original, parseEvent(event), now), /future_placement/);
  event.tickets[0].placedAt = '2026-06-10T13:59:00.000Z';
  assert.throws(() => applyEvent(original, parseEvent(event), now), /placement_before_ledger_start/);
  assert.equal(b(original).availableCents, 9000); assert.equal(b(original).tickets[0].placedAt, iso);
});
test('missing exchange fills fail on correct_place', () => {
  const ticket = { id: 'ticket.x', stakeCents: 100, feesCents: 0, decimalOdds: 2, selections: [selection('Home', 2)], tier: 1 as const };
  for (const book of ['polymarket', 'novig', 'novig_credit'] as const) {
    assert.throws(() => parseEvent({ idempotencyKey: `correct.${book}.nofill`, type: 'correct_place', book, occurredAt: iso, note: 'No fills', placementConfirmed: true, tickets: [ticket] }), /exchange_fills_required/);
  }
});
test('the same ticket id can return after supersede', () => {
  let l = applyEvent(ledger(), parseEvent(placed('rebet', 1000)), now);
  l = applyEvent(l, parseEvent({
    idempotencyKey: 'correct.rebet.return', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Reinsert the same id', placementConfirmed: true, supersede: ['ticket.1'],
    tickets: [{ id: 'ticket.1', stakeCents: 800, feesCents: 0, decimalOdds: 1.21, selections: [selection(), selection('Away')], tier: 1, placedAt: iso }],
  }), now);
  assert.equal(b(l).tickets.length, 1); assert.equal(b(l).tickets[0].id, 'ticket.1'); assert.equal(b(l).tickets[0].stakeCents, 800); assert.equal(b(l).availableCents, 9200); assert.equal(b(l).day.spentCents, 800);
  assert.throws(() => applyEvent(l, parseEvent({
    idempotencyKey: 'correct.rebet.dup', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Id still open', placementConfirmed: true,
    tickets: [{ id: 'ticket.1', stakeCents: 100, feesCents: 0, decimalOdds: 1.21, selections: [selection(), selection('Away')], tier: 1 }],
  }), now), /ticket_exists/);
});
test('a settled ticket cannot be superseded', () => {
  let l = applyEvent(ledger(), parseEvent(placed()), now);
  l = applyEvent(l, parseEvent(settle()), now);
  assert.throws(() => applyEvent(l, parseEvent({
    idempotencyKey: 'correct.rebet.settled', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Settled tickets stay put', placementConfirmed: true, supersede: ['ticket.1'],
    tickets: [{ id: 'ticket.1', stakeCents: 1000, feesCents: 0, decimalOdds: 1.21, selections: [selection(), selection('Away')], tier: 1 }],
  }), now), /ticket_closed/);
});
test('a playthrough book at its target can still take a stake up to the target sum', () => {
  const paused = ledger(); b(paused).availableCents = b(paused).targetCents;
  assert.throws(() => applyEvent(paused, parseEvent(placed()), now), /target_reached/);
  const credit = (stake: number, id: string, key: string) => ({ idempotencyKey: key, type: 'place' as const, book: 'novig_credit' as const, occurredAt: iso, note: 'Confirmed playthrough slip', placementConfirmed: true as const, ticket: { id, stakeCents: stake, feesCents: 0, decimalOdds: 2, selections: [selection('Home', 2)], tier: 1 as const, fills: [{ id: `fill.${id}`, quantity: stake / 50, priceCents: 50 }] } });
  assert.equal(b(ledger(), 'novig_credit').availableCents, b(ledger(), 'novig_credit').targetCents);
  let l = applyEvent(ledger(), parseEvent(credit(600, 'credit.1', 'place.credit.1')), now);
  assert.equal(b(l, 'novig_credit').availableCents, 400); assert.equal(b(l, 'novig_credit').outstandingCents, 600);
  l = applyEvent(l, parseEvent({ idempotencyKey: 'deposit.credit', type: 'adjust', book: 'novig_credit', occurredAt: iso, note: 'Test funds', kind: 'deposit', amountCents: 1000 }), now);
  assert.throws(() => applyEvent(l, parseEvent(credit(500, 'credit.2', 'place.credit.2')), now), /target_reached/);
  l = applyEvent(l, parseEvent(credit(400, 'credit.3', 'place.credit.3')), now);
  assert.equal(b(l, 'novig_credit').outstandingCents, 1000);
  assert.equal(b(l, 'novig_credit').tickets.reduce((sum, ticket) => sum + ticket.stakeCents, 0), 1000);
});
function creditProposalLedger() {
  const l = ledger(); const credit = b(l, 'novig_credit');
  credit.openingCents = 2500; credit.availableCents = 2500; credit.targetCents = 2500; credit.day.bankrollCents = 2500;
  credit.policy.maxLegImpliedProbability = .6;
  return l;
}
function creditProposal(status: 'ready' | 'research', stakeCents: number): Card {
  return { ...ready(), status, proposedStakeCents: status === 'ready' ? stakeCents : 0, ...(status === 'research' ? { plannedStakeCents: stakeCents } : {}), decimalOdds: 2, returnCents: status === 'ready' ? stakeCents * 2 : null, profitCents: status === 'ready' ? stakeCents : null, selections: [selection('Credit fixture', 2)] };
}
function publishCredit(l: Ledger, card: Card) {
  return applyCards(l, parseCards({ idempotencyKey: 'credit.card', cards: [{ book: 'novig_credit', card }] }), now);
}
function partialCreditPlacement(l: Ledger) {
  return applyEvent(l, parseEvent({ idempotencyKey: 'credit.partial', type: 'place', book: 'novig_credit', occurredAt: iso, note: 'Confirmed synthetic credit fill', placementConfirmed: true, ticket: { id: 'credit.partial', stakeCents: 1500, feesCents: 0, decimalOdds: 2, selections: [selection('Credit fixture', 2)], tier: 1, fills: [{ id: 'credit.partial.fill', quantity: 30, priceCents: 50 }] } }), now);
}
test('ready and planned credit cards can use an untouched playthrough balance equal to its requirement', () => {
  for (const status of ['ready', 'research'] as const) {
    const l = publishCredit(creditProposalLedger(), creditProposal(status, 2500)); const credit = b(l, 'novig_credit');
    assert.equal(credit.card!.status, status); assert.equal(credit.availableCents, 2500); assert.equal(credit.outstandingCents, 0); assert.equal(credit.day.spentCents, 0);
    assert.equal(status === 'ready' ? credit.card!.proposedStakeCents : credit.card!.plannedStakeCents, 2500);
  }
});
test('credit cards cannot overshoot remaining playthrough even when extra cash is available', () => {
  let l = partialCreditPlacement(creditProposalLedger());
  l = applyEvent(l, parseEvent({ idempotencyKey: 'credit.extra', type: 'adjust', book: 'novig_credit', occurredAt: iso, note: 'Synthetic additional funds', kind: 'deposit', amountCents: 2000 }), now);
  for (const status of ['ready', 'research'] as const) {
    assert.throws(() => publishCredit(l, creditProposal(status, 1001)), /target_reached/);
    assert.equal(b(publishCredit(l, creditProposal(status, 1000)), 'novig_credit').card!.status, status);
  }
});
test('credit proposals retain configured price limits, daily caps, fee accounting and available-cash guards', () => {
  for (const status of ['ready', 'research'] as const) {
    const tooExpensive = creditProposal(status, 500); tooExpensive.decimalOdds = 1.5;
    assert.throws(() => publishCredit(creditProposalLedger(), tooExpensive), /leg_price_outside_range/);
    tooExpensive.decimalOdds = 2; tooExpensive.selections[0].odds = 1.5;
    assert.throws(() => publishCredit(creditProposalLedger(), tooExpensive), /leg_price_outside_range/);
    const capped = creditProposalLedger(); b(capped, 'novig_credit').policy.dailyCapCents = 400;
    assert.throws(() => publishCredit(capped, creditProposal(status, 500)), /daily_limit_exceeded/);
    const allInWithFee = creditProposal(status, 2500); allInWithFee.feesCents = 1;
    assert.throws(() => publishCredit(creditProposalLedger(), allInWithFee), /daily_limit_exceeded/);
    const short = creditProposalLedger(); b(short, 'novig_credit').availableCents = 250;
    assert.throws(() => publishCredit(short, creditProposal(status, 500)), /daily_limit_exceeded/);
  }
});
test('void credit stakes restore unfulfilled playthrough but do not recycle the same-day budget', () => {
  let l = partialCreditPlacement(creditProposalLedger());
  l = applyEvent(l, parseEvent({ ...settle('void', 1500), idempotencyKey: 'credit.void', book: 'novig_credit', ticketId: 'credit.partial' }), now);
  for (const status of ['ready', 'research'] as const) {
    assert.throws(() => publishCredit(l, creditProposal(status, 1001)), /daily_limit_exceeded/);
    assert.equal(b(publishCredit(l, creditProposal(status, 1000)), 'novig_credit').card!.status, status);
  }
});
test('empty correct_place fails', () => {
  assert.throws(() => parseEvent({ idempotencyKey: 'correct.empty', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Nothing to change', placementConfirmed: true }), /empty_correction/);
  assert.throws(() => parseEvent({ idempotencyKey: 'correct.empty.lists', type: 'correct_place', book: 'rebet', occurredAt: iso, note: 'Empty lists', placementConfirmed: true, supersede: [], tickets: [] }), /empty_correction/);
});
test('credit usage history is never pruned to reopen a completed allowance', () => {
  const l = ledger(); const credit = b(l, 'novig_credit');
  credit.tickets = Array.from({ length: 50 }, (_, i) => ({ id: `prior.${i}`, book: 'novig_credit', status: 'won', placedAt: iso, settledAt: iso, stakeCents: 1, feesCents: 0, returnCents: 2, decimalOdds: 2, selections: [selection('Home', 2)] }));
  const event = placed('novig_credit', 100); if (event.type !== 'place') return;
  event.ticket.selections = [selection('Home', 2)]; event.ticket.decimalOdds = 2;
  event.ticket.fills = [{ id: 'fill.new', quantity: 2, priceCents: 50 }];
  assert.throws(() => applyEvent(l, parseEvent(event), now), /playthrough_history_reconciliation_required/);
  assert.equal(credit.tickets.length, 50); assert.equal(credit.availableCents, 1000);
});
test('cards accept the active books including novig credit', () => {
  const card = { date: '2026-06-10', status: 'skip' as const, summary: 'No bet', updatedAt: iso, tier: null, proposedStakeCents: 0, decimalOdds: null, returnCents: null, profitCents: null, selections: [], sources: [], invalidations: ['No bet'] };
  const cards = ['polymarket', 'fliff', 'rebet', 'novig', 'underdog', 'underdog_streaks', 'novig_credit'].map((book) => ({ book, card }));
  assert.equal(parseCards({ idempotencyKey: 'cards.seven', cards }).cards.length, 7);
});
function fixturePolicy(book: BookId, overrides: Record<string, unknown> = {}) {
  return { ...initial().books.find((entry) => entry.id === book)!.policy, ...overrides };
}
function policyEvent(book: BookId, overrides: Record<string, unknown> = {}, k = `policy.${book}`) {
  return { idempotencyKey: k, type: 'update_policy', book, occurredAt: iso, note: 'Guardrail policy update', policy: fixturePolicy(book, overrides) };
}
function plannedCard(stakeCents = 1000, picks: [string, string] = ['Home', 'Away']): Card {
  return { ...ready(), status: 'research', proposedStakeCents: 0, returnCents: null, profitCents: null, plannedStakeCents: stakeCents, selections: [selection(picks[0]), selection(picks[1])] };
}
function skipCard(): Card {
  return { date: '2026-06-10', status: 'skip', summary: 'No bet', updatedAt: iso, tier: null, proposedStakeCents: 0, decimalOdds: null, returnCents: null, profitCents: null, selections: [], sources: [], invalidations: ['No bet'] };
}
test('update_policy changes caps while preserving balances, day spend and tickets; old payloads still parse', () => {
  assert.doesNotThrow(() => parseBootstrap(initial()));
  assert.doesNotThrow(() => parseEvent(policyEvent('rebet')));
  let l = applyEvent(ledger(), parseEvent(placed()), now);
  const before = structuredClone(b(l));
  l = applyEvent(l, parseEvent(policyEvent('rebet', { dailyCapCents: 123, maxOpenTickets: 1 })), now);
  const after = b(l);
  assert.equal(after.policy.dailyCapCents, 123); assert.equal(after.policy.maxOpenTickets, 1);
  assert.equal(after.availableCents, before.availableCents); assert.equal(after.outstandingCents, before.outstandingCents);
  assert.deepEqual(after.day, before.day); assert.deepEqual(after.tickets, before.tickets);
});
test('halted books reject ready and planned cards, allow skip cards, and still record confirmed slips', () => {
  let l = applyEvent(ledger(), parseEvent(policyEvent('rebet', { halted: true })), now);
  assert.equal(visibleState(l, now).books.find((book) => book.id === 'rebet')!.halted, true);
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'halt.ready', cards: [{ book: 'rebet', card: ready() }] }), now), /book_halted/);
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'halt.plan', cards: [{ book: 'rebet', card: plannedCard() }] }), now), /book_halted/);
  l = applyCards(l, parseCards({ idempotencyKey: 'halt.skip', cards: [{ book: 'rebet', card: skipCard() }] }), now);
  assert.equal(b(l).card!.status, 'skip');
  l = applyEvent(l, parseEvent(placed()), now);
  assert.equal(b(l).availableCents, 9000); assert.equal(b(l).outstandingCents, 1000);
});
test('reserve floor blocks a stake that would breach it and allows one landing exactly on it', () => {
  const l = applyEvent(ledger(), parseEvent(policyEvent('rebet', { reserveFloorCents: 9500 })), now);
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'floor.over', cards: [{ book: 'rebet', card: plannedCard(501) }] }), now), /daily_limit_exceeded/);
  const ok = applyCards(l, parseCards({ idempotencyKey: 'floor.exact', cards: [{ book: 'rebet', card: plannedCard(500) }] }), now);
  assert.equal(b(ok).card!.plannedStakeCents, 500); assert.equal(b(ok).availableCents, 10_000);
});
test('tier fractions cap ready stakes by tier', () => {
  const over = ready(); over.tier = 2; over.proposedStakeCents = 6000; over.returnCents = 7260; over.profitCents = 1260;
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'tier2.over', cards: [{ book: 'rebet', card: over }] }), now), /daily_limit_exceeded/);
  const exact = ready(); exact.tier = 2; exact.proposedStakeCents = 5000; exact.returnCents = 6050; exact.profitCents = 1050;
  assert.equal(b(applyCards(ledger(), parseCards({ idempotencyKey: 'tier2.exact', cards: [{ book: 'rebet', card: exact }] }), now)).card!.proposedStakeCents, 5000);
});
test('a settled loss blocks proposals that day and the next Central day, then clears', () => {
  let l = applyEvent(ledger(), parseEvent(placed()), now);
  l = applyEvent(l, parseEvent(settle('lost', 0)), now);
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'cool.today', cards: [{ book: 'rebet', card: plannedCard() }] }), now), /loss_cooldown/);
  const day1 = new Date('2026-06-11T15:00:00Z');
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'cool.next', cards: [{ book: 'rebet', card: { ...plannedCard(), date: '2026-06-11' } }] }), day1), /loss_cooldown/);
  const day2 = new Date('2026-06-12T15:00:00Z');
  const cleared = applyCards(l, parseCards({ idempotencyKey: 'cool.clear', cards: [{ book: 'rebet', card: { ...plannedCard(), date: '2026-06-12' } }] }), day2);
  assert.equal(b(cleared).card!.plannedStakeCents, 1000);
});
test('maxOpenTickets blocks a second proposal while a ticket is open', () => {
  let l = applyEvent(ledger(), parseEvent(policyEvent('rebet', { maxOpenTickets: 1 })), now);
  l = applyEvent(l, parseEvent(placed()), now);
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'open.second', cards: [{ book: 'rebet', card: plannedCard(1000, ['Other', 'Elsewhere']) }] }), now), /too_many_open_tickets/);
});
test('a proposal reusing an event on an open ticket in another book is rejected', () => {
  const l = applyEvent(ledger(), parseEvent(placed()), now);
  const overlap = { ...plannedCard(200), decimalOdds: null, selections: [{ ...selection('Home'), event: ' Fixture HOME ' }, { ...selection('Away'), event: 'Another game' }] };
  assert.throws(() => applyCards(l, parseCards({ idempotencyKey: 'dup.cross', cards: [{ book: 'underdog', card: overlap }] }), now), /duplicate_exposure/);
  const first = plannedCard(200, ['First', 'Second']);
  const second = { ...plannedCard(200), decimalOdds: null, selections: [{ ...selection('First'), event: 'fixture first' }, selection('Third')] };
  assert.throws(() => applyCards(ledger(), parseCards({ idempotencyKey: 'dup.sibling', cards: [{ book: 'rebet', card: first }, { book: 'underdog', card: second }] }), now), /duplicate_exposure/);
});
test('update_policy fails on retired or unknown books', () => {
  let l = applyEvent(ledger(), parseEvent({ idempotencyKey: 'retire.for.policy', type: 'retire_book', book: 'rebet', occurredAt: iso, note: 'Removed' }), now);
  assert.throws(() => applyEvent(l, parseEvent(policyEvent('rebet', { halted: true })), now), /book_retired/);
  const missing = ledger(); missing.books = missing.books.filter((book) => book.id !== 'underdog_streaks');
  assert.throws(() => applyEvent(missing, parseEvent(policyEvent('underdog_streaks', { maxOpenTickets: 1 })), now), /book_not_found/);
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
