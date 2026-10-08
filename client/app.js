import { TestSession, testTypes, bodyPoses, vehiclePoses } from './test-session.js';
import { config as C } from '../shared/config.js';
import { WalkingTracker } from './walking.js';
import { LiveSensorSource } from './sources.js';
import { LocalMapRenderer, orangeMarker } from './maps.js';
const $ = (id) => document.getElementById(id);
let testSession = null,
  testSaving = false;
let tracker = new WalkingTracker({ stepLength: 0.76 }),
  calibratedLength = 0.76,
  calibrating = false,
  calibrationMeters = 0,
  source = null,
  running = false,
  starting = false,
  sampleOrigin = null;
const statuses = {};
const segments = [],
  statusEvents = [],
  markers = [];
let build = null,
  phase = 'walking';
const openedAt = new Date().toISOString();
let historyStartedAt = openedAt;
function archiveSegment(nextPhase) {
  segments.push({
    phase,
    sourceTimeOrigin: sampleOrigin,
    calibrationMeters,
    history: tracker.exportHistory(),
  });
  phase = nextPhase;
}

const map = new LocalMapRenderer($('map'));
function render() {
  if (testSession) {
    $('testLiveSteps').textContent = testSession.metadata.stepsEnabled
      ? testSession.tracker.state.steps
      : '—';
    $('testLiveSamples').textContent = testSession.tracker.raw.length;
    $('testLiveTime').textContent = Math.floor(testSession.tracker.state.t ?? 0) + ' s';
  }
  const s = tracker.state;
  $('activity').textContent = s.activity.label;
  $('activityProbability').textContent =
    'Uppskattad sannolikhet: ' +
    (s.activity.probability ? Math.round(s.activity.probability * 100) + ' %' : '—');
  $('activityNote').textContent = s.vehicle
    ? 'Experimentell fordonssträcka från acceleration. Antagen starthastighet 0; mätfel driver över tid. ' +
      (s.vehicle.valid
        ? 'Uppskattad hastighet: ' + (s.vehicle.speed * 3.6).toFixed(1) + ' km/h.'
        : 'Inväntar giltig orientering och sammanhängande sensordata.')
    : 'Preliminär sensorbedömning, inte validerad sannolikhet. Vagn och truck kan inte skiljas säkert automatiskt.';
  map.render({ ...s, markers: markers.filter((m) => m.segment === segments.length) });
  $('markDeviation').disabled = !tracker.drawing;
  $('distance').textContent = s.distance.toLocaleString('sv-SE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  $('steps').textContent = s.steps;
  $('heading').textContent = Math.round(s.heading) + '°';
  $('calibrationSteps').textContent = calibrating ? s.steps : 0;
  $('finishCalibration').disabled = !!testSession?.active || testSaving || !calibrating || !s.steps;
}
function message(text) {
  $('message').textContent = text;
}
let pendingFrame = false;
function scheduleRender() {
  if (pendingFrame) return;
  pendingFrame = true;
  requestAnimationFrame(() => {
    pendingFrame = false;
    render();
  });
}
async function connectSensors() {
  if (running || starting) return;
  starting = true;
  $('permission').disabled = true;
  source = new LiveSensorSource(
    (sample) => {
      testSession?.process(sample);
      sampleOrigin ??= sample.t;
      sample = { ...sample, sourceT: sample.t, t: sample.t - sampleOrigin };
      tracker.transportType = $('transportType').value;
      tracker.process(sample);
      scheduleRender();
    },
    () => {},
    (key, value) => {
      if (statuses[key] !== value)
        statusEvents.push({ at: new Date().toISOString(), sensor: key, status: value });
      if (statuses[key] !== value)
        testSession?.event({ at: new Date().toISOString(), sensor: key, status: value });
      statuses[key] = value;
      $('sensors').textContent = Object.entries(statuses)
        .map(([k, v]) => k + ': ' + v)
        .join(' · ');
      if (key === 'accelerometer' && value === 'unavailable')
        message('Ingen accelerometerdata. Kontrollera sensorbehörighet och håll sidan öppen.');
    },
    (orientation, t) => {
      testSession?.orient(orientation, t);
      sampleOrigin ??= t;
      tracker.orient(orientation, t - sampleOrigin);
      scheduleRender();
    },
  );
  try {
    await source.start();
    running = true;
    $('permission').hidden = true;
    $('status').textContent = 'Loggar';
    message('Sensorerna är anslutna. Kartan ritas med 0,76 m/steg. Du kan kalibrera vid behov.');
  } catch (error) {
    source?.stop();
    source = null;
    $('permission').hidden = false;
    $('status').textContent = 'Sensorer ej anslutna';
    message(error.message);
  } finally {
    starting = false;
    $('permission').disabled = false;
  }
}
function testOptions() {
  const type = $('testType').value;
  const vehicle = testTypes[type].vehicle;
  $('testPose').replaceChildren(
    ...Object.entries(vehicle ? vehiclePoses : bodyPoses).map(
      ([value, label]) => new Option(label, value),
    ),
  );
  $('testSpeedLabel').hidden = !vehicle;
  $('testDistanceLabel').hidden = type === 'Standing';
  $('testInstructions').textContent = vehicle
    ? 'Telefonen ska ligga fixerad på fordonet. Välj telefonläge, fart och en känd sträcka. Inga steg eller steglängder registreras.'
    : type === 'Standing'
      ? 'Stå kvar på samma plats. Eventuella registrerade steg blir exempel på falska steg.'
      : 'Gå eller spring med valt telefonläge. Stegen visas live. Testet ändrar inte din kalibrerade steglängd.';
}
function lockTest(locked) {
  for (const id of [
    'testType',
    'testPose',
    'testSpeed',
    'testDistance',
    'beginCalibration',
    'finishCalibration',
    'reset',
  ])
    $(id).disabled = locked;
}
$('testType').onchange = testOptions;
testOptions();
$('startTest').onclick = async () => {
  if (testSaving || testSession?.active) return;
  if (calibrating) {
    $('testStatus').textContent =
      'Avsluta steglängdskalibreringen innan du startar ett sensortest.';
    return;
  }
  $('startTest').disabled = true;
  if (!running) await connectSensors();
  if (!running) {
    $('startTest').disabled = false;
    return;
  }
  try {
    const distance = $('testDistance').value.trim();
    testSession = new TestSession({
      type: $('testType').value,
      pose: $('testPose').value,
      speed: $('testSpeed').value,
      distance: distance ? Number(distance) : null,
    });
    testSession.event({
      at: new Date().toISOString(),
      type: 'initial-sensor-status',
      statuses: structuredClone(statuses),
    });
    lockTest(true);
    $('finishTest').disabled = false;
    $('finishTest').textContent = 'Avsluta och spara på servern';
    $('testSavedFile').hidden = true;
    $('testStatus').textContent =
      'Test pågår: ' + testSession.metadata.label + ' – ' + testSession.metadata.poseLabel;
    render();
  } catch (error) {
    $('testStatus').textContent = error.message;
    $('startTest').disabled = false;
  }
};
$('finishTest').onclick = async () => {
  if (!testSession || testSaving) return;
  if (!testSession.tracker.raw.length) {
    $('testStatus').textContent =
      'Inga sensorprov har kommit. Kontrollera sensorbehörigheten innan testet avslutas.';
    return;
  }
  testSaving = true;
  $('finishTest').disabled = true;
  const data = testSession.finish({
    build,
    configuration: C,
    environment: { userAgent: navigator.userAgent, secureContext: globalThis.isSecureContext },
    units: {
      time: 'seconds since test source origin',
      acceleration: 'm/s²',
      gyro: 'degrees/second',
      orientation: 'degrees',
      distance: 'metres',
    },
  });
  $('testStatus').textContent = 'Test avslutat. Sparar sensordata på servern…';
  render();
  try {
    const response = await fetch('/api/sensor-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok)
      throw new Error(
        response.status === 413
          ? 'Testfilen är större än 25 MB. Testet finns kvar i minnet.'
          : 'Kunde inte spara testet (' + response.status + ').',
      );
    const saved = await response.json();
    const link = $('testSavedFile');
    link.href = saved.downloadUrl;
    link.textContent = saved.filename;
    link.hidden = false;
    $('testStatus').textContent = 'Sparat på servern. Klicka på filnamnet för att hämta filen.';
    lockTest(false);
    $('finishCalibration').disabled = !calibrating || !tracker.state.steps;
    $('startTest').disabled = false;
  } catch (error) {
    $('testStatus').textContent = error.message + ' Tryck Spara igen. Ladda inte om sidan.';
    $('finishTest').textContent = 'Spara testet igen';
    $('finishTest').disabled = false;
  } finally {
    testSaving = false;
  }
};
$('permission').onclick = connectSensors;
function captureMapImage() {
  map.render(
    { ...tracker.state, markers: markers.filter((m) => m.segment === segments.length) },
    { instant: true },
  );
  return $('map').toDataURL('image/png');
}
$('reset').onclick = () => {
  segments.length = 0;
  statusEvents.length = 0;
  markers.length = 0;
  historyStartedAt = new Date().toISOString();
  phase = calibratedLength !== null ? 'walking' : 'waiting';
  $('savedFile').hidden = true;
  $('savedFile').removeAttribute('href');
  $('savedFile').textContent = '';
  tracker = new WalkingTracker({
    stepLength: calibratedLength ?? 0.76,
    drawing: calibratedLength !== null,
  });
  calibrating = false;
  $('beginCalibration').disabled = false;
  $('calibrationMeters').disabled = false;
  sampleOrigin = null;
  render();
  message(
    running
      ? calibratedLength !== null
        ? 'Ny karta. Ritningen fortsätter med vald steglängd.'
        : 'Kalibrera steglängden innan du börjar.'
      : 'Ny karta. Inväntar sensorbehörighet.',
  );
};
$('beginCalibration').onclick = () => {
  const meters = Number($('calibrationMeters').value);
  if (!Number.isFinite(meters) || meters <= 0) {
    message('Ange en sträcka större än noll meter.');
    return;
  }
  if (!running) connectSensors();
  archiveSegment('calibration');
  calibrationMeters = meters;
  calibrating = true;
  tracker = new WalkingTracker({ drawing: false });
  sampleOrigin = null;
  $('beginCalibration').disabled = true;
  $('calibrationMeters').disabled = true;
  message('Gå ' + meters.toLocaleString('sv-SE') + ' meter. Tryck sedan Klar – börja rita.');
  render();
};
$('finishCalibration').onclick = () => {
  if (!calibrating || !tracker.state.steps) return;
  calibratedLength = calibrationMeters / tracker.state.steps;
  archiveSegment('walking');
  $('stride').textContent =
    calibratedLength.toLocaleString('sv-SE', { maximumFractionDigits: 3 }) + ' m/steg';
  calibrating = false;
  tracker = new WalkingTracker({ stepLength: calibratedLength });
  sampleOrigin = null;
  $('beginCalibration').disabled = false;
  $('calibrationMeters').disabled = false;
  message('Kalibrering klar. Kartan ritas nu med din steglängd.');
  render();
};
$('markDeviation').onclick = () => {
  const marker = orangeMarker(tracker.state, markers.length, segments.length);
  if (!tracker.drawing || !marker) return;
  markers.push(marker);
  render();
  message('Markör ' + marker.id + ' fäst på orange linje och sparad i historiken.');
};
function historyPayload() {
  render();
  const data = {
    format: 'qsys-sensor-history',
    version: 1,
    openedAt,
    historyStartedAt,
    exportedAt: new Date().toISOString(),
    build,
    configuration: C,
    calibratedStepLength: calibratedLength,
    environment: { userAgent: navigator.userAgent, secureContext: globalThis.isSecureContext },
    statuses,
    statusEvents,
    markers,
    segments: [
      ...segments,
      {
        phase,
        sourceTimeOrigin: sampleOrigin,
        calibrationMeters,
        history: tracker.exportHistory(),
      },
    ],
    units: {
      time: 'seconds; segment origin in sourceTimeOrigin',
      acceleration: 'm/s²',
      gyro: 'degrees/second',
      orientation: 'degrees',
      distance: 'metres',
    },
    mapImage: captureMapImage(),
  };
  return data;
}
$('exportHistory').onclick = () => {
  const data = historyPayload();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'qsys-sensorhistorik.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  message('Historiken är exporterad. Bifoga JSON-filen här för felsökning.');
};
$('saveServer').onclick = async () => {
  const button = $('saveServer');
  button.disabled = true;
  const savingHistoryStartedAt = historyStartedAt;
  message('Sparar sensorhistoriken på servern…');
  try {
    const data = historyPayload();
    data.description = $('historyName').value.trim() || 'gangkarta';
    const response = await fetch('/api/sensor-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!response.ok)
      throw new Error(
        response.status === 413
          ? 'Historiken är för stor för servern (max 25 MB). Använd lokal export.'
          : 'Servern kunde inte spara filen (' + response.status + ').',
      );
    const saved = await response.json();
    if (savingHistoryStartedAt !== historyStartedAt) return;
    const link = $('savedFile');
    link.href = saved.downloadUrl;
    link.textContent = saved.filename;
    link.hidden = false;
    message(
      'Filen är sparad på servern. Klicka på filnamnet för att hämta den och bifoga den här.',
    );
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
};
$('autoZoom').onchange = () => {
  map.follow = $('autoZoom').checked;
  render();
};
fetch('/client/version.json', { cache: 'no-store' })
  .then((r) => r.json())
  .then((v) => {
    build = v;
    $('buildVersion').textContent =
      'Senaste commit: ' +
      new Date(v.committedAt).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm' }) +
      ' · ' +
      v.commit.slice(0, 7);
  })
  .catch(() => ($('buildVersion').textContent = 'Version saknas'));
document.addEventListener('visibilitychange', () => {
  testSession?.event({ at: new Date().toISOString(), type: 'visibility', hidden: document.hidden });
  if (document.hidden && running)
    message('Håll sidan synlig. Webbläsaren kan pausa sensorer i bakgrunden.');
});
render();
const needsGesture = [globalThis.DeviceMotionEvent, globalThis.DeviceOrientationEvent].some(
  (type) => typeof type?.requestPermission === 'function',
);
if (needsGesture) {
  $('permission').hidden = false;
  message('Tillåt rörelsesensorerna. Därefter loggas rörelsen automatiskt.');
} else await connectSensors();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
