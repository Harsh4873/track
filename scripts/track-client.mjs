import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [operation, inputPath] = process.argv.slice(2);
const endpoints = { state: ['GET', '/v1/state'], bootstrap: ['POST', '/v1/bootstrap'], event: ['POST', '/v1/events'], cards: ['POST', '/v1/cards'] };
try {
  if (!Object.hasOwn(endpoints, operation ?? '')) throw new Error('Use state, bootstrap, event or cards. Mutations require a private JSON input file.');
  const credentialPath = process.env.TRACK_CREDENTIAL_FILE ?? resolve(homedir(), '.config/track/credentials.json');
  const credentialStat = await stat(credentialPath);
  if ((credentialStat.mode & 0o077) !== 0) throw new Error('Credential file must be accessible only to its owner.');
  const config = JSON.parse(await readFile(credentialPath, 'utf8'));
  const api = new URL(config.apiUrl);
  if (api.protocol !== 'https:' || api.username || api.password || !['trackapi-5ofllh7vvq-uc.a.run.app'].includes(api.hostname)) throw new Error('Unexpected API origin.');
  const [method, path] = endpoints[operation];
  let payload;
  if (method === 'POST') {
    if (!inputPath) throw new Error('A private input file is required.');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const rel = relative(root, resolve(inputPath));
    if (!rel.startsWith('..')) throw new Error('Private records must be stored outside the source repository.');
    payload = await readFile(inputPath, 'utf8');
    JSON.parse(payload);
  }
  const response = await fetch(`${api.href.replace(/\/$/, '')}${path}`, { method, headers: { 'X-Track-Authorization': `Bearer ${config.serviceToken}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, body: payload, signal: AbortSignal.timeout(30_000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error(`API returned a non-JSON response (${response.status}).`);
  const data = await response.json();
  if (!response.ok) throw new Error(`Request failed (${response.status}): ${data.error ?? 'unknown'}`);
  console.log(JSON.stringify(data, null, 2));
} catch (error) { console.error(error instanceof Error ? error.message : 'Request failed'); process.exitCode = 1; }
