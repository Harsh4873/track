import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile('src/presentation.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { money, safeSourceUrl, progress, calendarDate, age } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('display formats cents and growth progress without invalid percentages', () => { assert.equal(money(12345), '$123.45'); assert.equal(progress(100, 50, 1000), 15); assert.equal(progress(999, 999, 0), 0); });
test('source links reject executable URLs and embedded credentials', () => { assert.equal(safeSourceUrl('javascript:alert(1)'), null); assert.equal(safeSourceUrl('https://user:pass@example.com'), null); assert.equal(safeSourceUrl('https://example.com'), 'https://example.com/'); });
test('calendar-only dates stay on the intended Central day', () => { assert.match(calendarDate('2026-06-10'), /June 10, 2026/); assert.equal(age(null), 'Awaiting first sync'); });
test('private UI is constructed with DOM text and does not persist session credentials', async () => {
  const src = await readFile('src/main.ts', 'utf8');
  assert.doesNotMatch(src, /innerHTML|localStorage|sessionStorage/);
  assert.match(src, /session = null/); assert.match(src, /state = null/); assert.match(src, /readOnly|proposed|Proposed/);
});
