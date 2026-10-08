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
export class LiveSensorSource extends ISensorSource {
  constructor(onSample, onGps, onStatus) {
    super();
    this.onSample = onSample;
    this.onGps = onGps;
    this.onStatus = onStatus;
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
    this.onStatus('accelerometer', 'waiting');
    this.onStatus('gyroscope', 'waiting');
    this.onStatus('orientation', permissions[1].value === 'granted' ? 'waiting' : 'denied');
    if (navigator.geolocation)
      this.watch = navigator.geolocation.watchPosition(
        (p) => {
          this.last.gps = performance.now();
          this.onStatus('gps', 'active');
          this.onGps({
            t: (performance.now() - this.started) / 1000,
            latitude: p.coords.latitude,
            longitude: p.coords.longitude,
            accuracy: p.coords.accuracy,
            speed: p.coords.speed,
            heading: p.coords.heading,
            age: Math.max(0, (Date.now() - p.timestamp) / 1000),
          });
        },
        (e) => this.onStatus('gps', e.code === 1 ? 'denied' : 'unavailable'),
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 },
      );
    else this.onStatus('gps', 'unavailable');
    this.timer = setInterval(() => {
      for (const key of ['accelerometer', 'gyroscope', 'orientation', 'gps'])
        if (!this.last[key] || performance.now() - this.last[key] > (key === 'gps' ? 10000 : 3000))
          this.onStatus(key, this.last[key] ? 'stopped' : 'unavailable');
    }, 1000);
  }
  orient(e) {
    if ([e.alpha, e.beta, e.gamma].every(finite)) {
      this.orientation = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, absolute: e.absolute };
      this.last.orientation = performance.now();
      this.onStatus('orientation', 'active');
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
      linearAcceleration: vector(e.acceleration),
      gyro,
      orientation: fresh ? this.orientation : null,
    });
  }
  stop() {
    window.removeEventListener('devicemotion', this.motion);
    window.removeEventListener('deviceorientation', this.orient);
    if (this.watch !== undefined) navigator.geolocation.clearWatch(this.watch);
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
