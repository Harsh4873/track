import { readFile, readdir, access } from 'node:fs/promises';
import assert from 'node:assert/strict';
const html = await readFile('dist/index.html', 'utf8');
assert.match(html, /\/track\/assets\/[^" ]+\.js/);
assert.match(html, /\/track\/assets\/[^" ]+\.css/);
for (const path of ['CNAME', 'dist/CNAME']) await assert.rejects(access(path));
for (const name of await readdir('dist/assets')) {
  const content = await readFile(`dist/assets/${name}`, 'utf8');
  for (const forbidden of ['TRACK_SERVICE_TOKEN', 'TRACK_PIN_HASH', 'serviceToken', 'openingCents":', 'scryptSync', 'PRIVATE KEY']) assert.ok(!content.includes(forbidden), `Private material in artifact: ${forbidden}`);
}
console.log('Pages artifact checks passed');
