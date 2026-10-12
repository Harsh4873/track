export const BOOK_IDS = ['polymarket', 'fliff', 'rebet', 'novig', 'onyx', 'underdog'] as const;
export type BookId = (typeof BOOK_IDS)[number];
export type Tier = 1 | 2 | 3;

export interface Selection {
  event: string;
  market: string;
  pick: string;
  startTime: string;
  odds: number | null;
  quotedAt: string;
  sport?: string;
  settlementRules?: string;
  lineupConfirmed?: boolean;
  quoteBasis?: 'app' | 'comparison';
  quoteSource?: string;
}

export interface Card {
  date: string;
  status: 'ready' | 'skip' | 'research';
  summary: string;
  updatedAt: string;
  tier: Tier | null;
  proposedStakeCents: number;
  /** Research cards only: the stake to use once the owner sees an acceptable app quote. It never moves funds. */
  plannedStakeCents?: number;
  minimumStakeCents?: number;
  feesCents?: number;
  decimalOdds: number | null;
  returnCents: number | null;
  profitCents: number | null;
  selections: Selection[];
  sources: { label: string; url: string }[];
  invalidations: string[];
  /** The actual app quote, settlement rules and essential lineup checks are complete. */
  verification?: { actualAppPrice: boolean; settlementRules: boolean; essentialLineups: boolean; combinedPrice: boolean; correlationReviewed: boolean; jurisdiction?: 'US' };
}

export interface ExchangeFill {
  id: string;
  quantity: number;
  priceCents: number;
}

export interface Ticket {
  id: string;
  book: BookId;
  status: 'open' | 'result_pending' | 'won' | 'lost' | 'void' | 'cashed_out';
  placedAt: string;
  stakeCents: number;
  feesCents: number;
  returnCents: number | null;
  decimalOdds: number | null;
  selections: Selection[];
  tier?: Tier;
  fills?: ExchangeFill[];
  resultNote?: string;
  settledAt?: string;
}

export interface BookState {
  id: BookId;
  name: string;
  openingCents: number;
  targetCents: number;
  availableCents: number;
  outstandingCents: number;
  realizedProfitCents: number;
  dailyStakedCents: number;
  tickets: Ticket[];
  card: Card | null;
  lastBalanceReport?: {
    reportedAt: string;
    availableCents: number;
    previousAvailableCents: number;
    changeCents: number;
    note: string;
    establishedDayBaseline: boolean;
  };
}

export interface TrackState {
  updatedAt: string | null;
  ledgerStart: string | null;
  books: BookState[];
}

export interface BookPolicy {
  dailyCapCents: number | null;
  maxBankrollFraction: number;
  minimumBankrollFraction: number;
  tierFractions: [number, number, number];
  minStakeCents: number;
  minReturn: number | null;
  maxReturn: number | null;
  minSelections: number;
  minLegImpliedProbability: number | null;
  maxLegImpliedProbability: number | null;
  quoteMaxAgeMinutes: number;
}

export interface BootstrapRequest {
  idempotencyKey: string;
  ledgerStart: string;
  books: { id: BookId; name: string; openingCents: number; targetCents: number; policy: BookPolicy }[];
}

interface EventBase {
  idempotencyKey: string;
  book: BookId;
  /** Actual occurrence; events may not be backdated into a previous accounting day. */
  occurredAt: string;
  note: string;
}

export type LedgerEvent = EventBase & (
  | { type: 'place'; placementConfirmed: true; ticket: { id: string; stakeCents: number; feesCents: number; decimalOdds: number | null; selections: Selection[]; tier: Tier; fills?: ExchangeFill[] } }
  | { type: 'fill'; placementConfirmed: true; ticketId: string; fills: ExchangeFill[]; feesCents: number }
  | { type: 'result'; ticketId: string; resultNote: string }
  | { type: 'settle'; appSettlementConfirmed: true; ticketId: string; outcome: 'won' | 'lost' | 'void' | 'cashed_out'; returnCents: number; settlementFeeCents: number }
  | { type: 'adjust'; kind: 'deposit' | 'withdrawal' | 'correction'; amountCents: number; relatedEventId?: string }
  | { type: 'balance_report'; availableCents: number; previousAvailableCents: number; establishDayBaseline?: boolean }
  | { type: 'correct_settlement'; appSettlementConfirmed: true; ticketId: string; outcome: 'won' | 'lost' | 'void' | 'cashed_out'; returnCents: number; settlementFeeCents: number; relatedEventId: string }
);

export interface PublishCardsRequest {
  idempotencyKey: string;
  cards: { book: BookId; card: Card }[];
}

export interface SessionResponse { token: string; expiresAt: string }
export interface MutationResponse { applied: boolean; state: TrackState }
