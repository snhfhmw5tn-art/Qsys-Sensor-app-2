import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
test('TestThat_http_retry_atomicity_auth_and_restart_preserve_state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'qsys-api-')),
    port = 33000 + Math.floor(Math.random() * 1000),
    base = `http://127.0.0.1:${port}`;
  let child;
  async function Start() {
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir },
      stdio: 'pipe',
      windowsHide: true,
    });
    let logs = '';
    child.stdout.on('data', (b) => (logs += b));
    child.stderr.on('data', (b) => (logs += b));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(logs);
      try {
        if ((await fetch(base + '/api/health')).ok) return;
      } catch {}
      await delay(50);
    }
    throw new Error('API did not start ' + logs);
  }
  async function Stop() {
    if (!child || child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
    });
  }
  try {
    await Start();
    const session = await (await fetch(base + '/api/sessions', { method: 'POST' })).json();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
    };
    const o = {
      protocolVersion: 1,
      deviceId: 'api-test',
      sessionId: session.id,
      sequenceNumber: 1,
      monotonicTimestamp: 1,
      type: 'Step',
      motionMode: 'Walking',
      modeConfidence: 0.8,
      headingDelta: 0,
      headingConfidence: 0.6,
      observationConfidence: 0.8,
      steps: [
        {
          timestamp: 1,
          heading: 0,
          stepInterval: 0.5,
          cadence: 2,
          accelerationAmplitude: 4,
          signalEnergy: 2,
          motionConfidence: 0.8,
        },
      ],
    };
    const send = (observations) =>
      fetch(`${base}/api/sessions/${session.id}/observations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ observations }),
      });
    assert.equal((await fetch(`${base}/api/sessions/${session.id}`)).status, 401);
    let r = await send([o]);
    assert.equal(r.status, 200);
    const initial = await r.json();
    assert.equal(initial.ack, 1);
    assert.ok(initial.state.totalDistance > 0.5);
    const duplicate = await (await send([o])).json();
    assert.equal(duplicate.state.totalDistance, initial.state.totalDistance);
    r = await send([
      { ...o, sequenceNumber: 2, monotonicTimestamp: 2, steps: [{ ...o.steps[0], timestamp: 2 }] },
      { ...o, sequenceNumber: 4, monotonicTimestamp: 4 },
    ]);
    assert.equal(r.status, 400);
    const unchanged = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
    assert.equal(unchanged.lastSequence, 1);
    const calibration = await fetch(`${base}/api/sessions/${session.id}/calibration`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ factors: { walking: NaN, running: 1 } }),
    });
    assert.equal(calibration.status, 400);
    await Stop();
    await Start();
    const restored = await (await fetch(`${base}/api/sessions/${session.id}`, { headers })).json();
    assert.equal(restored.totalDistance, initial.state.totalDistance);
    assert.equal(restored.lastSequence, 1);
    const asset = await fetch(base + '/client/app.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    const privateFile = await fetch(base + '/server/index.js');
    assert.equal(privateFile.status, 404);
  } finally {
    await Stop();
    await rm(dir, { recursive: true, force: true });
  }
});
