import { WalkingTracker } from './walking.js';
import { LiveSensorSource } from './sources.js';
import { LocalMapRenderer } from './maps.js';
const $ = (id) => document.getElementById(id);
let tracker = new WalkingTracker(),
  source = null,
  running = false,
  starting = false,
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
      sample = { ...sample, t: sample.t - sampleOrigin };
      tracker.process(sample);
      scheduleRender();
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
    (orientation, t) => {
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
fetch('/client/version.json', { cache: 'no-store' })
  .then((r) => r.json())
  .then((v) => {
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
