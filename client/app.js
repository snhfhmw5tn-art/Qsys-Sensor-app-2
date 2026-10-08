import { config as C } from '../shared/config.js';
import { WalkingTracker } from './walking.js';
import { LiveSensorSource, compassLabel } from './sources.js';
import { LocalMapRenderer, orangeMarker } from './maps.js';
const $ = (id) => document.getElementById(id);
let adjustmentWindowMs = 700;
let compass = null;
let gyroHeading = 0,
  gyroTime = null,
  gyroAvailable = false,
  accelerationG = null;
const compassEvents = [];
let tracker = new WalkingTracker({ stepLength: 0.76, adjustmentWindowMs }),
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
  const s = tracker.state;
  $('directionArrow').setAttribute('transform', 'rotate(' + (compass?.heading ?? 0) + ' 110 110)');
  $('directionArrow').style.display = compass ? '' : 'none';
  $('compassValue').textContent = compass ? compassLabel(compass.heading) : 'Data saknas';
  $('phoneArrow').setAttribute('transform', 'rotate(' + s.deviceHeading + ' 110 110)');
  $('phoneValue').textContent = Math.round(s.deviceHeading) + '° från start';
  $('travelArrow').setAttribute('transform', 'rotate(' + s.heading + ' 110 110)');
  $('travelArrow').setAttribute(
    'stroke-dasharray',
    s.directionQuality === 'supported' ? 'none' : '5 4',
  );
  $('travelValue').textContent =
    Math.round(s.heading) +
    '° från start' +
    (s.directionQuality === 'supported' ? '' : ' · osäker');

  $('gyroArrow').setAttribute('transform', 'rotate(' + gyroHeading + ' 110 110)');
  $('gyroArrow').style.display = gyroAvailable ? '' : 'none';
  $('gyroValue').textContent = gyroAvailable
    ? Math.round(gyroHeading) + '° från start'
    : 'Data saknas';
  $('accelDot').style.display = accelerationG ? '' : 'none';
  if (accelerationG) {
    const [x, y, z] = accelerationG;
    const radius = Math.hypot(x, y),
      scale = radius > 2 ? 2 / radius : 1;
    $('accelDot').setAttribute('cx', 110 + x * scale * 40);
    $('accelDot').setAttribute('cy', 110 - y * scale * 40);
    $('accelValue').textContent =
      'X ' + x.toFixed(2) + ' · Y ' + y.toFixed(2) + ' · Z ' + z.toFixed(2) + ' g';
  } else $('accelValue').textContent = 'Data saknas';
  map.render({ ...s, markers: markers.filter((m) => m.segment === segments.length) });
  $('markDeviation').disabled = !tracker.drawing;
  $('distance').textContent = s.distance.toLocaleString('sv-SE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  $('steps').textContent = s.steps;
  $('heading').textContent = Math.round(s.heading) + '°';
  $('directionQuality').textContent =
    s.directionQuality === 'supported'
      ? 'Färdriktning: stöds av gångmönstret'
      : 'Färdriktning: osäker – inväntar gångmönster';
  $('calibrationSteps').textContent = calibrating ? s.steps : 0;
  $('finishCalibration').disabled = !calibrating || !s.steps;
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
      sampleOrigin ??= sample.t;
      sample = { ...sample, sourceT: sample.t, t: sample.t - sampleOrigin };
      tracker.process(sample);
      const rate = tracker.history.at(-1)?.yawRate;
      gyroAvailable = Array.isArray(sample.gyro) && Number.isFinite(rate);
      if (gyroAvailable && gyroTime !== null) {
        const dt = sample.t - gyroTime;
        if (dt > 0 && dt <= 0.5) gyroHeading = ((gyroHeading - rate * dt + 540) % 360) - 180;
      }
      gyroTime = sample.t;
      accelerationG = sample.gravityAcceleration?.map((v) => v / C.gravity) ?? null;
      scheduleRender();
    },
    () => {},
    (key, value) => {
      if (statuses[key] !== value)
        statusEvents.push({ at: new Date().toISOString(), sensor: key, status: value });
      statuses[key] = value;
      $('sensors').textContent = Object.entries(statuses)
        .map(([k, v]) => k + ': ' + v)
        .join(' · ');
      if (key === 'accelerometer' && value === 'unavailable')
        message('Ingen accelerometerdata. Kontrollera sensorbehörighet och håll sidan öppen.');
    },
    (orientation, t) => {
      sampleOrigin ??= t;
      tracker.orient(orientation, t - sampleOrigin);
      scheduleRender();
    },
    (reading, t) => {
      compass = reading;
      compassEvents.push({
        at: new Date().toISOString(),
        sourceT: t,
        segment: segments.length,
        ...(reading ?? { heading: null, status: 'stale' }),
      });
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
$('permission').onclick = connectSensors;
function selectView(reference) {
  $('referenceView').hidden = !reference;
  document.body.classList.toggle('reference-mode', reference);
  $('mapView').hidden = reference;
  $('showMap').setAttribute('aria-pressed', String(!reference));
  $('showReference').setAttribute('aria-pressed', String(reference));
  render();
}
$('showMap').onclick = () => selectView(false);
$('showReference').onclick = () => selectView(true);
function captureMapImage() {
  const hidden = $('mapView').hidden;
  $('mapView').hidden = false;
  try {
    map.render({ ...tracker.state, markers: markers.filter((m) => m.segment === segments.length) });
    return $('map').toDataURL('image/png');
  } finally {
    $('mapView').hidden = hidden;
  }
}
$('adjustmentWindow').onchange = () => {
  const input = $('adjustmentWindow');
  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 400 || value > 5000) {
    input.value = adjustmentWindowMs;
    message('Ange ett analysfönster mellan 400 och 5000 ms.');
    return;
  }
  adjustmentWindowMs = value;
  tracker.travel.setAdjustmentWindow(value);
  statusEvents.push({
    at: new Date().toISOString(),
    type: 'analysis-window',
    adjustmentWindowMs: value,
    segment: segments.length,
    t: tracker.state.t ?? 0,
  });
  message('Analysfönster: ' + value + ' ms.');
};
$('reset').onclick = () => {
  segments.length = 0;
  statusEvents.length = 0;
  markers.length = 0;
  gyroHeading = 0;
  gyroTime = null;
  gyroAvailable = false;
  accelerationG = null;
  compassEvents.length = 0;
  historyStartedAt = new Date().toISOString();
  phase = calibratedLength !== null ? 'walking' : 'waiting';
  $('savedFile').hidden = true;
  $('savedFile').removeAttribute('href');
  $('savedFile').textContent = '';
  tracker = new WalkingTracker({
    stepLength: calibratedLength ?? 0.76,
    adjustmentWindowMs,
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
  tracker = new WalkingTracker({ drawing: false, adjustmentWindowMs });
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
  tracker = new WalkingTracker({ stepLength: calibratedLength, adjustmentWindowMs });
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
    adjustmentWindowMs,
    environment: { userAgent: navigator.userAgent, secureContext: globalThis.isSecureContext },
    statuses,
    statusEvents,
    markers,
    compass: { current: compass, events: compassEvents },
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
