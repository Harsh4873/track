import { createHash } from 'node:crypto';
import { BOOK_IDS, type BookId, type BookPolicy, type BookState, type BootstrapRequest, type Card, type ExchangeFill, type LedgerEvent, type PublishCardsRequest, type Selection, type Ticket, type TrackState } from '../../shared/types.js';

export class ApiError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

const MAX_CENTS = 100_000_000;
const EXCHANGE_BOOKS: readonly BookId[] = ['polymarket', 'novig'];
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' });
export function centralDay(now: Date): string { return DAY_FORMAT.format(now); }
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function ensure(condition: unknown, code = 'invalid_request', status = 400): asserts condition { if (!condition) throw new ApiError(status, code); }
function object(value: unknown): asserts value is Record<string, unknown> { ensure(value !== null && typeof value === 'object' && !Array.isArray(value)); }
function text(value: unknown, max = 1000): asserts value is string { ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max); }
function integer(value: unknown, signed = false): asserts value is number { ensure(Number.isSafeInteger(value) && Math.abs(value as number) <= MAX_CENTS && (signed || (value as number) >= 0)); }
function number(value: unknown, min: number, max: number): asserts value is number { ensure(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max); }
function timestamp(value: unknown): asserts value is string { text(value, 40); ensure(/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))); }
function array(value: unknown, max: number): asserts value is unknown[] { ensure(Array.isArray(value) && value.length <= max); }
function bookId(value: unknown): asserts value is BookId { ensure(BOOK_IDS.includes(value as BookId)); }
function key(value: unknown): asserts value is string { text(value, 120); ensure(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)); }
function nullableOdds(value: unknown) { if (value !== null) number(value, 1, 100_000); }
function tier(value: unknown) { ensure(value === 1 || value === 2 || value === 3); }

function validateSelection(value: unknown): asserts value is Selection {
  object(value); text(value.event, 300); text(value.market, 300); text(value.pick, 300);
  timestamp(value.startTime); timestamp(value.quotedAt); nullableOdds(value.odds);
  if (value.sport !== undefined) text(value.sport, 80);
  if (value.settlementRules !== undefined) text(value.settlementRules, 2000);
  if (value.lineupConfirmed !== undefined) ensure(typeof value.lineupConfirmed === 'boolean');
  ensure(!/\btennis\b/i.test(`${value.sport ?? ''} ${value.event} ${value.market}`), 'excluded_sport');
}

function validateSelections(value: unknown): asserts value is Selection[] {
  array(value, 12); ensure(value.length > 0); value.forEach(validateSelection);
  ensure(new Set((value as Selection[]).map((selection) => `${selection.event}|${selection.market}|${selection.pick}`)).size === value.length, 'duplicate_selection');
}

function validateFills(value: unknown): asserts value is ExchangeFill[] {
  array(value, 100); ensure(value.length > 0);
  for (const item of value) { object(item); key(item.id); number(item.quantity, 0.000001, 1_000_000); number(item.priceCents, 0.001, 99.999); }
  ensure(new Set((value as ExchangeFill[]).map((fill) => fill.id)).size === value.length, 'duplicate_fill');
}
function fillCost(fills: ExchangeFill[]): number { return Math.round(fills.reduce((sum, fill) => sum + fill.quantity * fill.priceCents, 0)); }

function validatePolicy(value: unknown, id: BookId): asserts value is BookPolicy {
  object(value);
  if (value.dailyCapCents !== null) integer(value.dailyCapCents);
  number(value.maxBankrollFraction, 0.0001, 1); number(value.minimumBankrollFraction, 0, 1);
  ensure(value.minimumBankrollFraction <= value.maxBankrollFraction);
  array(value.tierFractions, 3); ensure(value.tierFractions.length === 3); value.tierFractions.forEach((n) => number(n, value.minimumBankrollFraction as number, value.maxBankrollFraction as number));
  integer(value.minStakeCents); ensure(value.minStakeCents > 0);
  if (value.minReturn !== null) number(value.minReturn, 1.0001, 1000);
  if (value.maxReturn !== null) number(value.maxReturn, 1.0001, 1000);
  ensure(value.minReturn === null || value.maxReturn === null || (value.minReturn as number) <= (value.maxReturn as number));
  integer(value.minSelections); ensure(value.minSelections >= (id === 'novig' ? 1 : 2) && value.minSelections <= 12);
  if (value.minLegImpliedProbability !== null) number(value.minLegImpliedProbability, 0.001, 0.999);
  if (value.maxLegImpliedProbability !== null) number(value.maxLegImpliedProbability, 0.001, 0.999);
  ensure(value.minLegImpliedProbability === null || value.maxLegImpliedProbability === null || (value.minLegImpliedProbability as number) <= (value.maxLegImpliedProbability as number));
  number(value.quoteMaxAgeMinutes, 1, 120);
}

export function parseBootstrap(value: unknown): BootstrapRequest {
  object(value); key(value.idempotencyKey); timestamp(value.ledgerStart); array(value.books, 6); ensure(value.books.length === 6);
  const ids = new Set<string>();
  for (const entry of value.books) {
    object(entry); bookId(entry.id); ensure(!ids.has(entry.id)); ids.add(entry.id);
    text(entry.name, 60); integer(entry.openingCents); integer(entry.targetCents); ensure(entry.targetCents > 0);
    validatePolicy(entry.policy, entry.id);
  }
  return value as unknown as BootstrapRequest;
}

export function parseEvent(value: unknown): LedgerEvent {
  object(value); key(value.idempotencyKey); bookId(value.book); timestamp(value.occurredAt); text(value.note, 2000);
  switch (value.type) {
    case 'place': {
      ensure(value.placementConfirmed === true, 'placement_confirmation_required'); object(value.ticket);
      key(value.ticket.id); integer(value.ticket.stakeCents); ensure(value.ticket.stakeCents > 0); integer(value.ticket.feesCents);
      nullableOdds(value.ticket.decimalOdds); validateSelections(value.ticket.selections); tier(value.ticket.tier);
      if (value.ticket.fills !== undefined) validateFills(value.ticket.fills);
      if (EXCHANGE_BOOKS.includes(value.book)) ensure(value.ticket.fills !== undefined, 'exchange_fills_required');
      break;
    }
    case 'fill': key(value.ticketId); ensure(value.placementConfirmed === true, 'placement_confirmation_required'); validateFills(value.fills); integer(value.feesCents); ensure(EXCHANGE_BOOKS.includes(value.book), 'not_exchange'); break;
    case 'result': key(value.ticketId); text(value.resultNote, 2000); break;
    case 'settle':
    case 'correct_settlement':
      key(value.ticketId); ensure(value.appSettlementConfirmed === true, 'settlement_confirmation_required');
      ensure(['won', 'lost', 'void', 'cashed_out'].includes(value.outcome as string)); integer(value.returnCents); integer(value.settlementFeeCents); ensure(value.settlementFeeCents <= value.returnCents);
      if (value.outcome === 'lost') ensure(value.returnCents === 0 && value.settlementFeeCents === 0, 'invalid_loss_return');
      if (value.type === 'correct_settlement') key(value.relatedEventId);
      break;
    case 'adjust': ensure(['deposit', 'withdrawal', 'correction'].includes(value.kind as string)); integer(value.amountCents, true); ensure(value.amountCents !== 0); if (value.kind === 'deposit') ensure(value.amountCents > 0); if (value.kind === 'withdrawal') ensure(value.amountCents < 0); if (value.kind === 'correction') key(value.relatedEventId); break;
    default: throw new ApiError(400, 'invalid_event');
  }
  return value as unknown as LedgerEvent;
}

export function parseCards(value: unknown): PublishCardsRequest {
  object(value); key(value.idempotencyKey); array(value.cards, 6); ensure(value.cards.length > 0);
  const ids = new Set<string>();
  for (const entry of value.cards) {
    object(entry); bookId(entry.book); ensure(!ids.has(entry.book)); ids.add(entry.book); object(entry.card);
    const card = entry.card; text(card.date, 10); ensure(/^\d{4}-\d{2}-\d{2}$/.test(card.date)); ensure(['ready', 'skip', 'research'].includes(card.status as string));
    text(card.summary, 3000); timestamp(card.updatedAt); if (card.tier !== null) tier(card.tier);
    integer(card.proposedStakeCents); if (card.minimumStakeCents !== undefined) integer(card.minimumStakeCents); if (card.feesCents !== undefined) integer(card.feesCents); nullableOdds(card.decimalOdds); if (card.returnCents !== null) integer(card.returnCents); if (card.profitCents !== null) integer(card.profitCents, true);
    array(card.selections, 12); if (card.selections.length > 0) validateSelections(card.selections);
    array(card.invalidations, 20); card.invalidations.forEach((item) => text(item, 1000));
    array(card.sources, 20);
    for (const source of card.sources) { object(source); text(source.label, 200); text(source.url, 2000); let url: URL; try { url = new URL(source.url); } catch { throw new ApiError(400, 'invalid_source'); } ensure(url.protocol === 'https:' && !url.username && !url.password, 'invalid_source'); }
    if (card.verification !== undefined) {
      object(card.verification);
      for (const field of ['actualAppPrice', 'settlementRules', 'essentialLineups', 'combinedPrice', 'correlationReviewed']) ensure(typeof card.verification[field] === 'boolean');
      if (card.verification.jurisdiction !== undefined) ensure(card.verification.jurisdiction === 'US');
    }
    if (card.status !== 'ready') ensure(card.proposedStakeCents === 0 && card.returnCents === null && card.profitCents === null, 'nonready_card_cannot_stake');
  }
  return value as unknown as PublishCardsRequest;
}

export interface DayBudget { date: string; bankrollCents: number; spentCents: number; stakedCents: number }
export interface InternalBook extends BookState { policy: BookPolicy; day: DayBudget; budgets?: Record<string, DayBudget> }
export interface Ledger { updatedAt: string; ledgerStart: string; books: InternalBook[]; settlementFees: Record<string, number> }

export function bootstrap(input: BootstrapRequest, now: Date): Ledger {
  ensure(Date.parse(input.ledgerStart) <= now.getTime() + 60_000, 'future_ledger');
  return {
    ledgerStart: input.ledgerStart, updatedAt: now.toISOString(), settlementFees: {},
    books: BOOK_IDS.map((id) => {
      const initial = input.books.find((book) => book.id === id)!;
      return { ...initial, availableCents: initial.openingCents, outstandingCents: 0, realizedProfitCents: 0, dailyStakedCents: 0, tickets: [], card: null,
        day: { date: centralDay(now), bankrollCents: initial.openingCents, spentCents: 0, stakedCents: 0 } };
    }),
  };
}

function rollDay(book: InternalBook, now: Date): void {
  book.budgets ??= {};
  book.budgets[book.day.date] = book.day;
  if (book.day.date !== centralDay(now)) book.day = book.budgets[centralDay(now)] ?? { date: centralDay(now), bankrollCents: book.availableCents, spentCents: 0, stakedCents: 0 };
  book.budgets[book.day.date] = book.day;
  book.dailyStakedCents = book.day.stakedCents;
}

function stakeLimit(book: InternalBook): number {
  return Math.max(0, Math.min(book.availableCents, Math.floor(book.day.bankrollCents * book.policy.maxBankrollFraction) - book.day.spentCents, (book.policy.dailyCapCents ?? MAX_CENTS) - book.day.spentCents));
}

function validateStake(book: InternalBook, stakeCents: number, feesCents: number, initial = true): void {
  const cost = stakeCents + feesCents;
  ensure(book.availableCents < book.targetCents, 'target_reached', 409);
  ensure(!initial || stakeCents >= book.policy.minStakeCents, 'below_minimum_stake');
  ensure(cost <= stakeLimit(book), 'daily_limit_exceeded', 409);
  ensure(!initial || cost >= Math.ceil(book.day.bankrollCents * book.policy.minimumBankrollFraction), 'below_minimum_allocation');
}

function validateMarket(book: InternalBook, selections: Selection[], decimalOdds: number | null): void {
  ensure(selections.length >= book.policy.minSelections, 'insufficient_selections');
  ensure(decimalOdds !== null, 'accepted_price_required');
  if (book.policy.minReturn !== null) ensure(decimalOdds + 1e-8 >= book.policy.minReturn, 'return_outside_range');
  if (book.policy.maxReturn !== null) ensure(decimalOdds - 1e-8 <= book.policy.maxReturn, 'return_outside_range');
  for (const selection of selections) {
    if (book.policy.minLegImpliedProbability !== null || book.policy.maxLegImpliedProbability !== null) {
      ensure(selection.odds !== null, 'leg_price_required');
      const implied = 1 / selection.odds;
      if (book.policy.minLegImpliedProbability !== null) ensure(implied + 1e-8 >= book.policy.minLegImpliedProbability, 'leg_price_outside_range');
      if (book.policy.maxLegImpliedProbability !== null) ensure(implied - 1e-8 <= book.policy.maxLegImpliedProbability, 'leg_price_outside_range');
    }
  }
}

function validateReadyCard(book: InternalBook, card: Card, now: Date): void {
  ensure(card.tier !== null && card.sources.length > 0 && card.invalidations.length > 0, 'incomplete_research');
  const check = card.verification;
  ensure(check?.actualAppPrice && check.settlementRules && check.essentialLineups && check.combinedPrice && check.correlationReviewed, 'unverified_card');
  if (book.id === 'polymarket') ensure(check.jurisdiction === 'US', 'us_contract_required');
  ensure(card.minimumStakeCents !== undefined && card.minimumStakeCents > 0 && card.proposedStakeCents >= card.minimumStakeCents, 'verified_minimum_stake_required');
  ensure(card.feesCents !== undefined, 'fees_required');
  validateStake(book, card.proposedStakeCents, card.feesCents);
  validateMarket(book, card.selections, card.decimalOdds);
  for (const selection of card.selections) {
    ensure(selection.sport && selection.settlementRules && selection.lineupConfirmed === true, 'incomplete_selection');
    ensure(Date.parse(selection.startTime) > now.getTime(), 'market_started');
    const age = now.getTime() - Date.parse(selection.quotedAt);
    ensure(age >= -60_000 && age <= book.policy.quoteMaxAgeMinutes * 60_000, 'stale_quote');
  }
  ensure(card.returnCents === Math.round(card.proposedStakeCents * card.decimalOdds!), 'return_mismatch');
  ensure(card.profitCents === card.returnCents - card.proposedStakeCents - card.feesCents, 'profit_mismatch');
}

function findTicket(book: InternalBook, id: string): Ticket {
  const ticket = book.tickets.find((item) => item.id === id); ensure(ticket, 'ticket_not_found', 404); return ticket;
}
function isOpen(ticket: Ticket): boolean { return ticket.status === 'open' || ticket.status === 'result_pending'; }

export function applyEvent(previous: Ledger, event: LedgerEvent, now: Date): Ledger {
  const ledger = structuredClone(previous);
  ensure(Date.parse(event.occurredAt) <= now.getTime() + 60_000, 'future_event');
  ensure(Date.parse(event.occurredAt) >= Date.parse(ledger.ledgerStart), 'before_ledger_start');
  const book = ledger.books.find((item) => item.id === event.book)!; rollDay(book, now);
  const currentBudget = book.day;
  const eventDay = centralDay(new Date(event.occurredAt));
  const latePlacement = ['place', 'fill'].includes(event.type) && eventDay !== currentBudget.date;
  const availableBefore = book.availableCents;
  if (latePlacement) {
    ensure(book.budgets?.[eventDay], 'historical_day_requires_reconciliation', 409);
    book.day = book.budgets[eventDay];
  }
  switch (event.type) {
    case 'place': {
      ensure(!book.tickets.some((ticket) => ticket.id === event.ticket.id), 'ticket_exists', 409);
      // Keep the Firestore state document bounded; the event journal retains every ticket.
      while (book.tickets.length >= 50) { const index = book.tickets.findIndex((ticket) => !isOpen(ticket)); ensure(index >= 0, 'too_many_open_tickets', 409); book.tickets.splice(index, 1); }
      validateStake(book, event.ticket.stakeCents, event.ticket.feesCents); validateMarket(book, event.ticket.selections, event.ticket.decimalOdds);
      if (event.ticket.fills) ensure(fillCost(event.ticket.fills) === event.ticket.stakeCents, 'fill_cost_mismatch');
      const ticket: Ticket = { ...event.ticket, book: book.id, status: 'open', placedAt: event.occurredAt, returnCents: null };
      book.tickets.push(ticket); book.availableCents -= ticket.stakeCents + ticket.feesCents; book.outstandingCents += ticket.stakeCents;
      book.day.spentCents += ticket.stakeCents + ticket.feesCents; book.day.stakedCents += ticket.stakeCents;
      break;
    }
    case 'fill': {
      const ticket = findTicket(book, event.ticketId); ensure(isOpen(ticket), 'ticket_closed', 409);
      const existing = new Set((ticket.fills ?? []).map((fill) => fill.id)); ensure(event.fills.every((fill) => !existing.has(fill.id)), 'duplicate_fill', 409);
      const fills = [...(ticket.fills ?? []), ...event.fills]; ensure(fills.length <= 100, 'too_many_fills');
      const additional = fillCost(fills) - ticket.stakeCents; ensure(additional >= 0, 'fill_cost_mismatch'); validateStake(book, additional, event.feesCents, false);
      ticket.fills = fills; ticket.stakeCents += additional; ticket.feesCents += event.feesCents;
      book.availableCents -= additional + event.feesCents; book.outstandingCents += additional; book.day.spentCents += additional + event.feesCents; book.day.stakedCents += additional;
      break;
    }
    case 'result': { const ticket = findTicket(book, event.ticketId); ensure(isOpen(ticket), 'ticket_closed', 409); ticket.status = 'result_pending'; ticket.resultNote = event.resultNote; break; }
    case 'settle':
    case 'correct_settlement': {
      const ticket = findTicket(book, event.ticketId); const correction = event.type === 'correct_settlement';
      ensure(correction ? !isOpen(ticket) : isOpen(ticket), correction ? 'ticket_not_settled' : 'ticket_closed', 409);
      const feeKey = `${book.id}:${ticket.id}`; const oldSettlementFee = ledger.settlementFees[feeKey] ?? 0;
      const oldCredit = correction ? (ticket.returnCents ?? 0) - oldSettlementFee : 0;
      const newCredit = event.returnCents - event.settlementFeeCents;
      ensure(book.availableCents + newCredit - oldCredit >= 0, 'insufficient_balance_for_correction', 409);
      const placementFees = ticket.feesCents - oldSettlementFee;
      book.availableCents += newCredit - oldCredit;
      book.realizedProfitCents += correction ? newCredit - oldCredit : newCredit - ticket.stakeCents - placementFees;
      if (!correction) book.outstandingCents -= ticket.stakeCents;
      ticket.feesCents = placementFees + event.settlementFeeCents; ticket.returnCents = event.returnCents; ticket.status = event.outcome; ticket.settledAt = event.occurredAt; ticket.resultNote = event.note;
      ledger.settlementFees[feeKey] = event.settlementFeeCents;
      break;
    }
    case 'adjust':
      ensure(book.availableCents + event.amountCents >= 0, 'insufficient_balance', 409);
      book.availableCents += event.amountCents;
      break;
  }
  integer(book.availableCents); integer(book.outstandingCents); integer(book.realizedProfitCents, true);
  if (latePlacement) { currentBudget.bankrollCents = Math.max(0, currentBudget.bankrollCents - (availableBefore - book.availableCents)); book.day = currentBudget; }
  book.dailyStakedCents = book.day.stakedCents; ledger.updatedAt = now.toISOString();
  return ledger;
}

export function applyCards(previous: Ledger, input: PublishCardsRequest, now: Date): Ledger {
  const ledger = structuredClone(previous);
  for (const entry of input.cards) {
    const book = ledger.books.find((item) => item.id === entry.book)!; rollDay(book, now);
    ensure(entry.card.date === centralDay(now), 'card_day_mismatch');
    if (entry.card.status === 'ready') validateReadyCard(book, entry.card, now);
    book.card = { ...entry.card, updatedAt: now.toISOString() };
  }
  ledger.updatedAt = now.toISOString(); return ledger;
}

export function visibleState(ledger: Ledger | null, now: Date): TrackState {
  if (!ledger) return { updatedAt: null, ledgerStart: null, books: [] };
  return { updatedAt: ledger.updatedAt, ledgerStart: ledger.ledgerStart, books: ledger.books.map((internal) => {
    const { policy, day, budgets, ...book } = structuredClone(internal); book.dailyStakedCents = day.date === centralDay(now) ? day.stakedCents : 0;
    if (book.card?.status === 'ready') {
      const stale = book.card.date !== centralDay(now) || book.card.selections.some((selection) => Date.parse(selection.startTime) <= now.getTime() || now.getTime() - Date.parse(selection.quotedAt) > policy.quoteMaxAgeMinutes * 60_000);
      if (stale) book.card = { ...book.card, status: 'research', proposedStakeCents: 0, returnCents: null, profitCents: null, summary: `Recheck required. ${book.card.summary}` };
    }
    return book;
  }) };
}
