import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { ensure, type Ledger } from './domain.js';
import { hashToken, type SessionRecord, type Store } from './service.js';

// The browser cannot access this namespace through Firestore client rules.
const ROOT = 'track_private/journal';
export class FirestoreStore implements Store {
  private db = getFirestore();
  async read(): Promise<Ledger | null> { const snap = await this.db.doc(ROOT).get(); return snap.exists ? snap.data()!.ledger as Ledger : null; }
  async mutate(key: string, hash: string, body: unknown, update: (old: Ledger | null) => Ledger, related?: { key: string; book: string; ticketId?: string }) {
    return this.db.runTransaction(async (tx) => {
      const stateRef = this.db.doc(ROOT);
      const eventRef = stateRef.collection('events').doc(hashToken(key));
      const [snapshot, existing] = await Promise.all([tx.get(stateRef), tx.get(eventRef)]);
      const old = snapshot.exists ? snapshot.data()!.ledger as Ledger : null;
      if (existing.exists) {
        ensure(existing.data()!.hash === hash, 'idempotency_conflict', 409);
        ensure(old, 'missing_ledger', 409);
        return { applied: false, ledger: old };
      }
      if (related) {
        const reference = await tx.get(stateRef.collection('events').doc(hashToken(related.key)));
        const prior = reference.data()?.body;
        ensure(prior && prior.book === related.book && (!related.ticketId || prior.ticketId === related.ticketId || prior.ticket?.id === related.ticketId), 'invalid_correction_reference', 409);
      }
      const ledger = update(old);
      const safeLedger = JSON.parse(JSON.stringify(ledger));
      ensure(Buffer.byteLength(JSON.stringify(safeLedger)) < 850_000, 'ledger_capacity_reconciliation_required', 409);
      tx.set(stateRef, { ledger: safeLedger });
      tx.create(eventRef, { key, hash, body: JSON.parse(JSON.stringify(body)), recordedAt: Timestamp.now() });
      // Retain complete ticket records independently of the recent-ticket view.
      for (const book of ledger.books) for (const ticket of book.tickets) {
        const previous = old?.books.find((b) => b.id === book.id)?.tickets.find((t) => t.id === ticket.id);
        if (JSON.stringify(previous) !== JSON.stringify(ticket)) tx.set(stateRef.collection('tickets').doc(hashToken(`${book.id}:${ticket.id}`)), { ...JSON.parse(JSON.stringify(ticket)), updatedAt: Timestamp.now() });
      }
      return { applied: true, ledger };
    });
  }
  async attempt(ip: string, now: number): Promise<number> {
    const windowMs = 15 * 60 * 1000;
    const window = Math.floor(now / windowMs);
    const ipRef = this.db.doc(`${ROOT}/limits/ip-${ip}`);
    const globalRef = this.db.doc(`${ROOT}/limits/global`);
    return this.db.runTransaction(async (tx) => {
      const [a, b] = await Promise.all([tx.get(ipRef), tx.get(globalRef)]);
      const ipCount = a.data()?.window === window ? Number(a.data()!.count) : 0;
      const globalCount = b.data()?.window === window ? Number(b.data()!.count) : 0;
      if (ipCount >= 5 || globalCount >= 20) return Math.max(1, Math.ceil(((window + 1) * windowMs - now) / 1000));
      const expiresAt = Timestamp.fromMillis((window + 2) * windowMs);
      tx.set(ipRef, { window, count: ipCount + 1, expiresAt });
      tx.set(globalRef, { window, count: globalCount + 1, expiresAt });
      return 0;
    });
  }
  async createSession(hash: string, record: SessionRecord) { await this.db.doc(`${ROOT}/sessions/${hash}`).set({ expiresAt: record.expiresAt, cleanupAt: Timestamp.fromMillis(record.expiresAt) }); }
  async session(hash: string): Promise<SessionRecord | null> { const snap = await this.db.doc(`${ROOT}/sessions/${hash}`).get(); return snap.exists ? { expiresAt: Number(snap.data()!.expiresAt) } : null; }
  async deleteSession(hash: string) { await this.db.doc(`${ROOT}/sessions/${hash}`).delete(); }
}
