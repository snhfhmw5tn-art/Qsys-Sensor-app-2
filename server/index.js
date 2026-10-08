import http from 'node:http';
import https from 'node:https';
import { readFile, writeFile, appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { config as C, modes } from '../shared/config.js';
import { initialState, MotionObservationReceiver, publicState } from './state.js';
import { validateObservation } from './protocol.js';
const root = fileURLToPath(new URL('../', import.meta.url)),
  data = process.env.DATA_DIR ?? path.join(root, 'data');
const engine = new MotionObservationReceiver(),
  sessions = new Map(),
  locks = new Map();
await mkdir(data, { recursive: true });
const digest = (x) => createHash('sha256').update(x).digest('hex');
function applyRecord(s, record) {
  if (record.observations) for (const o of record.observations) engine.process(s, o);
  if (record.calibration) s.calibration = record.calibration;
  if (record.truth) s.groundTruth.push(record.truth);
}
for (const file of await readdir(data)) {
  if (!/^[a-f0-9-]{36}\.jsonl$/.test(file)) continue;
  const lines = (await readFile(path.join(data, file), 'utf8')).trim().split('\n');
  try {
    const meta = JSON.parse(lines[0]),
      s = initialState(meta.id);
    for (const line of lines.slice(1)) applyRecord(s, JSON.parse(line));
    sessions.set(meta.id, { state: s, tokenHash: meta.tokenHash });
  } catch (e) {
    console.error(`Kan inte återställa ${file}: ${e.message}`);
  }
}
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};
async function body(req) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > C.maxBodyBytes) {
      const e = new Error('Request too large');
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function json(res, status, value) {
  let bytes = Buffer.from(JSON.stringify(value));
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Vary: 'Accept-Encoding',
  };
  if (bytes.length > 1024 && res.canGzip) {
    bytes = gzipSync(bytes);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, headers);
  res.end(bytes);
}
async function transaction(id, fn) {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}
async function handler(req, res) {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.canGzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/health')
      return json(res, 200, { ok: true, algorithmVersion: C.version });
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      if (sessions.size >= 2000) return json(res, 503, { error: 'Session capacity reached' });
      const id = randomUUID(),
        token = randomBytes(32).toString('hex'),
        meta = { id, tokenHash: digest(token), created: new Date().toISOString() };
      await writeFile(path.join(data, `${id}.jsonl`), JSON.stringify(meta) + '\n', { flag: 'wx' });
      const entry = { state: initialState(id), tokenHash: meta.tokenHash };
      sessions.set(id, entry);
      return json(res, 201, { id, token, state: publicState(entry.state) });
    }
    const match = url.pathname.match(
      /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(observations|calibration|truth))?$/,
    );
    if (match) {
      const [, id, action] = match,
        entry = sessions.get(id);
      if (!entry) return json(res, 404, { error: 'Session not found' });
      const supplied = digest((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(entry.tokenHash)))
        return json(res, 401, { error: 'Invalid session token' });
      if (req.method === 'GET') return json(res, 200, publicState(entry.state, true));
      if (req.method === 'DELETE' && !action)
        return await transaction(id, async () => {
          await unlink(path.join(data, `${id}.jsonl`));
          sessions.delete(id);
          return json(res, 200, { deleted: true });
        });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      const payload = await body(req);
      return await transaction(id, async () => {
        const next = structuredClone(entry.state);
        let record;
        if (action === 'observations') {
          if (!Array.isArray(payload.observations) || payload.observations.length > C.maxBatch)
            throw new Error('Invalid batch');
          if (next.lastSequence + payload.observations.length > C.maxSessionObservations)
            throw new Error('Session observation limit reached');
          const observations = payload.observations.map((o) => validateObservation(o, id));
          for (const o of observations) engine.process(next, o);
          record = {
            observations: observations.filter((o) => o.sequenceNumber > entry.state.lastSequence),
          };
        } else if (action === 'calibration') {
          if (payload.factors && next.lastSequence === 0) {
            if (
              !['walking', 'running'].every(
                (k) =>
                  Number.isFinite(payload.factors[k]) &&
                  payload.factors[k] >= 0.4 &&
                  payload.factors[k] <= 2.5,
              )
            )
              throw new Error('Invalid calibration factors');
            next.calibration = {
              walking: payload.factors.walking,
              running: payload.factors.running,
            };
            record = { calibration: next.calibration };
          } else {
            if (
              !['walking', 'running'].includes(payload.kind) ||
              !Number.isFinite(payload.actualDistance) ||
              payload.actualDistance <= 0 ||
              payload.actualDistance > 10000
            )
              throw new Error('Invalid calibration');
            const measured =
              payload.kind === 'walking' ? next.walkingDistance : next.runningDistance;
            if (measured < 3) throw new Error('Samla minst 3 m i valt läge först');
            const factor = (next.calibration[payload.kind] * payload.actualDistance) / measured;
            if (factor < 0.4 || factor > 2.5)
              throw new Error('Kalibrering utanför rimligt intervall (.4–2.5)');
            next.calibration[payload.kind] = factor;
            record = { calibration: next.calibration };
          }
        } else if (action === 'truth') {
          if (
            (payload.knownSteps !== undefined &&
              (!Number.isSafeInteger(payload.knownSteps) || payload.knownSteps < 0)) ||
            (payload.heading !== undefined &&
              (!Number.isFinite(payload.heading) ||
                payload.heading < -180 ||
                payload.heading > 360))
          )
            throw new Error('Invalid reference truth');
          if (
            !Number.isFinite(payload.t) ||
            payload.t < 0 ||
            !modes.includes(payload.mode) ||
            (payload.knownDistance !== undefined &&
              (!Number.isFinite(payload.knownDistance) || payload.knownDistance < 0)) ||
            (payload.position &&
              (!Number.isFinite(payload.position.x) || !Number.isFinite(payload.position.y)))
          )
            throw new Error('Invalid ground truth');
          const truth = {
            t: payload.t,
            mode: payload.mode,
            ...(payload.knownDistance !== undefined
              ? { knownDistance: payload.knownDistance }
              : {}),
            ...(payload.position ? { position: payload.position } : {}),
          };
          next.groundTruth.push(truth);
          record = { truth };
          if (payload.knownSteps !== undefined) truth.knownSteps = payload.knownSteps;
          if (payload.heading !== undefined) truth.heading = payload.heading;
        } else throw new Error('Unknown action');
        await appendFile(path.join(data, `${id}.jsonl`), JSON.stringify(record) + '\n');
        entry.state = next;
        return json(res, 200, { ack: next.lastSequence, state: publicState(next) });
      });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return json(res, 405, { error: 'Method not allowed' });
    let filename =
      url.pathname === '/' ? 'client/index.html' : decodeURIComponent(url.pathname).slice(1);
    if (
      !['client/', 'shared/', 'vendor/'].some((prefix) => filename.startsWith(prefix)) &&
      filename !== 'sw.js'
    )
      return json(res, 404, { error: 'Not found' });
    const resolved = path.resolve(root, filename);
    if (!resolved.startsWith(root + path.sep) && !resolved.startsWith(root))
      return json(res, 403, { error: 'Forbidden' });
    if (filename.split(/[\\/]/).includes('..')) return json(res, 403, { error: 'Forbidden' });
    const bytes = await readFile(resolved);
    res.writeHead(200, {
      'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (e) {
    json(res, e.code === 'ENOENT' ? 404 : (e.status ?? 400), { error: e.message });
  }
}
const port = Number(process.env.PORT ?? 3000);
const server =
  process.env.TLS_KEY && process.env.TLS_CERT
    ? https.createServer(
        { key: await readFile(process.env.TLS_KEY), cert: await readFile(process.env.TLS_CERT) },
        handler,
      )
    : http.createServer(handler);
server.listen(port, process.env.HOST ?? '0.0.0.0', () =>
  console.log(
    `Qsys Motion ${C.version}: ${process.env.TLS_KEY ? 'https' : 'http'}://localhost:${port}`,
  ),
);
