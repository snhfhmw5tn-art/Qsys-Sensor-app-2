import { WalkingTracker } from './walking.js';
import { LiveSensorSource } from './sources.js';
import { LocalMapRenderer } from './maps.js';
const $ = (id) => document.getElementById(id);
let tracker = new WalkingTracker(),
  source = null,
  running = false,
  starting = false,
  build = null,
  markers = [],
  sampleOrigin = null;
const statuses = {};
const map = new LocalMapRenderer($('map'));
function render() {
  const s = tracker.state;
  map.render(s);
  $('distance').textContent = s.distance.toLocaleString('sv-SE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  $('steps').textContent = s.steps;
  $('heading').textContent = Math.round(s.deviceHeading) + '°';
}
function message(text) {
  $('message').textContent = text;
}
async function connectSensors() {
  if (running || starting) return;
  starting = true;
  $('permission').disabled = true;
  source = new LiveSensorSource(
    (sample) => {
      sampleOrigin ??= sample.t;
      sample = { ...sample, t: sample.t - sampleOrigin };
      tracker.process(sample);
      if (sample.t - (tracker.lastRender ?? -1) >= 0.1) {
        render();
        tracker.lastRender = sample.t;
      }
    },
    () => {},
    (key, value) => {
      statuses[key] = value;
      $('sensors').textContent = Object.entries(statuses)
        .map(([k, v]) => k + ': ' + v)
        .join(' · ');
      if (key === 'accelerometer' && value === 'unavailable')
        message('Ingen accelerometerdata. Kontrollera sensorbehörighet och håll sidan öppen.');
    },
  );
  try {
    await source.start();
    running = true;
    $('permission').hidden = true;
    $('status').textContent = 'Loggar';
    message('Loggar sensorer. Börja gå med telefonen riktad framåt.');
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
$('reset').onclick = () => {
  tracker = new WalkingTracker();
  markers = [];
  sampleOrigin = null;
  render();
  message(
    running
      ? 'Ny karta. Sensorerna fortsätter logga direkt.'
      : 'Ny karta. Inväntar sensorbehörighet.',
  );
};
$('autoZoom').onchange = () => {
  map.follow = $('autoZoom').checked;
  render();
};
function save(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('mark').onclick = () => {
  markers.push({ t: tracker.state.t ?? 0, x: tracker.state.x, y: tracker.state.y });
  message('Avvikelse tidsmarkerad. Spara sensorhistoriken efter promenaden.');
};
$('export').onclick = () => {
  render();
  save(
    new Blob(
      [
        JSON.stringify({
          format: 'qsys-walking-debug',
          version: 1,
          created: new Date().toISOString(),
          build,
          stepLength: 0.7,
          environment: {
            userAgent: navigator.userAgent,
            secureContext: globalThis.isSecureContext,
            statuses,
          },
          samples: tracker.raw,
          history: tracker.history,
          state: tracker.state,
          markers,
          mapImage: $('map').toDataURL('image/png'),
        }),
      ],
      { type: 'application/json' },
    ),
    'qsys-ganghistorik.json',
  );
};
$('image').onclick = () => {
  render();
  $('map').toBlob((blob) => {
    if (blob) save(blob, 'qsys-gangkarta.png');
  });
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
