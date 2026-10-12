import './style.css';
import type { BookState, Card, Selection, Ticket, TrackState } from '../shared/types';
import { age, americanOdds, calendarDate, money, progress, safeSourceUrl, signedMoney, timestamp } from './presentation';
import { initTheme, themeToggle } from './theme';

type Child = Node | string | null | undefined;
type Session = { token: string; expiresAt: string };

const API = (import.meta.env.VITE_TRACK_API_URL || 'https://trackapi-5ofllh7vvq-uc.a.run.app').replace(/\/$/, '');
const root = document.querySelector<HTMLDivElement>('#app')!;
const bookOrder = ['polymarket', 'fliff', 'rebet', 'novig', 'onyx', 'underdog'];
const bookNames: Record<string, string> = { polymarket: 'Polymarket US', fliff: 'Fliff', rebet: 'Rebet', novig: 'Novig', onyx: 'Onyx', underdog: 'Underdog' };
let session: Session | null = null;
let state: TrackState | null = null;
let activeBook = 'polymarket';
let refreshing = false;
let refreshError = '';
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let refreshController: AbortController | undefined;
let lockMessage = '';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  for (const child of children) if (child !== null && child !== undefined) element.append(child);
  return element;
}

function text(tag: 'p' | 'h1' | 'h2' | 'h3' | 'span' | 'strong' | 'small', value: string, className = '') {
  return el(tag, className, value);
}

function button(label: string, className: string, action: () => void): HTMLButtonElement {
  const control = el('button', className, label);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}

function brand() {
  const mark = el('span', 'brand-mark', 't');
  mark.setAttribute('aria-hidden', 'true');
  return el('div', 'brand', mark, text('span', 'track', 'brand-name'));
}

function footer() {
  return el('footer', 'site-footer', text('span', 'A private record. A clearer picture.'), text('span', 'All times Central · USD'));
}

function banner(message: string, tone = 'warning') {
  const element = el('div', `notice notice-${tone}`, message);
  element.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  return element;
}

function setLock(message = '', focus = false) {
  session = null;
  state = null;
  refreshError = '';
  lockMessage = message;
  refreshController?.abort();
  refreshController = undefined;
  clearTimeout(expiryTimer);
  document.title = 'Track · Private journal';
  renderLock(focus);
}

function renderLock(focus = false) {
  const input = el('input', 'pin-input');
  input.id = 'pin';
  input.name = 'pin';
  input.type = 'password';
  input.inputMode = 'numeric';
  input.autocomplete = 'off';
  input.pattern = '[0-9]+';
  input.minLength = 4;
  input.maxLength = 12;
  input.required = true;
  input.placeholder = 'Enter your code';
  input.setAttribute('aria-describedby', 'unlock-description unlock-status');
  const label = el('label', 'field-label', 'Access code');
  label.htmlFor = 'pin';
  const submit = el('button', 'button button-primary unlock-button', 'Open journal', el('span', 'button-arrow', '↗'));
  submit.type = 'submit';
  const status = el('p', 'form-status', lockMessage);
  status.id = 'unlock-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const description = text('p', 'Your cards, balances and results, together in one private place.', 'lock-description');
  description.id = 'unlock-description';
  const form = el('form', 'unlock-form', label, input, submit, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    input.disabled = true;
    submit.replaceChildren('Opening…');
    status.textContent = '';
    try {
      const response = await request('/v1/session', { method: 'POST', body: JSON.stringify({ pin: input.value }) }, null);
      input.value = '';
      const result = await response.json() as Session;
      const expiry = new Date(result.expiresAt).getTime();
      if (typeof result.token !== 'string' || !result.token || !Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Could not open the journal. Please try again.');
      session = result;
      lockMessage = '';
      expiryTimer = setTimeout(() => setLock('Your session expired. Enter your code to reopen the journal.', true), Math.min(expiry - Date.now(), 2_147_483_647));
      renderJournal();
      await refresh();
    } catch (error) {
      input.value = '';
      if (session) return;
      status.textContent = error instanceof Error ? error.message : 'Could not open the journal. Please try again.';
      submit.disabled = false;
      input.disabled = false;
      submit.replaceChildren('Open journal', el('span', 'button-arrow', '↗'));
      input.focus();
    }
  });
  const header = el('header', 'site-header lock-header', brand(), el('div', 'header-actions', text('span', 'PRIVATE JOURNAL', 'eyebrow header-label'), themeToggle()));
  const lockIcon = el('span', 'lock-icon', '↗');
  lockIcon.setAttribute('aria-hidden', 'true');
  const panel = el('section', 'unlock-panel', lockIcon, text('p', 'THE DAILY DESK', 'eyebrow'), text('h1', 'Every move.\nIn perspective.'), description, form, text('p', 'Your code is checked securely. Records stay locked until you open them.', 'privacy-note'));
  const aside = el('aside', 'lock-aside', el('div', 'quiet-lines', el('span'), el('span'), el('span'), el('span'), el('span')), text('p', 'Proposed.\nPlaced.\nSettled.', 'lock-motto'), text('p', 'A journal that keeps the difference clear.', 'lock-aside-note'));
  root.replaceChildren(el('div', 'site-shell lock-shell', header, el('main', 'lock-main', panel, aside), footer()));
  if (focus) input.focus();
}

async function request(path: string, init: RequestInit = {}, token: string | null = session?.token ?? null): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('X-Track-Authorization', `Bearer ${token}`);
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store', signal: init.signal ?? AbortSignal.timeout(20_000) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The journal could not connect. Check your connection and try again.');
  }
  if (response.ok) return response;
  if (response.status === 401 || response.status === 403) {
    if (token) {
      setLock('Your session ended. Enter your code to reopen the journal.', true);
      throw new Error('Session ended.');
    }
    throw new Error('That code was not accepted. Please try again.');
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Try again in ${Math.ceil(retryAfter / 60)} minute${Math.ceil(retryAfter / 60) === 1 ? '' : 's'}.` : ' Please wait before trying again.';
    throw new Error(`Too many attempts.${wait}`);
  }
  throw new Error('The journal is temporarily unavailable. Please try again shortly.');
}

async function lock() {
  const token = session?.token;
  setLock('', true);
  if (!token) return;
  try { await request('/v1/session', { method: 'DELETE' }, token); } catch { /* Local records are already cleared. */ }
}

async function refresh() {
  if (!session || refreshing) return;
  refreshing = true;
  const token = session.token;
  const controller = new AbortController();
  refreshController = controller;
  const timer = setTimeout(() => controller.abort(), 20_000);
  updateRefreshControl();
  try {
    const response = await request('/v1/state', { signal: controller.signal }, token);
    const result = await response.json() as TrackState;
    if (!Array.isArray(result.books)) throw new Error('The journal returned an incomplete update. Please retry.');
    if (!session || session.token !== token) return;
    state = result;
    refreshError = '';
  } catch (error) {
    if (!session || session.token !== token) return;
    refreshError = error instanceof DOMException && error.name === 'AbortError' ? 'The update took too long. Please retry.' : error instanceof Error ? error.message : 'The journal could not refresh. Please retry.';
  } finally {
    clearTimeout(timer);
    refreshing = false;
    if (refreshController === controller) refreshController = undefined;
    if (session?.token === token) renderJournal();
  }
}

function updateRefreshControl() {
  const control = document.querySelector<HTMLButtonElement>('#refresh');
  if (control) { control.disabled = refreshing; control.textContent = refreshing ? 'Refreshing…' : 'Refresh'; }
}

function renderJournal() {
  if (!session) return;
  const previousFocus = document.activeElement?.id;
  document.title = 'Track · Your journal';
  const refreshButton = button(refreshing ? 'Refreshing…' : 'Refresh', 'button button-quiet', () => void refresh());
  refreshButton.id = 'refresh';
  refreshButton.disabled = refreshing;
  const header = el('header', 'site-header', brand(), el('div', 'header-actions', text('span', 'PRIVATE', 'privacy-badge'), button('Lock journal', 'button button-quiet', () => void lock()), themeToggle()));
  const title = el('div', 'page-heading', el('div', '', text('p', 'THE DAILY DESK', 'eyebrow'), text('h1', 'Your journal.'), text('p', 'Clear records. Considered decisions.', 'page-subtitle')), el('div', 'sync-block', text('span', age(state?.updatedAt), 'sync-age'), text('small', state?.updatedAt ? timestamp(state.updatedAt) : 'Records load after the first sync', 'muted'), refreshButton));
  const main = el('main', 'journal-main', title);
  if (refreshError) main.append(banner(`${refreshError}${state ? ' Showing the last retrieved record. Recheck current prices before acting.' : ''}`, 'error'));
  if (!state) {
    main.append(el('section', 'empty-panel', text('span', '○', 'empty-symbol'), text('h2', refreshError ? 'Waiting for your records' : 'Opening your journal'), text('p', refreshError ? 'Your private data will appear when the connection is restored. Use Refresh to try again.' : 'Retrieving your cards, balances and ticket history.', 'muted')));
  } else if (state.books.length === 0) {
    main.append(el('section', 'empty-panel', text('span', '○', 'empty-symbol'), text('h2', 'A fresh page'), text('p', 'The journal is unlocked. Opening balances and the first card will appear after the initial sync.', 'muted')));
  } else {
    const books = [...state.books].sort((a, b) => bookOrder.indexOf(a.id) - bookOrder.indexOf(b.id));
    if (!books.some((book) => book.id === activeBook)) activeBook = books[0].id;
    const tabs = el('div', 'book-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Choose a ledger');
    books.forEach((book, index) => {
      const tab = button(book.name || bookNames[book.id] || book.id, 'book-tab', () => selectBook(book.id));
      tab.id = `tab-${book.id}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(book.id === activeBook));
      tab.setAttribute('aria-controls', `panel-${book.id}`);
      tab.tabIndex = book.id === activeBook ? 0 : -1;
      tab.addEventListener('keydown', (event) => {
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % books.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + books.length) % books.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = books.length - 1;
        else return;
        event.preventDefault();
        selectBook(books[next].id);
      });
      tabs.append(tab);
    });
    main.append(tabs, renderBook(books.find((book) => book.id === activeBook)!));
    const ledgerNote = el('div', 'ledger-note', text('span', 'A FRESH START', 'eyebrow'), text('p', `${state.ledgerStart ? `Records begin ${calendarDate(state.ledgerStart)}. ` : ''}Opening balances are user-reported; earlier tickets are excluded. Recommendations stay proposed until a placed slip is confirmed. Updates are maintained for you; share new tickets in the chat.`));
    main.append(ledgerNote);
  }
  root.replaceChildren(el('div', 'site-shell', header, main, footer()));
  if (previousFocus) document.getElementById(previousFocus)?.focus({ preventScroll: true });
}

function selectBook(id: string) {
  activeBook = id;
  renderJournal();
  const tab = document.getElementById(`tab-${id}`);
  tab?.focus({ preventScroll: true });
  tab?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

function renderBook(book: BookState) {
  const panel = el('section', 'book-panel');
  panel.id = `panel-${book.id}`;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${book.id}`);
  panel.tabIndex = 0;
  const equity = book.availableCents;
  const pct = progress(book.availableCents, 0, book.targetCents);
  const balance = el('section', 'balance-panel', el('div', 'balance-main', text('p', 'AVAILABLE BALANCE', 'eyebrow'), text('p', money(book.availableCents), 'balance-value'), text('p', 'Recorded funds available to use', 'muted')));
  const metric = (label: string, value: string, note: string, tone = '') => el('div', `metric ${tone}`, text('p', label, 'metric-label'), text('p', value, 'metric-value'), text('p', note, 'metric-note'));
  balance.append(el('div', 'balance-metrics', metric('Outstanding', money(book.outstandingCents), 'Staked on unsettled tickets'), metric('Realized P&L', signedMoney(book.realizedProfitCents), 'Settled results, including fees', book.realizedProfitCents > 0 ? 'positive' : book.realizedProfitCents < 0 ? 'negative' : ''), metric('Staked today', money(book.dailyStakedCents), 'Across all confirmed tickets')));
  const progressBar = el('div', 'goal-bar', el('span', 'goal-fill'));
  (progressBar.firstElementChild as HTMLElement).style.width = `${pct}%`;
  progressBar.setAttribute('role', 'progressbar');
  progressBar.setAttribute('aria-label', 'Progress toward growth goal');
  progressBar.setAttribute('aria-valuemin', '0');
  progressBar.setAttribute('aria-valuemax', '100');
  progressBar.setAttribute('aria-valuenow', pct.toFixed(1));
  progressBar.setAttribute('aria-valuetext', `${money(equity)} available toward ${money(book.targetCents)}`);
  const goal = el('div', 'goal-row', el('div', 'goal-copy', text('span', 'Growth goal', 'metric-label'), text('span', `${money(equity)} / ${money(book.targetCents)}`, 'goal-amount')), progressBar, text('span', pct >= 100 ? 'Goal reached · time to reassess' : 'Available balance · no deadline', 'goal-caption'));
  balance.append(goal);
  panel.append(balance);
  if (book.lastBalanceReport) {
    const report = book.lastBalanceReport;
    panel.append(text('p', `Last reported balance: ${money(report.availableCents)} · ${timestamp(report.reportedAt)}. Balance adjustments are excluded from realized P&L.`, 'ledger-note'));
  }
  const pending = book.tickets.filter((ticket) => ticket.status === 'result_pending').length;
  if (pending > 0) panel.append(banner(`${pending} ticket${pending === 1 ? ' is' : 's are'} awaiting confirmed app settlement. Expected returns are not available funds.`));
  panel.append(el('div', 'detail-grid', renderCard(book.card), renderHistory(book.tickets)));
  return panel;
}

function sectionHeader(kicker: string, title: string, side?: Child) {
  return el('div', 'section-heading', el('div', '', text('p', kicker, 'eyebrow'), text('h2', title)), side);
}

function renderCard(card: Card | null) {
  const section = el('section', 'detail-panel card-panel');
  if (!card) {
    section.append(sectionHeader('THE CARD', 'Nothing proposed yet'), el('div', 'card-empty', text('span', '—', 'empty-symbol'), text('p', 'The next research update will appear here.', 'empty-title'), text('p', 'A clear no-bet decision is part of the record, too.', 'muted')));
    return section;
  }
  const planned = card.status === 'research' && card.plannedStakeCents ? card.plannedStakeCents : null;
  const labels = { ready: 'Proposed', skip: 'No bet', research: planned ? 'Check in app' : 'Under review' };
  const status = labels[card.status] || 'Under review';
  section.append(sectionHeader('THE CARD', calendarDate(card.date), text('span', status, `status-badge status-${card.status}`)));
  const heading = card.status === 'ready' ? 'For your consideration' : card.status === 'skip' ? 'Sitting this one out.' : planned ? 'Check the price in your app.' : 'Still checking the details.';
  const cardSummary = el('div', 'card-summary', text('h3', heading), text('p', card.summary));
  if (card.tier !== null) cardSummary.append(text('span', `Tier ${card.tier} · research judgment`, 'tier-label'));
  section.append(cardSummary);
  const detail = (label: string, value: string) => el('div', '', text('span', label, 'quote-label'), text('strong', value, 'quote-value'));
  if (planned) {
    const estimate = card.decimalOdds === null ? null : Math.round(planned * card.decimalOdds);
    section.append(el('div', 'quote-grid', detail('Planned stake', money(planned)), detail('Est. total return', estimate === null ? 'See app' : money(estimate)), detail('Est. profit', estimate === null ? 'See app' : signedMoney(estimate - planned)), detail('Est. multiple', card.decimalOdds === null ? 'See app' : `${card.decimalOdds.toFixed(2)}×`)));
    section.append(text('p', 'Estimated from the prices listed below. Your app\'s quote decides, and nothing is recorded until you confirm a placed slip.', 'fine-print plan-note'));
  }
  if (card.selections.length) {
    const selections = el('ol', 'selections');
    card.selections.forEach((selection, index) => selections.append(renderSelection(selection, index)));
    section.append(selections);
  }
  if (card.status === 'ready') {
    section.append(el('div', 'quote-grid', detail('Proposed stake', money(card.proposedStakeCents)), detail('Total return', card.returnCents === null ? 'Unconfirmed' : money(card.returnCents)), detail('Potential profit', card.profitCents === null ? 'Unconfirmed' : signedMoney(card.profitCents)), detail('Return multiple', card.decimalOdds === null ? 'Unconfirmed' : `${card.decimalOdds.toFixed(2)}×`)));
    section.append(text('p', `Total return includes the stake. Estimated fees: ${money(card.feesCents ?? 0)}. This is a proposal, not a placed ticket.`, 'fine-print'));
  }
  if (card.invalidations.length) {
    const list = el('ul', 'invalidation-list');
    card.invalidations.forEach((reason) => list.append(el('li', '', reason)));
    section.append(el('div', 'invalidations', text('h3', 'Before placing', 'small-heading'), list));
  }
  const validSources = card.sources.flatMap((source) => {
    const url = safeSourceUrl(source.url);
    if (!url) return [];
    const link = el('a', 'source-link', source.label, el('span', '', ' ↗'));
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.referrerPolicy = 'no-referrer';
    return [link];
  });
  if (validSources.length) section.append(el('div', 'source-links', text('span', 'Sources', 'quote-label'), ...validSources));
  section.append(el('div', 'card-footnote', text('small', `Card updated ${timestamp(card.updatedAt)}`), text('small', 'Confidence tiers do not guarantee outcomes.')));
  return section;
}

function renderSelection(selection: Selection, index: number) {
  const quoteLabel = selection.quoteBasis === 'comparison' ? `Comparison price${selection.quoteSource ? ` · ${selection.quoteSource}` : ''}; verify in your app` : selection.quoteSource || 'Quote';
  return el('li', 'selection', text('span', String(index + 1).padStart(2, '0'), 'selection-number'), el('div', 'selection-copy', text('p', selection.event, 'selection-event'), text('h3', selection.pick, 'selection-pick'), text('p', selection.market, 'selection-market'), el('div', 'selection-meta', text('span', timestamp(selection.startTime)), text('span', selection.odds === null ? 'Price unconfirmed' : `${americanOdds(selection.odds)} · ${(100 / selection.odds).toFixed(1)}% implied`)), text('p', `${quoteLabel} · checked ${timestamp(selection.quotedAt)}`, 'quote-time')));
}

function renderHistory(tickets: Ticket[]) {
  const section = el('section', 'detail-panel history-panel');
  section.append(sectionHeader('THE RECORD', 'Ticket history', text('span', `${tickets.length}`, 'count-badge')));
  if (!tickets.length) {
    section.append(el('div', 'history-empty', el('div', 'empty-ledger', el('span'), el('span'), el('span')), text('h3', 'A clean starting point.'), text('p', 'Confirmed tickets will appear here. Share the placed slip in the chat to add the actual stake and accepted price.', 'muted')));
    return section;
  }
  const list = el('div', 'ticket-list');
  [...tickets].sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime()).forEach((ticket) => {
    const statusLabels = { open: 'Open', result_pending: 'Settlement pending', won: 'Won', lost: 'Lost', void: 'Voided', cashed_out: 'Cashed out' };
    const details = el('details', 'ticket');
    const title = ticket.selections.length === 1 ? ticket.selections[0].pick : `${ticket.selections.length} selections`;
    const total = ticket.status === 'open' || ticket.status === 'result_pending' ? `${money(ticket.stakeCents)} staked` : ticket.returnCents === null ? 'Return unconfirmed' : `${money(ticket.returnCents)} returned`;
    const summary = el('summary', 'ticket-summary', el('div', 'ticket-summary-top', text('span', statusLabels[ticket.status] || 'Pending', `ticket-status ticket-${ticket.status}`), text('span', timestamp(ticket.placedAt), 'ticket-date')), el('div', 'ticket-summary-bottom', text('strong', title), text('span', total, 'ticket-total')), text('span', 'View details', 'ticket-expand'));
    const ticketBody = el('div', 'ticket-body');
    const selections = el('ol', 'selections ticket-selections');
    ticket.selections.forEach((selection, index) => selections.append(renderSelection(selection, index)));
    ticketBody.append(selections);
    const rows = el('dl', 'ticket-facts');
    const fact = (label: string, value: string) => rows.append(el('div', '', el('dt', '', label), el('dd', '', value)));
    fact('Stake', money(ticket.stakeCents));
    fact('Fees', money(ticket.feesCents));
    fact('Accepted multiple', ticket.decimalOdds === null ? 'Not recorded' : `${ticket.decimalOdds.toFixed(3)}×`);
    if (ticket.returnCents !== null) fact(ticket.status === 'result_pending' ? 'Calculated return' : 'Confirmed return', money(ticket.returnCents));
    if (ticket.settledAt) fact('Settled', timestamp(ticket.settledAt));
    if (['won', 'lost', 'void', 'cashed_out'].includes(ticket.status) && ticket.returnCents !== null) fact('Net result', signedMoney(ticket.returnCents - ticket.stakeCents - ticket.feesCents));
    ticketBody.append(rows);
    if (ticket.resultNote) ticketBody.append(text('p', ticket.resultNote, 'result-note'));
    ticketBody.append(text('small', `Ticket ${ticket.id}`, 'ticket-id'));
    details.append(summary, ticketBody);
    list.append(details);
  });
  section.append(list);
  return section;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && session) void refresh();
});
window.addEventListener('pagehide', () => setLock());
setInterval(() => { if (session && !document.hidden) void refresh(); }, 60_000);
initTheme();
renderLock();
