// Read-only discovery. Listed leg prices are not an executable combo quote.
const origin = 'https://gateway.polymarket.us';
const checkedAt = new Date().toISOString();
const requests = [], candidates = [];
let scanned = 0;
for (let offset = 0; offset < 6000; offset += 500) {
  const url = `${origin}/v1/markets?limit=500&active=true&closed=false&offset=${offset}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) { requests.push({ url, status: response.status }); break; }
  const result = await response.json();
  const markets = Array.isArray(result) ? result : result.markets ?? result.data ?? [];
  requests.push({ url, status: response.status, returned: markets.length });
  if (!Array.isArray(markets)) throw new Error('Unexpected market response');
  scanned += markets.length;
  for (const market of markets) {
    if (!market.active || market.closed || market.archived || /tennis/i.test(`${market.category} ${market.sportsMarketType} ${market.slug}`)) continue;
    const end = market.gameStartTime ?? market.endDate;
    if (!end || Date.parse(end) <= Date.now()) continue;
    const sides = (market.marketSides ?? []).filter((s) => s.tradable && Number(s.quote?.value ?? s.price) >= .90 && Number(s.quote?.value ?? s.price) <= .99);
    if (!sides.length) continue;
    candidates.push({ id: market.id, slug: market.slug, event: market.question, deadline: end, comboEnabled: market.comboEnabled === true, marketUpdatedAt: market.updatedAt, minimumTradeQty: market.minimumTradeQty, description: market.description, sides: sides.map((s) => ({ selection: s.description, listedPrice: s.quote?.value ?? s.price, long: s.long })), verifiedComboPrice: null });
  }
  if (markets.length < 500) break;
}
console.log(JSON.stringify({ checkedAt, scanned, exhaustive: requests.at(-1)?.returned < 500, requests, candidates, limitation: 'Discovery only. This does not verify order-book depth, executable prices or an offered combo. Do not multiply leg prices into a claimed app quote.' }, null, 2));
