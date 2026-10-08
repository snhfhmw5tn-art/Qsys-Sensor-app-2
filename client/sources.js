export class ISensorSource {
  async start() {
    throw new Error('Implement start');
  }
  stop() {
    throw new Error('Implement stop');
  }
}
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const vector = (o) => (o && [o.x, o.y, o.z].every(finite) ? [o.x, o.y, o.z] : null);
const normalizeHeading = (value) => ((value % 360) + 360) % 360;
export function compassReading(e) {
  if (finite(e.webkitCompassHeading)) {
    if (finite(e.webkitCompassAccuracy) && e.webkitCompassAccuracy < 0) return null;
    return {
      heading: normalizeHeading(e.webkitCompassHeading),
      source: 'webkit-compass',
      accuracy: finite(e.webkitCompassAccuracy) ? e.webkitCompassAccuracy : null,
    };
  }
  if (e.absolute !== true || ![e.alpha, e.beta, e.gamma].every(finite)) return null;
  // W3C tilt-compensated heading of the outward screen normal; flat devices
  // use the screen top edge, where the normal has no horizontal projection.
  const a = (e.alpha * Math.PI) / 180,
    b = (e.beta * Math.PI) / 180,
    g = (e.gamma * Math.PI) / 180;
  const x = -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
  const y = -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  const heading =
    Math.hypot(x, y) < 0.1
      ? normalizeHeading(360 - e.alpha)
      : normalizeHeading((Math.atan2(x, y) * 180) / Math.PI);
  return { heading, source: 'absolute-orientation', accuracy: null };
}
export function compassLabel(heading) {
  const h = normalizeHeading(heading);
  return (
    (Math.round(h) % 360) +
    '° ' +
    ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(h / 45) % 8]
  );
}
export class LiveSensorSource extends ISensorSource {
  constructor(onSample, onGps, onStatus, onOrientation = () => {}, onCompass = () => {}) {
    super();
    this.onSample = onSample;
    this.onGps = onGps;
    this.onStatus = onStatus;
    this.onOrientation = onOrientation;
    this.onCompass = onCompass;
    this.compass = this.compass.bind(this);
    this.started = 0;
    this.orientation = null;
    this.last = {};
    this.motion = this.motion.bind(this);
    this.orient = this.orient.bind(this);
  }
  async start() {
    if (!globalThis.isSecureContext) throw new Error('Sensorer kräver HTTPS eller localhost.');
    if (!globalThis.DeviceMotionEvent)
      throw new Error('Webbläsaren saknar DeviceMotion. Använd replay eller en mobil webbläsare.');
    // Permission calls are initiated synchronously inside the START gesture.
    const requests = [globalThis.DeviceMotionEvent, globalThis.DeviceOrientationEvent].map(
      (type) => (type?.requestPermission ? type.requestPermission() : Promise.resolve('granted')),
    );
    const permissions = await Promise.allSettled(requests);
    if (permissions[0].status !== 'fulfilled' || permissions[0].value !== 'granted')
      throw new Error(
        'Sensorbehörighet nekad. Tillåt rörelse och orientering i webbläsarens inställningar.',
      );
    this.started = performance.now();
    this.last = {};
    this.orientation = null;
    window.addEventListener('devicemotion', this.motion);
    window.addEventListener('deviceorientation', this.orient);
    window.addEventListener('deviceorientationabsolute', this.compass);
    this.onStatus('accelerometer', 'waiting');
    this.onStatus('gyroscope', 'waiting');
    this.onStatus('orientation', permissions[1].value === 'granted' ? 'waiting' : 'denied');
    this.timer = setInterval(() => {
      for (const key of ['accelerometer', 'gyroscope', 'orientation'])
        if (!this.last[key] || performance.now() - this.last[key] > 3000)
          this.onStatus(key, this.last[key] ? 'stopped' : 'unavailable');
      if (this.last.compass && performance.now() - this.last.compass > 3000) {
        this.last.compass = 0;
        this.onCompass(null, (performance.now() - this.started) / 1000);
      }
    }, 1000);
  }
  compass(e) {
    const reading = compassReading(e);
    if (reading) {
      this.last.compass = performance.now();
      this.onCompass(reading, (performance.now() - this.started) / 1000);
    }
  }
  orient(e) {
    this.compass(e);
    if ([e.alpha, e.beta, e.gamma].every(finite)) {
      this.orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: e.absolute };
      this.last.orientation = performance.now();
      this.onStatus('orientation', 'active');
      this.onOrientation(this.orientation, (performance.now() - this.started) / 1000);
    }
  }
  motion(e) {
    const total = vector(e.accelerationIncludingGravity);
    if (!total) return;
    this.last.accelerometer = performance.now();
    this.onStatus('accelerometer', 'active');
    const r = e.rotationRate,
      gyro = r && [r.beta, r.gamma, r.alpha].every(finite) ? [r.beta, r.gamma, r.alpha] : null;
    if (gyro) {
      this.last.gyroscope = performance.now();
      this.onStatus('gyroscope', 'active');
    }
    const fresh = this.last.orientation && performance.now() - this.last.orientation < 3000;
    this.onSample({
      t: (performance.now() - this.started) / 1000,
      gravityAcceleration: total,
      intervalMs: finite(e.interval) ? e.interval : null,
      linearAcceleration: vector(e.acceleration),
      gyro,
      orientation: fresh ? this.orientation : null,
      orientationAge: this.last.orientation
        ? (performance.now() - this.last.orientation) / 1000
        : null,
      screenAngle: globalThis.screen?.orientation?.angle ?? 0,
    });
  }
  stop() {
    window.removeEventListener('devicemotion', this.motion);
    window.removeEventListener('deviceorientation', this.orient);
    window.removeEventListener('deviceorientationabsolute', this.compass);
    clearInterval(this.timer);
  }
}
export class ReplaySensorSource extends ISensorSource {
  constructor(samples, onSample, onGps, onDone, { speed = 1 } = {}) {
    super();
    this.samples = samples;
    this.onSample = onSample;
    this.onGps = onGps;
    this.onDone = onDone;
    this.speed = speed;
    this.index = 0;
  }
  async start() {
    if (!this.samples.length) throw new Error('Inspelningen är tom.');
    this.started = performance.now();
    this.first = this.samples[0].t;
    this.timer = setInterval(() => {
      const elapsed = ((performance.now() - this.started) * this.speed) / 1000 + this.first;
      while (this.index < this.samples.length && this.samples[this.index].t <= elapsed) {
        const s = this.samples[this.index++];
        if (s.kind === 'gps') this.onGps({ ...s, t: s.t - this.first });
        else this.onSample({ ...s, t: s.t - this.first });
      }
      if (this.index === this.samples.length) {
        this.stop();
        this.onDone?.();
      }
    }, 10);
  }
  stop() {
    clearInterval(this.timer);
  }
}
export function demoSamples() {
  const out = [];
  for (let i = 0; i < 2200; i++) {
    const t = i / 50,
      walking = (t > 3 && t < 18) || (t > 23 && t < 39),
      turn = t >= 19 && t < 23;
    const a = walking ? 2 * Math.sin(2 * Math.PI * 1.8 * t) : 0;
    out.push({
      t,
      gravityAcceleration: [walking ? 0.4 * Math.sin(2 * Math.PI * 1.8 * t) : 0, 0, 9.80665 + a],
      linearAcceleration: [walking ? 0.4 * Math.sin(2 * Math.PI * 1.8 * t) : 0, 0, a],
      gyro: [0, 0, turn ? 22.5 : 0],
      orientation: {
        alpha: turn ? (t - 19) * 22.5 : t >= 23 ? 90 : 0,
        beta: 0,
        gamma: 0,
        absolute: false,
      },
    });
  }
  return out;
}
export class SessionRecorder {
  constructor() {
    this.samples = [];
    this.truth = [];
    this.active = false;
  }
  add(s) {
    if (this.active) this.samples.push(structuredClone(s));
  }
  mark(t, mode, extra = {}) {
    this.truth.push({ t, mode, ...extra });
  }
  export() {
    return {
      format: 'qsys-recording',
      version: 1,
      source: this.source ?? 'live',
      created: new Date().toISOString(),
      samples: this.samples,
      groundTruth: this.truth,
    };
  }
}
export function validateRecording(data) {
  if (
    data.format !== 'qsys-recording' ||
    data.version !== 1 ||
    !Array.isArray(data.samples) ||
    data.samples.length > 1000000
  )
    throw new Error('Ogiltigt inspelningsformat.');
  let previous = -1;
  for (const s of data.samples) {
    if (!finite(s.t) || s.t < previous) throw new Error('Tidsstämplar måste vara monotona.');
    previous = s.t;
    if (s.kind === 'gps') {
      if (![s.latitude, s.longitude, s.accuracy].every(finite))
        throw new Error('Ogiltig GPS-data.');
    } else if (
      !Array.isArray(s.gravityAcceleration) ||
      s.gravityAcceleration.length !== 3 ||
      !s.gravityAcceleration.every(finite) ||
      (s.linearAcceleration &&
        (!Array.isArray(s.linearAcceleration) ||
          s.linearAcceleration.length !== 3 ||
          !s.linearAcceleration.every(finite))) ||
      (s.gyro && (!Array.isArray(s.gyro) || s.gyro.length !== 3 || !s.gyro.every(finite))) ||
      (s.orientation &&
        ![s.orientation.alpha, s.orientation.beta, s.orientation.gamma].every(finite))
    )
      throw new Error('Ogiltig sensordata.');
  }
  return data;
}
