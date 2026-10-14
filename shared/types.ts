export const BOOK_IDS = ['polymarket', 'fliff', 'rebet', 'novig', 'novig_credit', 'onyx', 'underdog', 'underdog_streaks'] as const;
export const ACTIVE_BOOK_IDS = ['polymarket', 'fliff', 'rebet', 'novig', 'novig_credit', 'underdog', 'underdog_streaks'] as const;
export type BookId = (typeof BOOK_IDS)[number];
export type ActiveBookId = (typeof ACTIVE_BOOK_IDS)[number];
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
  /** True when this balance is playthrough credit. */
  playthrough?: boolean;
  /** True when desk proposals are halted for this book. Confirmed slips still record. */
  halted?: boolean;
  retired?: boolean;
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
  /** Wagering requirement. Available cash may sit at the target without freezing confirmed placement. */
  playthrough?: boolean;
  /** Desk proposals (ready/planned cards) are rejected while true. Confirmed slips still record. */
  halted?: boolean;
  /** Proposal stakes may not push available below this floor. */
  reserveFloorCents?: number;
  /** Proposal limit on simultaneously open tickets for this book. */
  maxOpenTickets?: number;
}

export interface BootstrapRequest {
  idempotencyKey: string;
  ledgerStart: string;
  books: { id: BookId; name: string; openingCents: number; targetCents: number; policy: BookPolicy }[];
}

interface EventBase {
  idempotencyKey: string;
  book: BookId;
  /** Actual occurrence; earlier placement days require an existing accounting budget. */
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
  | { type: 'retire_book' }
  | { type: 'open_book'; name: string; openingCents: number; targetCents: number; policy: BookPolicy }
  | { type: 'update_policy'; policy: BookPolicy }
  | { type: 'correct_settlement'; appSettlementConfirmed: true; ticketId: string; outcome: 'won' | 'lost' | 'void' | 'cashed_out'; returnCents: number; settlementFeeCents: number; relatedEventId: string }
  | {
    type: 'correct_place';
    placementConfirmed: true;
    relatedEventId?: string;
    supersede?: string[];
    targetCents?: number;
    tickets?: { id: string; stakeCents: number; feesCents: number; decimalOdds: number | null; selections: Selection[]; tier: Tier; fills?: ExchangeFill[]; placedAt?: string }[];
  }
);

export interface PublishCardsRequest {
  idempotencyKey: string;
  cards: { book: BookId; card: Card }[];
}

export interface SessionResponse { token: string; expiresAt: string }
export interface MutationResponse { applied: boolean; state: TrackState }
