import { config as C, family } from '../shared/config.js';
import { SensorPipeline } from './pipeline.js';
import {
  LiveSensorSource,
  ReplaySensorSource,
  SessionRecorder,
  demoSamples,
  validateRecording,
} from './sources.js';
import { MotionObservationSender } from './network.js';
import { LocalMapRenderer, GoogleMapsRenderer } from './maps.js';
import { benchmark } from './benchmark.js';
const $ = (id) => document.getElementById(id),
  set = (id, value) => ($(id).textContent = value);
fetch('/client/version.json', { cache: 'no-store' })
  .then((r) => {
    if (!r.ok) throw new Error('Version saknas');
    return r.json();
  })
  .then((v) => {
    const date = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Stockholm',
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(v.committedAt));
    set('buildVersion', `Senaste commit: ${date} (Stockholm) · ${v.commit.slice(0, 7)}`);
  })
  .catch(() => set('buildVersion', 'Version: commitinformation saknas'));
const labels = {
  Unknown: 'OSÄKER',
  Standing: 'STÅR',
  Walking: 'GÅR',
  Running: 'SPRINGER',
  TurningInPlace: 'VÄNDER',
  WalkingTurn: 'GÅR & SVÄNGER',
  Vehicle: 'FORDON',
  Forklift: 'TRUCK',
  Scooter: 'SPARKCYKEL',
};
const speedHistory = [];
async function datasetHash() {
  const samples =
    mode === 'demo' ? demoSamples() : mode === 'replay' ? loaded.samples : recording.samples;
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(samples))),
    ),
  ]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
const deviceId = localStorage.getItem('qsys-device') ?? crypto.randomUUID();
localStorage.setItem('qsys-device', deviceId);
let session = null,
  sender = null,
  pipeline = null,
  source = null,
  state = null,
  recording = new SessionRecorder(),
  loaded = null,
  running = false,
  mode = 'live',
  truthMode = 'Unknown',
  observations = [],
  benchmarkFiles = {};
let renderer = new LocalMapRenderer($('map'));
renderer.render({
  x: 0,
  y: 0,
  heading: 0,
  trajectory: [{ x: 0, y: 0, distance: 0, t: 0, kind: 'start' }],
  heatmap: [],
});
let networkInterrupted = false;
const statuses = {
  accelerometer: 'unavailable',
  gyroscope: 'unavailable',
  orientation: 'unavailable',
  gps: 'unavailable',
};
const statusLabels = {
  unavailable: 'SAKNAS',
  active: 'AKTIV',
  waiting: 'VÄNTAR',
  stopped: 'STOPPAD',
  denied: 'NEKAD',
  recorded: 'INSPELAD',
};
function notice(message, warning = false) {
  set('notice', message);
  $('notice').classList.toggle('warning', warning);
}
function download(value, name) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    ),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sensorStatus(key, value) {
  statuses[key] = value;
  renderSensors();
}
function renderSensors() {
  const info = [
    ['accelerometer', 'Accelerometer', '⌁'],
    ['gyroscope', 'Gyroskop', '↻'],
    ['orientation', 'Orientering', '◇'],
    ['gravity', 'Gravity', '↓'],
    ['magnetometer', 'Magnetometer', '⊕'],
    ['gps', 'GPS', '⊙'],
  ];
  $('sensors').replaceChildren(
    ...info.map(([key, name, icon]) => {
      const row = document.createElement('div');
      row.className = 'sensor-row';
      const available =
        key === 'gravity'
          ? statuses.accelerometer
          : key === 'magnetometer'
            ? 'limited'
            : statuses[key];
      const reliable =
        key === 'gps'
          ? !!state?.gps.useForCorrection
          : key === 'magnetometer'
            ? false
            : available === 'active' || available === 'recorded';
      const used = key === 'gps' ? !!state?.gps.weight : reliable && running;
      for (const [cls, text] of [
        ['sensor-icon', icon],
        ['', name],
        ['status', available === 'limited' ? 'BEGRÄNSAD' : statusLabels[available]],
        ['flags', `${reliable ? '✓' : '−'} / ${used ? '✓' : '−'}`],
      ]) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        row.append(span);
      }
      return row;
    }),
  );
}
function render(s) {
  if (pipeline) s.deviceHeading = pipeline.heading.deviceYaw;
  state = s;
  set('mode', labels[s.motionMode]);
  set(
    'modeIcon',
    family(s.motionMode) === 'Pedestrian' ? '↟' : family(s.motionMode) === 'Vehicle' ? '▱' : '◎',
  );
  set('distance', s.totalDistance.toFixed(1));
  set('walkDistance', s.walkingDistance.toFixed(1));
  set('runDistance', s.runningDistance.toFixed(1));
  set('vehicleDistance', s.vehicleDistance.toFixed(1));
  set('speed', s.instantaneousSpeed.toFixed(2));
  set('smoothSpeed', s.smoothedSpeed.toFixed(2));
  set('positionConfidence', Math.round(s.positionConfidence * 100));
  set('motionConfidence', `${Math.round(s.motionConfidence * 100)} %`);
  $('motionBar').style.width = `${s.motionConfidence * 100}%`;
  set('posX', s.x.toFixed(2));
  set('posY', s.y.toFixed(2));
  set('heading', Math.round((s.heading + 360) % 360));
  set('steps', s.steps);
  set(
    'elapsed',
    `${Math.floor(s.lastTimestamp / 60)
      .toString()
      .padStart(2, '0')}:${Math.floor(s.lastTimestamp % 60)
      .toString()
      .padStart(2, '0')}`,
  );
  speedHistory.push(s.smoothedSpeed);
  if (speedHistory.length > 8) speedHistory.shift();
  const highest = Math.max(0.1, ...speedHistory);
  set(
    'speedTrace',
    speedHistory.map((x) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((x / highest) * 7))]).join(''),
  );
  set(
    'confidenceNote',
    s.motionFamily === 'Vehicle'
      ? `Fordonssträcka: ${Math.round(s.vehicleDistanceConfidence * 100)} % confidence`
      : 'Kvalitetsindikator · ej validerad sannolikhet',
  );
  const gps = s.gps;
  set('gpsQuality', gps.quality.toUpperCase());
  $('gpsQuality').classList.toggle('active', gps.useForCorrection);
  set('gpsAccuracy', gps.accuracy ? `${gps.accuracy.toFixed(1)} m` : '—');
  set(
    'gpsAge',
    gps.t !== undefined
      ? `${Math.max(0, s.lastTimestamp - gps.t + (gps.age ?? 0)).toFixed(1)} s`
      : '—',
  );
  set(
    'gpsMotion',
    gps.speed !== null && gps.speed !== undefined
      ? `${gps.speed.toFixed(1)} m/s / ${gps.heading === null ? '—' : Math.round(gps.heading) + '°'}`
      : '—',
  );
  set('gpsCorrection', gps.useForCorrection && gps.weight ? 'Aktiv' : 'Av');
  set('gpsReason', gps.reason);
  set('gpsWeight', `${Math.round((gps.weight ?? 0) * 100)} % GPS`);
  $('sourceGps').style.width = `${(gps.weight ?? 0) * 100}%`;
  set('imuWeight', `${Math.round((1 - (gps.weight ?? 0)) * 100)} %`);
  set('sourceName', s.motionFamily === 'Vehicle' ? 'Vehicle inertial' : 'PDR / IMU');
  renderSensors();
  try {
    renderer.render(s);
  } catch (e) {
    fallbackMap(e.message);
  }
}
function fallbackMap(reason) {
  renderer.destroy();
  $('google-map').hidden = true;
  $('map').hidden = false;
  $('background').value = 'local';
  renderer = new LocalMapRenderer($('map'));
  renderer.follow = $('autoZoom').checked;
  renderer.heat = document.querySelector('[data-heat].selected').dataset.heat;
  renderer.render(state);
  notice(`Google Maps unavailable. Tracking continues. ${reason}`, true);
}
function updateDiagnostics() {
  if (!pipeline) return;
  const f = pipeline.features,
    s = pipeline.lastSample;
  set(
    'candidate',
    `Kandidat: ${labels[pipeline.machine.candidate]}${pipeline.preprocessor.calibrated ? '' : ' · Bakgrundskalibrering'}`,
  );
  set('sampleRate', `${Math.round(f?.sampleRate ?? 0)} Hz`);
  set(
    'diagnostics',
    `ACC XYZ: ${s?.linear?.map((x) => x.toFixed(2)).join(' / ') ?? '—'}\nMagnitude: ${s?.norm?.toFixed(2) ?? '—'} m/s²\nGyro XYZ: ${s?.gyro?.map((x) => x.toFixed(2)).join(' / ') ?? '—'}\nGyro norm: ${s?.gyroMagnitude?.toFixed(2) ?? '—'} °/s\nGravity: ${s?.gravity?.map((x) => x.toFixed(2)).join(' / ') ?? '—'}\nPitch / roll: ${s?.orientation?.beta?.toFixed(1) ?? '—'} / ${s?.orientation?.gamma?.toFixed(1) ?? '—'}\nDevice yaw: ${pipeline.heading.deviceYaw.toFixed(1)}°\nTravel heading: ${pipeline.heading.heading.toFixed(1)}°\nHeading confidence: ${(pipeline.heading.confidence * 100).toFixed(0)} %\nCadence: ${f?.cadence?.toFixed(2) ?? '—'} Hz\nPeriodicity: ${f?.periodicity?.toFixed(2) ?? '—'}\nSteps candidate/confirmed/rejected: ${pipeline.steps.candidates}/${pipeline.steps.confirmed}/${pipeline.steps.rejected}\nGPS lat/lon: ${state?.gps?.latitude ?? '—'} / ${state?.gps?.longitude ?? '—'}\nQueue: ${sender?.queue.length ?? 0}\nRequests: ${sender?.requests ?? 0}\nJSON sent: ${((sender?.bytes ?? 0) / 1024).toFixed(1)} KiB\nTraffic: ${sender ? (sender.bytes / 1024 / Math.max(1, (performance.now() - sender.started) / 1000)).toFixed(2) : 0} KiB/s\nACK: ${state?.lastSequence ?? 0}`,
  );
  $('events').replaceChildren(
    ...pipeline.events.map((e) => {
      const row = document.createElement('div');
      row.textContent = `${e.t.toFixed(3)} · ${e.type} ${e.detail}`;
      return row;
    }),
  );
  set(
    'recordStatus',
    `${recording.samples.length.toLocaleString('sv-SE')} samples · ${recording.truth.length} ground truth-markeringar · ${mode === 'demo' ? 'SYNTETISK DEMO' : mode === 'replay' ? 'REPLAY' : 'LIVE'}`,
  );
}
function networkStatus(message) {
  set('connection', `● ${message}`);
  if (message !== 'Ansluten' && sender?.queue.length) {
    networkInterrupted = true;
    notice(
      'Serverpositionen är frusen. Sensorer fortsätter lokalt; observationer återförs när nätverket fungerar.',
      true,
    );
  } else if (message === 'Ansluten' && networkInterrupted) {
    networkInterrupted = false;
    notice('Anslutningen är återställd. Buffrade observationer synkas med servern.');
  }
}
async function newSession() {
  if (sender?.queue.length) {
    await sender.flush();
    if (sender.queue.length)
      throw new Error('Väntar på synk av föregående session. Återanslut innan en ny startas.');
  }
  sender?.stop();
  const response = await fetch('/api/sessions', { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  session = { id: result.id, token: result.token };
  localStorage.setItem('qsys-session', JSON.stringify(session));
  sender = new MotionObservationSender(session, render, networkStatus);
  await sender.start();
  render(result.state);
  const savedCalibration = localStorage.getItem('qsys-calibration');
  if (savedCalibration)
    await sender.request('calibration', { factors: JSON.parse(savedCalibration) });
}
async function start(kind) {
  if (running) return;
  renderer.follow = true;
  $('autoZoom').checked = true;
  pipeline = null;
  running = true;
  mode = kind;
  $('start').disabled = true;
  $('demo').disabled = true;
  $('replay').disabled = true;
  // Live start executes permission APIs before any fetch awaits, preserving the user gesture.
  let pendingLive = null;
  const startupEvents = [];
  const bufferStartup = (event) => {
    startupEvents.push(event);
    if (startupEvents.length > 1500) startupEvents.shift();
  };
  const sample = (s) => {
    if (!pipeline) {
      bufferStartup({ sample: s });
      return;
    }
    recording.add(s);
    try {
      pipeline.process(s);
      if (state && s.t - (pipeline.lastMapUpdate ?? -1) >= 0.1) {
        state.deviceHeading = pipeline.heading.deviceYaw;
        renderer.render(state);
        pipeline.lastMapUpdate = s.t;
      }
    } catch (e) {
      notice(e.message, true);
      stop();
    }
  };
  const gps = (g) => {
    if (!pipeline) {
      bufferStartup({ gps: g });
      return;
    }
    recording.add({ ...g, kind: 'gps' });
    pipeline.gps(g);
  };
  if (kind === 'live') {
    source = new LiveSensorSource(sample, gps, sensorStatus);
    pendingLive = source.start();
    pendingLive.catch(() => {});
  }
  try {
    notice('Startar sensorer och ansluter till servern…');
    const results = await Promise.allSettled([pendingLive ?? Promise.resolve(), newSession()]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    recording = new SessionRecorder();
    recording.source = kind;
    recording.active = $('record').checked;
    observations = [];
    pipeline = new SensorPipeline(
      (o) => {
        observations.push({ ...o, travelHeading: pipeline.heading.heading });
        sender.add(o);
      },
      {
        deviceId,
        sessionId: session.id,
        context: () => ({
          vehicleType: $('vehicleType').value,
          stopConfirmed: $('stopConfirmed').checked,
          gpsSpeed: state?.gps?.useForCorrection ? state.gps.speed : null,
        }),
      },
    );
    for (const event of startupEvents) {
      if (event.sample) sample(event.sample);
      else gps(event.gps);
    }
    startupEvents.length = 0;
    if (kind !== 'live') {
      const samples = kind === 'demo' ? demoSamples() : loaded.samples;
      source = new ReplaySensorSource(samples, sample, gps, () => stop());
      for (const k of ['accelerometer', 'gyroscope', 'orientation']) sensorStatus(k, 'recorded');
      await source.start();
      if (kind === 'replay') recording.truth = structuredClone(loaded.groundTruth ?? []);
    }
    $('stop').hidden = false;
    $('start').hidden = true;
    notice(
      kind === 'demo'
        ? 'SYNTETISK DEMO · Gång, stopp och 90° sväng. Inga riktiga sensorer används.'
        : kind === 'replay'
          ? 'REPLAY · Inspelade samples går genom samma pipeline som live.'
          : 'LIVE · Loggar direkt. Du kan börja gå; kalibrering sker i bakgrunden.',
    );
  } catch (e) {
    source?.stop();
    running = false;
    pipeline = null;
    $('start').disabled = false;
    $('demo').disabled = false;
    $('replay').disabled = !loaded;
    notice(e.message, true);
  }
}
async function stop() {
  source?.stop();
  if (pipeline?.lastSample) {
    const t = pipeline.lastSample.t;
    pipeline.send({
      timestamp: t,
      type: 'Heartbeat',
      headingDelta: 0,
      headingConfidence: pipeline.heading.confidence,
      steps: [],
      vehicle: {
        duration: 0,
        accelerationIntegral: 0,
        forwardAccelerationMean: 0,
        forwardAccelerationVariance: 0,
        stationaryProbability: 0,
        stopConfirmed: false,
      },
      orientationReliable: false,
    });
  }
  running = false;
  recording.active = false;
  $('stop').hidden = true;
  $('start').hidden = false;
  $('start').disabled = false;
  $('demo').disabled = false;
  $('replay').disabled = !loaded;
  await sender?.flush();
  if (sender?.store.db) await sender.store.set('last-recording', recording.export());
  notice(
    'Mätningen är stoppad. Exportera inspelning och resultat för att jämföra algoritmversioner.',
  );
  renderSensors();
}
function requireSession() {
  if (!session) throw new Error('Starta en mätning eller demo först.');
}
const safely = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (error) {
    notice(error.message, true);
  }
};
$('start').onclick = () => start('live');
$('demo').onclick = () => start('demo');
$('stop').onclick = safely(stop);
$('replay').onclick = () => start('replay');
$('record').onchange = () => (recording.active = running && $('record').checked);
$('export').onclick = () => download(recording.export(), 'qsys-recording.json');
$('exportRing').onclick = () =>
  download(
    {
      format: 'qsys-recording',
      version: 1,
      samples: pipeline?.raw.samples ?? [],
      groundTruth: recording.truth,
    },
    'qsys-ringbuffer.json',
  );
$('import').onchange = safely(async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 100000000) throw new Error('Max 100 MB per inspelning.');
  loaded = validateRecording(JSON.parse(await file.text()));
  $('replay').disabled = running;
  notice(`Inspelning laddad: ${loaded.samples.length} samples. Tryck Replay.`);
});
$('exportResult').onclick = safely(async () => {
  requireSession();
  await sender.flush();
  if (sender.queue.length) throw new Error('Synka utgående kö innan resultat exporteras.');
  const r = await fetch(`/api/sessions/${session.id}`, {
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!r.ok) throw new Error('Kunde inte läsa serverresultat');
  const full = await r.json();
  download(
    {
      format: 'qsys-result',
      version: 1,
      algorithmVersion: C.version,
      datasetHash: await datasetHash(),
      source: mode,
      state: full,
      observations,
      groundTruth: recording.truth,
    },
    `qsys-result-${C.version}.json`,
  );
});
async function mark(mode, extra = {}) {
  requireSession();
  const t = pipeline?.lastSample?.t ?? state.lastTimestamp;
  truthMode = mode;
  recording.mark(t, mode, extra);
  await sender.request('truth', { t, mode, ...extra });
  notice(`Ground truth markerad: ${labels[mode]}`);
}
for (const b of document.querySelectorAll('[data-truth]'))
  b.onclick = safely(async () => {
    await mark(b.dataset.truth);
    for (const other of document.querySelectorAll('[data-truth]'))
      other.classList.toggle('marked', other === b);
  });
$('markPosition').onclick = safely(() => {
  if ($('knownX').value === '' || $('knownY').value === '') throw new Error('Ange X och Y.');
  return mark(truthMode, {
    position: { x: Number($('knownX').value), y: Number($('knownY').value) },
  });
});
$('markReference').onclick = safely(() => {
  const extra = {};
  if ($('knownSteps').value !== '') extra.knownSteps = Number($('knownSteps').value);
  if ($('knownHeading').value !== '') extra.heading = Number($('knownHeading').value);
  if ($('knownDistance').value !== '') extra.knownDistance = Number($('knownDistance').value);
  if (!Object.keys(extra).length) throw new Error('Ange kända steg, kurs eller sträcka.');
  return mark(truthMode, extra);
});
$('calibrate').onclick = safely(async () => {
  requireSession();
  if (running) throw new Error('Stoppa efter kalibreringssträckan först.');
  const distance = Number($('knownDistance').value);
  if (!(distance > 0)) throw new Error('Ange en känd sträcka.');
  await sender.flush();
  if (sender.queue.length) throw new Error('Vänta tills sessionen är synkad.');
  await sender.request('calibration', {
    kind: $('calibrationKind').value,
    actualDistance: distance,
  });
  await mark($('calibrationKind').value === 'walking' ? 'Walking' : 'Running', {
    knownDistance: distance,
  });
  notice('Kalibreringsfaktor sparad. Används för kommande observationer i denna session.');
  localStorage.setItem('qsys-calibration', JSON.stringify(state.calibration));
});
$('deleteSession').onclick = safely(async () => {
  requireSession();
  await stop();
  const r = await fetch(`/api/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${session.token}` },
  });
  if (!r.ok) throw new Error('Sessionen kunde inte raderas');
  await sender.store.set(session.id, []);
  await sender.store.set('last-recording', null);
  sender.stop();
  session = null;
  localStorage.removeItem('qsys-session');
  recording = new SessionRecorder();
  pipeline = null;
  state = null;
  notice('Session och lokal inspelning raderade.');
});
for (const b of document.querySelectorAll('[data-heat]'))
  b.onclick = () => {
    for (const other of document.querySelectorAll('[data-heat]'))
      other.classList.toggle('selected', other === b);
    renderer.heat = b.dataset.heat;
    renderer.render(state);
  };
$('zoomIn').onclick = () => {
  if (renderer instanceof LocalMapRenderer) {
    renderer.follow = false;
    $('autoZoom').checked = false;
    renderer.zoom = Math.min(120, renderer.zoom * 1.25);
    renderer.render(state);
  }
};
$('zoomOut').onclick = () => {
  if (renderer instanceof LocalMapRenderer) {
    renderer.follow = false;
    $('autoZoom').checked = false;
    renderer.zoom = Math.max(2, renderer.zoom / 1.25);
    renderer.render(state);
  }
};
$('recenter').onclick = () => {
  renderer.follow = true;
  $('autoZoom').checked = true;
  renderer.render(state);
};
$('autoZoom').onchange = () => {
  renderer.follow = $('autoZoom').checked;
  renderer.render(state);
};
$('background').onchange = safely(async () => {
  if ($('background').value === 'local') {
    fallbackMap('Lokal karta vald');
    return;
  }
  try {
    if (!state?.origin || state.geographicHeading === null)
      throw new Error('Inväntar god GPS med färdriktning.');
    const next = new GoogleMapsRenderer($('google-map'));
    $('google-map').hidden = false;
    await next.initialize($('mapsKey').value.trim());
    renderer.destroy();
    $('map').hidden = true;
    renderer = next;
    renderer.heat = document.querySelector('[data-heat].selected').dataset.heat;
    renderer.render(state);
  } catch (e) {
    fallbackMap(e.message);
  }
});
for (const id of ['benchmarkA', 'benchmarkB'])
  $(id).onchange = safely(async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const result = JSON.parse(await file.text());
    if (result.format !== 'qsys-result' || !Array.isArray(result.state?.trajectory))
      throw new Error('Välj ett exporterat Qsys-resultat.');
    benchmarkFiles[id] = benchmark(result);
    const a = benchmarkFiles.benchmarkA,
      b = benchmarkFiles.benchmarkB;
    if (!a || !b) {
      set('benchmarkResults', 'Läs även det andra resultatet.');
      return;
    }
    const names = {
      modeAccuracy: 'Transport accuracy (%)',
      falseTransitions: 'Felaktiga övergångar',
      confirmedSteps: 'Bekräftade steg',
      falseSteps: 'Falska steg (märkt stilla)',
      stepCountError: 'Stegantalets fel',
      headingError: 'Heading error (°)',
      distanceError: 'Distance error (m)',
      endpointError: 'Endpoint error (m)',
      trajectoryError: 'Trajectory RMSE (m)',
      gpsCorrectionCount: 'GPS corrections',
    };
    const table = document.createElement('table');
    const header = document.createElement('tr');
    for (const text of ['Mått', `A · ${a.algorithmVersion}`, `B · ${b.algorithmVersion}`]) {
      const th = document.createElement('th');
      th.textContent = text;
      header.append(th);
    }
    table.append(header);
    for (const [key, name] of Object.entries(names)) {
      const row = document.createElement('tr');
      for (const value of [name, a[key], b[key]]) {
        const td = document.createElement('td');
        td.textContent =
          value === null ? 'Ej mätbar' : typeof value === 'number' ? value.toFixed(2) : value;
        row.append(td);
      }
      table.append(row);
    }
    $('benchmarkResults').replaceChildren(table);
    if (!a.datasetHash || a.datasetHash !== b.datasetHash) {
      const warning = document.createElement('p');
      warning.textContent =
        'OBS: Dataset skiljer sig eller saknar identifierare. Jämförelsen är inte kontrollerad.';
      warning.className = 'footnote';
      $('benchmarkResults').prepend(warning);
    }
  });
setInterval(updateDiagnostics, 300);
renderSensors();
// Restore an interrupted outgoing queue before allowing another recording session.
async function restore() {
  const saved = localStorage.getItem('qsys-session');
  if (!saved) return;
  try {
    session = JSON.parse(saved);
    sender = new MotionObservationSender(session, render, networkStatus);
    await sender.start();
    const r = await fetch(`/api/sessions/${session.id}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (r.ok) render(await r.json());
    else if (r.status === 404 || r.status === 401) {
      sender.stop();
      session = null;
      localStorage.removeItem('qsys-session');
      return;
    }
    const previous = await sender.store.get('last-recording');
    if (previous) {
      recording.samples = previous.samples;
      recording.source = previous.source ?? 'replay';
      mode = recording.source;
      recording.truth = previous.groundTruth;
      loaded = previous;
      $('replay').disabled = false;
      set(
        'recordStatus',
        `${previous.samples.length} samples återställda från senaste stoppade inspelning.`,
      );
      notice(
        mode === 'demo'
          ? 'Återställd SYNTETISK DEMO · Inga riktiga sensormätningar.'
          : 'Föregående inspelning återställd. Starta en ny mätning eller använd Replay.',
      );
    }
    await sender.flush();
  } catch (e) {
    notice(`Återställning: ${e.message}`, true);
  }
}
await restore();
// iOS permission APIs require a real tap; other supported browsers can start
// directly. Never emulate a user gesture or bypass a browser permission.
const needsSensorGesture = [globalThis.DeviceMotionEvent, globalThis.DeviceOrientationEvent].some(
  (type) => typeof type?.requestPermission === 'function',
);
if (globalThis.isSecureContext && globalThis.DeviceMotionEvent && !needsSensorGesture) {
  await start('live');
} else if (needsSensorGesture) {
  $('start').textContent = 'Tillåt sensorer och logga';
  notice('Tryck för att tillåta sensorer. Loggningen börjar direkt utan stillakalibrering.');
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running)
    notice(
      'Appen är i bakgrunden. Webbläsaren kan pausa sensorer; håll skärmen aktiv under mätningen.',
      true,
    );
});
