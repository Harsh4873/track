import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile('src/presentation.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { money, safeSourceUrl, progress, calendarDate, age, americanOdds, priceLabel, timestamp, formatMultiple } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('leg prices show American odds for favorites, underdogs and invalid input', () => {
  assert.equal(americanOdds(1 / 0.96), '-2400'); assert.equal(americanOdds(1 + 100 / 174), '-174'); assert.equal(americanOdds(2.15), '+115');
  assert.equal(americanOdds(2), '+100'); assert.equal(americanOdds(1), 'Unpriced'); assert.equal(americanOdds(Number.NaN), 'Unpriced');
});
test('unpriceable legs do not invent an implied percent', () => {
  assert.equal(priceLabel(null), 'Price unconfirmed');
  assert.equal(priceLabel(Number.NaN), 'Unpriced');
  assert.equal(priceLabel(0), 'Unpriced');
  assert.equal(priceLabel(1), 'Unpriced');
  assert.equal(priceLabel(2.15), '+115 · 46.5% implied');
});
test('display formats cents and growth progress without invalid percentages', () => { assert.equal(money(12345), '$123.45'); assert.equal(progress(100, 50, 1000), 15); assert.equal(progress(999, 999, 0), 0); });
test('source links reject executable URLs and embedded credentials', () => { assert.equal(safeSourceUrl('javascript:alert(1)'), null); assert.equal(safeSourceUrl('https://user:pass@example.com'), null); assert.equal(safeSourceUrl('https://example.com'), 'https://example.com/'); });
test('calendar-only dates stay on the intended Central day', () => { assert.match(calendarDate('2026-06-10'), /June 10, 2026/); assert.equal(age(null), 'Awaiting first sync'); });
test('journal copy keeps the bets and the money and drops filler labels', async () => {
  const src = await readFile('src/main.ts', 'utf8');
  const removed = [
    'Recorded funds available to use',
    'Staked on unsettled tickets',
    'Settled results, including fees',
    'Across all confirmed tickets',
    'Sitting this one out.',
    'A clear no-bet decision is part of the record, too.',
    'Opening balances are user-reported',
    'For your consideration',
    'Still checking the details.',
    'A private record. A clearer picture.',
    'Confidence tiers do not guarantee outcomes.',
  ];
  for (const phrase of removed) assert.equal(src.includes(phrase), false, phrase);
  assert.match(src, /Outstanding/);
  assert.match(src, /Staked today/);
  assert.match(src, /Growth/);
  assert.match(src, /Proposed stake/);
  assert.doesNotMatch(src, /\u2014/);
});
test('private UI is constructed with DOM text and does not persist session credentials', async () => {
  const src = await readFile('src/main.ts', 'utf8');
  assert.doesNotMatch(src, /innerHTML|localStorage|sessionStorage/);
  assert.match(src, /session = null/); assert.match(src, /state = null/); assert.match(src, /readOnly|proposed|Proposed/);
});
const themeSource = await readFile('src/theme.ts', 'utf8');
const themeJs = ts.transpileModule(themeSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
let themeLoads = 0;
async function loadTheme({ stored = null, light = false, blocked = false } = {}) {
  const env = { writes: [], changes: [], metas: [{}, {}], toggles: [], root: { dataset: {} } };
  env.media = { matches: light, addEventListener: (_, listener) => env.changes.push(listener) };
  env.system = (matches) => { env.media.matches = matches; env.changes.forEach((listener) => listener({ matches })); };
  const storage = { getItem: (key) => { if (blocked) throw new Error('blocked'); return key === 'track-theme' ? stored : null; }, setItem: (key, value) => { if (blocked) throw new Error('blocked'); env.writes.push(`${key}=${value}`); } };
  const createElement = () => { const clicks = []; const toggle = { attrs: {}, setAttribute: (name, value) => { toggle.attrs[name] = value; }, addEventListener: (_, listener) => clicks.push(listener), click: () => clicks.forEach((listener) => listener()) }; env.toggles.push(toggle); return toggle; };
  const document = { documentElement: env.root, createElement, querySelectorAll: (selector) => selector === '.theme-toggle' ? env.toggles : env.metas };
  for (const [name, value] of Object.entries({ localStorage: storage, window: { matchMedia: () => env.media }, document })) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  env.theme = await import(`data:text/javascript;base64,${Buffer.from(`${themeJs}\n// load ${++themeLoads}`).toString('base64')}`);
  return env;
}
test('the theme choice is the only stored value and main.ts never touches storage', async () => {
  const main = await readFile('src/main.ts', 'utf8');
  assert.match(themeSource, /const storageKey = 'track-theme';/); assert.equal(themeSource.match(/localStorage/g)?.length, 2);
  assert.deepEqual([...themeSource.matchAll(/localStorage\.(\w+)\((\w+)/g)].map(([, method, key]) => `${method}(${key})`), ['getItem(storageKey)', 'setItem(storageKey)']);
  assert.doesNotMatch(themeSource, /sessionStorage|indexedDB|cookie|token|session|\bpin\b|ledger|innerHTML/i);
  assert.doesNotMatch(main, /innerHTML|localStorage|sessionStorage|indexedDB|document\.cookie/); assert.match(main, /initTheme\(\);\nrenderLock\(\);/);
});
test('theme follows the system until the toggle stores an explicit light or dark choice', async () => {
  const env = await loadTheme();
  env.theme.initTheme();
  assert.equal(env.root.dataset.theme, 'dark'); assert.deepEqual(env.metas.map((meta) => meta.content), ['#101719', '#101719']);
  env.system(true);
  assert.equal(env.root.dataset.theme, 'light'); assert.deepEqual(env.metas.map((meta) => meta.content), ['#f6f4ef', '#f6f4ef']);
  const toggle = env.theme.themeToggle();
  assert.equal(toggle.id, 'theme-toggle'); assert.equal(toggle.type, 'button'); assert.equal(toggle.textContent, '☾');
  assert.equal(toggle.title, 'Switch to dark mode'); assert.equal(toggle.attrs['aria-label'], 'Switch to dark mode');
  toggle.click();
  assert.equal(env.root.dataset.theme, 'dark'); assert.equal(toggle.title, 'Switch to light mode'); assert.equal(toggle.attrs['aria-label'], 'Switch to light mode');
  env.system(false); env.system(true);
  assert.equal(env.root.dataset.theme, 'dark'); assert.deepEqual(env.writes, ['track-theme=dark']);
});
test('a stored choice wins, unknown values fall back to the system and blocked storage never breaks the toggle', async () => {
  const stored = await loadTheme({ stored: 'light' });
  stored.theme.initTheme(); stored.system(false);
  assert.equal(stored.root.dataset.theme, 'light');
  const unknown = await loadTheme({ stored: 'sepia', light: true });
  unknown.theme.initTheme();
  assert.equal(unknown.root.dataset.theme, 'light');
  const blocked = await loadTheme({ blocked: true });
  assert.doesNotThrow(() => blocked.theme.initTheme());
  const toggle = blocked.theme.themeToggle();
  assert.doesNotThrow(() => toggle.click()); blocked.system(false);
  assert.equal(blocked.root.dataset.theme, 'light'); assert.deepEqual(blocked.writes, []);
});
test('stylesheet keeps every color in matching dark and light palettes', async () => {
  const [css, html] = await Promise.all(['src/style.css', 'index.html'].map((path) => readFile(path, 'utf8')));
  const blocks = [/:root\{([^}]*)\}/, /:root\[data-theme=light\]\{([^}]*)\}/, /@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root:not\(\[data-theme=dark\]\)\{([^}]*)\}\s*\}/].map((pattern) => css.match(pattern));
  assert.ok(blocks.every(Boolean), 'dark, explicit light and system light palettes are defined');
  const [dark, light, system] = blocks.map((match) => match[1]);
  const tokens = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+):([^;]+)/g)].map(([, name, value]) => [name, value]));
  assert.equal(system, light); assert.deepEqual(Object.keys(tokens(light)), Object.keys(tokens(dark)));
  assert.match(dark, /color-scheme:dark/); assert.match(light, /color-scheme:light/);
  const outside = blocks.reduce((rest, match) => rest.replace(match[0], ''), css) + dark.replace(/--[\w-]+:[^;]+/g, '');
  assert.doesNotMatch(outside, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  const bg = { dark: tokens(dark)['--bg'], light: tokens(light)['--bg'] };
  assert.match(themeSource, new RegExp(`dark: '${bg.dark}', light: '${bg.light}'`));
  for (const scheme of ['dark', 'light']) assert.match(html, new RegExp(`<meta name="theme-color" content="${bg[scheme]}" media="\\(prefers-color-scheme: ${scheme}\\)" />`));
  assert.match(html, /<meta name="color-scheme" content="dark light" \/>/); assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
});
test('settled tickets carry subtle won and lost row shading with a colored net', async () => {
  const [main, css] = await Promise.all(['src/main.ts', 'src/style.css'].map((path) => readFile(path, 'utf8')));
  assert.match(main, /ticket-row-\$\{tone\}/);
  assert.match(main, /ticket-net/);
  assert.match(css, /\.ticket-row-won\{background:color-mix\(in srgb,var\(--positive\)/);
  assert.match(css, /\.ticket-row-lost\{background:color-mix\(in srgb,var\(--negative\)/);
  assert.match(main, /skip: 'No bet'/);
  assert.match(main, /research: 'Research'/);
});
test('light palette text meets WCAG AA contrast on its background', async () => {
  const css = await readFile('src/style.css', 'utf8');
  const light = Object.fromEntries([...css.match(/:root\[data-theme=light\]\{([^}]*)\}/)[1].matchAll(/--([\w-]+):(#[0-9a-f]{6})(?![0-9a-f])/gi)].map(([, name, value]) => [name, value]));
  const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
  const pairs = { bg: 'text muted dim accent quiet-text field-label form-status motto sync-text empty-symbol', panel: 'text muted dim positive negative metric-label', 'detail-bg': 'text muted dim accent positive negative badge-text pending-text tier-text market-text small-heading link-hover empty-symbol ticket-status ticket-total', 'quote-bg': 'text muted', accent: 'on-accent mark-ink', 'accent-hover': 'on-accent', 'quiet-hover': 'quiet-text', 'ready-bg': 'accent', 'skip-bg': 'skip-text', 'pending-bg': 'pending-text', 'notice-bg': 'notice-text', 'error-bg': 'error-text' };
  for (const [background, texts] of Object.entries(pairs)) for (const text of texts.split(' ')) assert.ok(ratio(light[text], light[background]) >= 4.5, `${text} on ${background}`);
});
test('dark secondary text and field borders meet contrast minimums', async () => {
  const css = await readFile('src/style.css', 'utf8');
  const palette = (pattern) => Object.fromEntries([...css.match(pattern)[1].matchAll(/--([\w-]+):(#[0-9a-f]{6})(?![0-9a-f])/gi)].map(([, name, value]) => [name, value]));
  const dark = palette(/:root\{([^}]*)\}/);
  const light = palette(/:root\[data-theme=light\]\{([^}]*)\}/);
  const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
  for (const surface of ['bg', 'panel', 'detail-bg', 'quote-bg']) assert.ok(ratio(dark.dim, dark[surface]) >= 4.5, `dim on ${surface}`);
  assert.ok(ratio(dark['field-line'], dark.panel) >= 3, 'dark field border');
  assert.ok(ratio(light['field-line'], light.panel) >= 3, 'light field border on panel');
  assert.ok(ratio(light['field-line'], light.bg) >= 3, 'light field border on page');
});
test('timestamps name the year only outside the current Central year, and sync age uses words', () => {
  const now = new Date('2026-10-13T18:00:00Z');
  const current = timestamp('2026-10-13T18:00:00Z', now);
  assert.match(current, /Oct 13/);
  assert.doesNotMatch(current, /2026/);
  const older = timestamp('2024-03-01T18:00:00Z', now);
  assert.match(older, /Mar 1/);
  assert.match(older, /2024/);
  assert.equal(timestamp('not-a-date', now), 'Not confirmed');
  assert.equal(age(null), 'Awaiting first sync');
  assert.equal(age('not-a-date'), 'Not confirmed');
  const instant = now.getTime();
  assert.equal(age(new Date(instant - 60_000).toISOString(), instant), 'Updated 1 minute ago');
  assert.equal(age(new Date(instant - 5 * 60_000).toISOString(), instant), 'Updated 5 minutes ago');
  assert.equal(age(new Date(instant - 60 * 60_000).toISOString(), instant), 'Updated 1 hour ago');
  assert.equal(age(new Date(instant - 2 * 24 * 60 * 60_000).toISOString(), instant), 'Updated 2 days ago');
  const centralEvening = new Date('2026-01-01T05:00:00Z');
  const sameCentralYear = timestamp('2026-01-01T04:00:00Z', centralEvening);
  assert.match(sameCentralYear, /Dec 31/);
  assert.doesNotMatch(sameCentralYear, /2025|2026/);
  const previousCentralYear = timestamp('2026-01-01T05:30:00Z', new Date('2026-06-15T18:00:00Z'));
  assert.match(previousCentralYear, /Dec 31/);
  assert.match(previousCentralYear, /2025/);
});
test('non-finite odds do not render as NaN', () => {
  assert.equal(formatMultiple(null, 2, 'Unconfirmed'), 'Unconfirmed');
  assert.equal(formatMultiple(Number.NaN, 2, 'Unconfirmed'), 'Unpriced');
  assert.equal(formatMultiple(Number.POSITIVE_INFINITY, 3, 'Not recorded'), 'Unpriced');
  assert.equal(formatMultiple(2.5, 2, 'Unconfirmed'), '2.50×');
  assert.equal(formatMultiple(1.21, 3, 'Not recorded'), '1.210×');
  assert.equal(formatMultiple(undefined, 2, 'Not recorded'), 'Not recorded');
});
test('journal refresh keeps focus targets and does not hide the tab panel ring', async () => {
  const [src, css] = await Promise.all(['src/main.ts', 'src/style.css'].map((path) => readFile(path, 'utf8')));
  assert.match(src, /dataset\.ticketId/);
  assert.match(src, /panelId, ticketId/);
  assert.match(src, /\$\{tickets\.length\} \$\{tickets\.length === 1 \? 'ticket' : 'tickets'\}`, 'sr-only'/);
  assert.doesNotMatch(src, /count\.setAttribute\('aria-label'/);
  assert.match(src, /aria-orientation/);
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /priceLabel\(selection\.odds\)/);
  assert.match(src, /className = 'sr-only'| 'sr-only'/);
  assert.doesNotMatch(css, /\.book-panel:focus-visible\{outline:\s*none\}/);
  assert.match(css, /\.sr-only\{/);
  assert.match(src, /activeBook !== id/);
  assert.match(src, /Skip to journal/);
  assert.match(src, /Hide details/);
  assert.match(src, /net !== null && net >= 0/);
  assert.doesNotMatch(src, /feesCents \?\? 0/);
  assert.match(src, /event\.shiftKey/);
  assert.match(src, /empty-title/);
  assert.match(css, /touch-action:pan-y pinch-zoom/);
  assert.match(css, /max-height:760px/);
  assert.doesNotMatch(css, /\.ticket-amounts\{[^}]*white-space:nowrap/);
  assert.match(css, /\.ticket-net\{[^}]*font-size:12px/);
  assert.match(css, /color-mix\(in srgb,var\(--positive\) 6%/);
  assert.match(css, /color-mix\(in srgb,currentColor 8%/);
});
test('ticket wash, link underlines, and the goal track keep their contrast jobs', async () => {
  const css = await readFile('src/style.css', 'utf8');
  const palette = (pattern) => Object.fromEntries([...css.match(pattern)[1].matchAll(/--([\w-]+):(#[0-9a-f]{6})(?![0-9a-f])/gi)].map(([, name, value]) => [name, value]));
  const dark = palette(/:root\{([^}]*)\}/);
  const light = palette(/:root\[data-theme=light\]\{([^}]*)\}/);
  const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); };
  const mix = (fg, bg, amount) => `#${[0, 2, 4].map((i) => Math.round(parseInt(fg.slice(i + 1, i + 3), 16) * amount + parseInt(bg.slice(i + 1, i + 3), 16) * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
  const wash = Number(css.match(/\.ticket-row-won\{background:color-mix\(in srgb,var\(--positive\) ([\d.]+)%/)[1]) / 100;
  const pill = Number(css.match(/\.ticket-status\{[^}]*color-mix\(in srgb,currentColor ([\d.]+)%/)[1]) / 100;
  for (const [name, colors] of [['dark', dark], ['light', light]]) {
    assert.ok(ratio(colors['link-line'], colors['detail-bg']) >= 3, `${name} link underline`);
    assert.ok(ratio(colors['lock-ring'], colors.bg) >= 3, `${name} lock ring`);
    assert.ok(ratio(colors.accent, colors['goal-track']) >= 3, `${name} goal fill on track`);
    const tones = [['positive', colors.positive], ['negative', colors.negative], ['pending-text', colors['pending-text']], ['muted', colors.muted]];
    for (const [tone, ink] of tones) {
      const row = mix(ink, colors['detail-bg'], wash);
      assert.ok(ratio(colors.dim, row) >= 4.5, `${name} dim on ${tone} row`);
      const chip = mix(tone === 'muted' ? colors['ticket-status'] : ink, row, pill);
      const chipInk = tone === 'muted' ? colors['ticket-status'] : ink;
      assert.ok(ratio(chipInk, chip) >= 4.5, `${name} status on ${tone} chip`);
    }
  }
  assert.ok(ratio(dark['goal-track'], dark.panel) >= 2.4, 'dark goal track');
  assert.ok(ratio(light['goal-track'], light.panel) >= 1.8, 'light goal track');
});
