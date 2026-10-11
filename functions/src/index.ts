import { initializeApp } from 'firebase-admin/app';
import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { handle } from './service.js';
import { FirestoreStore } from './store.js';
initializeApp();
const pinHash = defineSecret('TRACK_PIN_HASH');
const serviceToken = defineSecret('TRACK_SERVICE_TOKEN');
const store = new FirestoreStore();
export const trackApi = onRequest({
  cors: false, invoker: 'public', region: 'us-central1', secrets: [pinHash, serviceToken],
  maxInstances: 2, concurrency: 8, timeoutSeconds: 30, memory: '256MiB',
}, async (req, res) => {
  if (req.rawBody && req.rawBody.length > 250_000) { res.status(413).set('Cache-Control', 'no-store').json({ error: 'request_too_large' }); return; }
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  const request = new Request(`https://track.invalid${req.originalUrl || req.url || '/'}`, {
    method: req.method, headers,
    ...(!['GET', 'HEAD'].includes(req.method) ? { body: req.rawBody?.toString("utf8") ?? "" } : {}),
  });
  const response = await handle(request, { store, pinHash: pinHash.value(), serviceToken: serviceToken.value() }, req.ip ?? req.socket.remoteAddress ?? 'unknown');
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.send(Buffer.from(await response.arrayBuffer()));
});
