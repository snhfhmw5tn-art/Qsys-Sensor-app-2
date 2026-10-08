import { config as C } from '../shared/config.js';
export class QueueStore {
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('qsys-motion-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async get(key) {
    return new Promise((resolve, reject) => {
      const r = this.db.transaction('queue').objectStore('queue').get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async set(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('queue', 'readwrite');
      tx.objectStore('queue').put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
}
export class MotionObservationSender {
  constructor(session, onState, onStatus) {
    this.session = session;
    this.onState = onState;
    this.onStatus = onStatus;
    this.queue = [];
    this.store = new QueueStore();
    this.busy = false;
    this.bytes = 0;
    this.requests = 0;
    this.started = performance.now();
    this.persistence = Promise.resolve();
    this.persistError = null;
  }
  async start() {
    await this.store.open();
    this.queue = (await this.store.get(this.session.id)) ?? [];
    this.timer = setInterval(() => this.flush(), C.sendInterval);
  }
  persist() {
    const copy = structuredClone(this.queue);
    this.persistence = this.persistence
      .then(() => this.store.set(this.session.id, copy))
      .catch((e) => {
        this.persistError = e;
        this.onStatus(`Lokal lagring misslyckades: ${e.message}`);
      });
    return this.persistence;
  }
  add(o) {
    if (this.queue.length >= C.maxQueue)
      throw new Error('Utgående buffert full. Stoppa och återanslut innan fortsättning.');
    this.queue.push(o);
    this.persist();
  }
  async flush() {
    if (this.busy || !this.queue.length) return;
    this.busy = true;
    try {
      await this.persistence;
      if (this.persistError) throw this.persistError;
      const batch = this.queue.slice(0, C.maxBatch),
        body = JSON.stringify({ observations: batch });
      this.bytes += new TextEncoder().encode(body).length;
      this.requests++;
      const response = await fetch(`/api/sessions/${this.session.id}/observations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.session.token}`,
        },
        body,
        signal: AbortSignal.timeout(7000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      this.queue = this.queue.filter((o) => o.sequenceNumber > data.ack);
      await this.persist();
      this.onState(data.state);
      this.onStatus('Ansluten');
    } catch (e) {
      this.onStatus(`Återförsök · ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
  async request(action, payload) {
    const r = await fetch(`/api/sessions/${this.session.id}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.session.token}`,
      },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    this.onState(d.state);
    return d;
  }
  stop() {
    clearInterval(this.timer);
  }
}
