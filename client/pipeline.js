import { config as C, clamp, radians, wrap, mean, variance, family } from '../shared/config.js';
export class SensorBuffer {
  constructor(seconds = C.rawBufferSeconds) {
    this.seconds = seconds;
    this.samples = [];
  }
  add(s) {
    this.samples.push(s);
    while (this.samples.length && this.samples[0].t < s.t - this.seconds) this.samples.shift();
  }
}
export class GravityEstimator {
  constructor() {
    this.value = [0, 0, C.gravity];
    this.initialized = false;
  }
  update(a, dt) {
    if (!this.initialized) {
      this.value = [...a];
      this.initialized = true;
    }
    const k = 1 - Math.exp(-2 * Math.PI * C.gravityCutoff * dt);
    this.value = this.value.map((v, i) => v + k * (a[i] - v));
    return this.value;
  }
}
export class CoordinateTransformer {
  matrix(o) {
    const [a, b, g] = [o.alpha, o.beta, o.gamma].map(radians),
      ca = Math.cos(a),
      sa = Math.sin(a),
      cb = Math.cos(b),
      sb = Math.sin(b),
      cg = Math.cos(g),
      sg = Math.sin(g);
    return [
      [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
      [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
      [-cb * sg, sb, cb * cg],
    ];
  }
  transform(v, o) {
    return this.matrix(o).map((row) => row.reduce((s, x, i) => s + x * v[i], 0));
  }
}
export class SensorPreprocessor {
  constructor() {
    this.gravity = new GravityEstimator();
    this.transformer = new CoordinateTransformer();
    this.previous = null;
    this.filtered = 0;
    this.bias = [0, 0, 0];
    this.biasSamples = [];
    this.calibrated = false;
    this.initialT = null;
    this.calibrationFailed = false;
    this.quietSince = null;
  }
  process(s) {
    const dt = this.previous ? clamp(s.t - this.previous.t, 0.001, 0.1) : 0.02;
    this.previous = s;
    this.initialT ??= s.t;
    const g = this.gravity.update(s.gravityAcceleration, dt),
      gn = Math.hypot(...g) || C.gravity;
    const linear = s.linearAcceleration ?? s.gravityAcceleration.map((v, i) => v - g[i]);
    const elapsed = s.t - this.initialT,
      norm = Math.hypot(...linear),
      gyro = s.gyro ?? [0, 0, 0];
    if (!this.calibrated) {
      if (norm < C.stationaryRms * 3 && Math.hypot(...gyro) < C.stationaryGyro * 2) {
        this.quietSince ??= s.t;
        this.biasSamples.push(gyro);
        this.biasSamples = this.biasSamples.slice(-200);
      } else {
        this.biasSamples = [];
        this.quietSince = null;
      }
      if (
        this.biasSamples.length >= 20 &&
        this.quietSince !== null &&
        s.t - this.quietSince >= C.calibrationSeconds
      ) {
        this.bias = [0, 1, 2].map((i) => mean(this.biasSamples.map((v) => v[i])));
        this.calibrated = true;
      }
      if (elapsed > 10 && !this.calibrated) this.calibrationFailed = true;
    }
    const nav = s.orientation
      ? this.transformer.transform(linear, s.orientation)
      : [0, 0, Math.hypot(...s.gravityAcceleration) - C.gravity];
    const vertical = s.orientation ? nav[2] : Math.hypot(...s.gravityAcceleration) - C.gravity;
    this.filtered += (1 - Math.exp(-2 * Math.PI * C.gaitCutoff * dt)) * (vertical - this.filtered);
    const corrected = gyro.map((v, i) => v - this.bias[i]);
    // DeviceMotion alpha,beta,gamma are converted to x,y,z by LiveSensorSource.
    const yawRate = s.orientation
      ? this.transformer.transform(corrected, s.orientation)[2]
      : corrected.reduce((sum, v, i) => sum + (v * g[i]) / gn, 0);
    return {
      ...s,
      dt,
      nav,
      vertical: this.filtered,
      linear,
      gravity: g,
      yawRate,
      gyroMagnitude: Math.hypot(...corrected),
      norm,
      orientationReliable: !!s.orientation,
    };
  }
}
export class IMotionFeatureExtractor {
  extract() {
    throw new Error('Implement extract');
  }
}
export class MotionFeatureExtractor extends IMotionFeatureExtractor {
  extract(samples) {
    const first = samples[0],
      last = samples.at(-1);
    if (!first || last.t - first.t < 1) return null;
    const v = samples.map((s) => s.vertical),
      norm = samples.map((s) => s.norm),
      headingSamples = samples.filter((s) => s.t >= last.t - 1.2),
      mx = mean(headingSamples.map((s) => s.nav[0])),
      my = mean(headingSamples.map((s) => s.nav[1]));
    const xx = mean(headingSamples.map((s) => (s.nav[0] - mx) ** 2)),
      yy = mean(headingSamples.map((s) => (s.nav[1] - my) ** 2)),
      xy = mean(headingSamples.map((s) => (s.nav[0] - mx) * (s.nav[1] - my)));
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy),
      anisotropy = Math.hypot(xx - yy, 2 * xy) / (xx + yy + 1e-6);
    // Resample irregular browser events before computing autocorrelation.
    const uniform = [],
      rawVertical = [];
    let j = 0;
    for (let t = first.t; t <= last.t; t += 1 / C.featureSampleRate) {
      while (j + 1 < samples.length && samples[j + 1].t < t) j++;
      const a = samples[j],
        b = samples[Math.min(j + 1, samples.length - 1)],
        k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      uniform.push(a.vertical + k * (b.vertical - a.vertical));
      rawVertical.push(a.nav[2] + k * (b.nav[2] - a.nav[2]));
    }
    const m = mean(uniform),
      center = uniform.map((x) => x - m);
    let correlation = 0,
      bestLag = 0;
    for (
      let lag = Math.ceil(C.minStepInterval * C.featureSampleRate);
      lag <= Math.floor(C.maxStepInterval * C.featureSampleRate) && lag < center.length / 1.5;
      lag++
    ) {
      let numerator = 0,
        a = 0,
        b = 0;
      for (let i = lag; i < center.length; i++) {
        numerator += center[i] * center[i - lag];
        a += center[i] ** 2;
        b += center[i - lag] ** 2;
      }
      const c = numerator / Math.sqrt(a * b || 1);
      if (c > correlation) {
        correlation = c;
        bestLag = lag;
      }
    }
    // Windowed spectrum of gravity-corrected, unfiltered vertical acceleration.
    const sampleRate = (samples.length - 1) / (last.t - first.t);
    const rawMean = mean(rawVertical);
    let spectralTotal = 0,
      spectralHigh = 0,
      spectralPeak = 0,
      verticalFrequency = 0;
    for (let hz = 0.5; hz <= Math.min(15, sampleRate * 0.4); hz += 0.5) {
      let re = 0,
        im = 0;
      rawVertical.forEach((x, i) => {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (rawVertical.length - 1));
        const phase = (2 * Math.PI * hz * i) / C.featureSampleRate;
        re += (x - rawMean) * w * Math.cos(phase);
        im += (x - rawMean) * w * Math.sin(phase);
      });
      const power = re * re + im * im;
      spectralTotal += power;
      if (hz >= 4) spectralHigh += power;
      if (power > spectralPeak) {
        spectralPeak = power;
        verticalFrequency = hz;
      }
    }
    const energy = mean(v.map((x) => x * x));
    return {
      verticalFrequency: spectralTotal > 1e-8 ? verticalFrequency : 0,
      verticalHighFrequencyRatio: spectralTotal > 1e-8 ? spectralHigh / spectralTotal : 0,
      rms: Math.sqrt(mean(norm.map((x) => x * x))),
      variance: variance(v),
      standardDeviation: Math.sqrt(variance(v)),
      energy,
      jerk: mean(samples.slice(1).map((s, i) => Math.abs(s.vertical - samples[i].vertical) / s.dt)),
      gyroRms: Math.sqrt(mean(samples.map((s) => s.gyroMagnitude ** 2))),
      yawRate: mean(samples.slice(-15).map((s) => s.yawRate)),
      horizontalEnergy: xx + yy,
      verticalAmplitude: Math.max(...v) - Math.min(...v),
      cadence: bestLag ? C.featureSampleRate / bestLag : 0,
      dominantFrequency: bestLag ? C.featureSampleRate / bestLag : 0,
      periodicity: correlation,
      pcaHeading: wrap(90 - (angle * 180) / Math.PI),
      anisotropy,
      sampleRate: (samples.length - 1) / (last.t - first.t),
      orientationReliable: last.orientationReliable,
      forwardAccelerationMean: mean(samples.slice(-10).map((s) => s.nav[1])),
      stationaryProbability: clamp(
        1 - Math.sqrt(mean(norm.map((x) => x * x))) / C.stationaryRms,
        0,
        1,
      ),
    };
  }
}
export class IMotionClassifier {
  classify() {
    throw new Error('Implement classify');
  }
}
export class MotionClassifier extends IMotionClassifier {
  classify(f, context = {}) {
    if (!f || f.sampleRate < C.minimumSampleRate) return { mode: 'Unknown', confidence: 0.1 };
    const gait =
      f.periodicity > C.periodicityThreshold &&
      f.verticalAmplitude > C.stepProminence &&
      f.rms > C.gaitMinRms;
    const turn = Math.abs(f.yawRate) > C.turnRate;
    if (context.vehicleType && context.vehicleType !== 'Auto') {
      if (
        context.stopConfirmed ||
        (context.gpsSpeed !== null &&
          context.gpsSpeed < C.gpsStationarySpeed &&
          f.rms < C.stationaryRms)
      )
        return { mode: 'Standing', confidence: 0.85 };
      // A declared vehicle subtype is an operator prior, not an IMU classification result.
      return { mode: context.vehicleType, confidence: 0.65 };
    }
    if (gait)
      return {
        mode:
          f.cadence > C.runningCadence && f.rms > C.runningMinRms
            ? 'Running'
            : turn
              ? 'WalkingTurn'
              : 'Walking',
        confidence: clamp(0.5 + f.periodicity * 0.35, 0.6, 0.85),
      };
    if (turn) return { mode: 'TurningInPlace', confidence: 0.7 };
    if (context.gpsSpeed > C.vehicleGpsSpeed) return { mode: 'Vehicle', confidence: 0.7 };
    if (f.rms < C.stationaryRms && f.gyroRms < C.stationaryGyro)
      return { mode: 'Standing', confidence: 0.8 };
    if (
      f.horizontalEnergy > C.vehicleMinHorizontalEnergy &&
      f.periodicity < C.vehicleMaxPeriodicity
    )
      return { mode: 'Vehicle', confidence: 0.6 };
    return { mode: 'Unknown', confidence: 0.25 };
  }
}
export class TransportModeStateMachine {
  constructor() {
    this.mode = 'Unknown';
    this.candidate = 'Unknown';
    this.since = 0;
    this.changed = 0;
    this.confidence = 0;
  }
  update(estimate, t) {
    this.confidence = estimate.mode === this.mode ? estimate.confidence : this.confidence * 0.95;
    if (estimate.mode !== this.candidate) {
      this.candidate = estimate.mode;
      this.since = t;
    }
    if (
      estimate.confidence >= C.transitionConfidence &&
      this.candidate !== this.mode &&
      t - this.since >= C.transitionSeconds &&
      t - this.changed >= C.minimumStateSeconds
    ) {
      this.mode = this.candidate;
      this.changed = t;
      this.confidence = estimate.confidence;
    }
    return this.mode;
  }
}
export class StepValidator {
  validate(peaks, f) {
    if (
      peaks.length < C.confirmationSteps ||
      !f ||
      f.periodicity < C.periodicityThreshold ||
      f.sampleRate < C.minimumSampleRate
    )
      return false;
    const intervals = peaks.slice(1).map((p, i) => p.t - peaks[i].t),
      m = mean(intervals);
    return (
      intervals.every((x) => x >= C.minStepInterval && x <= C.maxStepInterval) &&
      Math.sqrt(variance(intervals)) / m < C.intervalVariation
    );
  }
}
export class StepDetector {
  constructor() {
    this.history = [];
    this.peaks = [];
    this.previousPeak = -100;
    this.lastConfirmed = -100;
    this.confirmed = 0;
    this.candidates = 0;
    this.rejected = 0;
    this.validator = new StepValidator();
    this.trough = 0;
  }
  update(s, f, eligible) {
    this.history.push(s);
    if (this.history.length > 3) this.history.shift();
    this.trough = Math.min(this.trough, s.vertical);
    if (this.peaks.length && s.t - this.peaks.at(-1).t > C.maxStepInterval) {
      this.rejected += this.peaks.filter((p) => !p.applied).length;
      this.peaks = [];
    }
    if (this.history.length < 3) return [];
    const [a, b, c] = this.history;
    if (
      !(
        b.vertical > a.vertical &&
        b.vertical >= c.vertical &&
        b.vertical > C.stepThreshold &&
        b.vertical - this.trough > C.stepProminence &&
        b.t - this.previousPeak >= C.minStepInterval
      )
    )
      return [];
    this.previousPeak = b.t;
    this.candidates++;
    const peak = {
      t: b.t,
      amplitude: b.vertical - this.trough,
      interval: this.peaks.length ? b.t - this.peaks.at(-1).t : f?.cadence ? 1 / f.cadence : 0.5,
      applied: false,
    };
    this.trough = 0;
    this.peaks.push(peak);
    this.peaks = this.peaks.slice(-8);
    if (!eligible || !this.validator.validate(this.peaks.slice(-C.confirmationSteps), f)) return [];
    const confirmed = this.peaks.filter((p) => !p.applied && p.t > this.lastConfirmed);
    for (const p of confirmed) {
      p.applied = true;
      this.lastConfirmed = p.t;
      this.confirmed++;
    }
    return confirmed;
  }
}
export class HeadingEstimator {
  constructor() {
    this.heading = 0;
    this.pcaOrigin = null;
    this.deviceYaw = 0;
    this.confidence = 0.3;
    this.lastFeature = null;
    this.mountingOffset = 0;
    this.filteredDeviceYaw = 0;
    this.initialized = false;
  }
  update(s, f, mode) {
    // Relative physical rotation, never compass alpha. Navigation bearings are
    // clockwise; the browser's gravity-projected angular rate is anticlockwise.
    if (this.initialized) this.deviceYaw = wrap(this.deviceYaw - s.yawRate * s.dt);
    if (s.orientation) {
      const matrix = new CoordinateTransformer().matrix(s.orientation);
      this.orientationOrigin ??= matrix;
      const relative = matrix.map((row) =>
        this.orientationOrigin.map((base) => row.reduce((sum, v, i) => sum + v * base[i], 0)),
      );
      this.orientationYaw = wrap(
        (-Math.atan2(relative[1][0] - relative[0][1], relative[0][0] + relative[1][1]) * 180) /
          Math.PI,
      );
      // A missing gyroscope must not freeze the phone indicator.
      if (s.gyro === null) this.deviceYaw = this.orientationYaw;
    }
    this.initialized = true;
    this.filteredDeviceYaw = wrap(
      this.filteredDeviceYaw +
        (1 - Math.exp(-s.dt / 0.35)) * wrap(this.deviceYaw - this.filteredDeviceYaw),
    );
    const pedestrian = family(mode) === 'Pedestrian';
    if (
      f &&
      family(mode) === 'Pedestrian' &&
      f.orientationReliable &&
      f.anisotropy > C.pcaAnisotropy &&
      f.horizontalEnergy > 0.005 &&
      f.periodicity > 0.35
    ) {
      // Anchor PCA to the rotation already observed during startup; never
      // redefine the direction at the first confirmed gait window as zero.
      this.pcaOrigin ??= wrap(f.pcaHeading - this.filteredDeviceYaw - this.mountingOffset);
      let target = wrap(f.pcaHeading - this.pcaOrigin);
      if (Math.abs(wrap(target - this.heading)) > 90) target = wrap(target + 180);
      // Learn the phone-to-travel offset from gait, rather than assuming they
      // always share a direction. A short window limits turn latency.
      if (f !== this.lastFeature) {
        this.heading = wrap(this.heading + C.pcaGain * wrap(target - this.heading));
        this.mountingOffset = wrap(this.heading - this.filteredDeviceYaw);
        this.lastFeature = f;
      }
      this.confidence = 0.6 * f.anisotropy;
    } else {
      if (pedestrian) {
        const target = wrap(this.filteredDeviceYaw + this.mountingOffset);
        this.heading = wrap(
          this.heading + (1 - Math.exp(-s.dt / 0.2)) * wrap(target - this.heading),
        );
      }
      this.confidence = Math.max(0.15, this.confidence - s.dt * 0.05);
    }
    return this.heading;
  }
}
export class SensorPipeline {
  constructor(emit, { deviceId, sessionId, context = () => ({}) } = {}) {
    this.emit = emit;
    this.deviceId = deviceId;
    this.sessionId = sessionId;
    this.context = context;
    this.raw = new SensorBuffer();
    this.window = new SensorBuffer(C.windowSeconds);
    this.preprocessor = new SensorPreprocessor();
    this.extractor = new MotionFeatureExtractor();
    this.classifier = new MotionClassifier();
    this.machine = new TransportModeStateMachine();
    this.steps = new StepDetector();
    this.heading = new HeadingEstimator();
    this.sequence = 0;
    this.lastEmit = 0;
    this.lastFeatures = -1;
    this.lastHeading = 0;
    this.features = null;
    this.pendingSteps = [];
    this.headingHistory = [];
    this.vehicleSamples = [];
    this.events = [];
    this.lastSample = null;
    this.estimate = null;
  }
  event(type, t, detail = '') {
    this.events.unshift({ type, t, detail });
    this.events = this.events.slice(0, 100);
  }
  process(sample) {
    if (this.lastSample && sample.t - this.lastSample.t > C.maximumSampleGap) {
      this.window.samples = [];
      this.machine = new TransportModeStateMachine();
      this.steps.peaks = [];
      this.features = null;
      this.estimate = null;
      this.heading.confidence = 0.15;
      this.preprocessor.previous = null;
      this.event('SensorDropout', sample.t, 'Window återställd');
    }
    this.raw.add(sample);
    const s = this.preprocessor.process(sample);
    this.lastSample = s;
    // Record and process immediately. Bias calibration is opportunistic in
    // the background and must never discard movement at measurement start.
    this.window.add(s);
    if (s.t - this.lastFeatures >= C.featureInterval) {
      this.features = this.extractor.extract(this.window.samples);
      this.lastFeatures = s.t;
      const before = this.machine.mode;
      this.estimate = this.classifier.classify(this.features, this.context());
      this.machine.update(this.estimate, s.t);
      if (before !== this.machine.mode)
        this.event('StateChanged', s.t, `${before} → ${this.machine.mode}`);
    }
    this.heading.update(s, this.features, this.machine.mode);
    this.reference ??= new LiveReference();
    this.reference.update(s, this.heading.deviceYaw);
    this.diagnostics ??= [];
    this.diagnostics.push({
      t: s.t,
      nav: s.nav,
      yawRate: s.yawRate,
      deviceHeading: this.heading.deviceYaw,
      orientationHeading: this.heading.orientationYaw,
      travelHeading: this.heading.heading,
      confidence: this.heading.confidence,
      mode: this.machine.mode,
      candidate: this.estimate,
      features: this.features,
      bias: [...this.preprocessor.bias],
      calibrated: this.preprocessor.calibrated,
      reference: { x: this.reference.x, y: this.reference.y, velocity: this.reference.velocity },
    });
    if (this.diagnostics.length > 100000) this.diagnostics.splice(0, 1000);
    this.headingHistory.push({
      t: s.t,
      heading:
        family(this.machine.mode) === 'Pedestrian'
          ? this.heading.heading
          : wrap(this.heading.deviceYaw + this.heading.mountingOffset),
    });
    while (this.headingHistory.length && this.headingHistory[0].t < s.t - 8)
      this.headingHistory.shift();
    const gaitCandidate =
      family(this.estimate?.mode) === 'Pedestrian' &&
      this.estimate.confidence >= C.transitionConfidence;
    const peaks = this.steps.update(
      s,
      this.features,
      family(this.machine.mode) === 'Pedestrian' || gaitCandidate,
    );
    if (peaks.length) {
      // Three regular peaks plus periodic gait evidence are stronger startup
      // evidence than waiting out the separate mode debounce as well.
      if (gaitCandidate && family(this.machine.mode) !== 'Pedestrian') {
        const before = this.machine.mode;
        this.machine.mode = this.estimate.mode;
        this.machine.confidence = this.estimate.confidence;
        this.machine.changed = s.t;
        this.event('StateChanged', s.t, `${before} → ${this.machine.mode} (bekräftade steg)`);
      }
      this.event('BufferedStepsApplied', s.t, String(peaks.length));
      this.pendingSteps.push(
        ...peaks.map((p) => ({
          timestamp: p.t,
          heading: this.headingHistory.findLast((h) => h.t <= p.t)?.heading ?? this.heading.heading,
          stepInterval: p.interval,
          cadence: 1 / p.interval,
          accelerationAmplitude: p.amplitude,
          verticalAmplitude: p.amplitude,
          signalEnergy: this.features?.energy ?? 0,
          motionConfidence: this.machine.confidence,
        })),
      );
    }
    const h = radians(this.heading.heading + (this.heading.pcaOrigin ?? 0)),
      forward = s.nav[0] * Math.sin(h) + s.nav[1] * Math.cos(h);
    this.vehicleSamples.push({ a: forward, dt: s.dt });
    const interval =
      family(this.machine.mode) === 'Stationary' ? C.heartbeatSeconds : C.sendInterval / 1000;
    if (s.t - this.lastEmit >= interval || peaks.length) {
      const duration = s.t - this.lastEmit;
      this.send({
        timestamp: s.t,
        type: this.pendingSteps.length
          ? 'Step'
          : this.machine.mode === 'Standing'
            ? 'Stationary'
            : family(this.machine.mode) === 'Vehicle'
              ? 'VehicleMotion'
              : 'MotionWindow',
        headingDelta: wrap(this.heading.heading - this.lastHeading),
        headingConfidence: this.heading.confidence,
        steps: this.pendingSteps.splice(0),
        vehicle: {
          headingReferenceReliable: this.heading.pcaOrigin !== null,
          duration: Math.min(duration, 2),
          accelerationIntegral: this.vehicleSamples.reduce((v, x) => v + x.a * x.dt, 0),
          forwardAccelerationMean: mean(this.vehicleSamples.map((x) => x.a)),
          forwardAccelerationVariance: variance(this.vehicleSamples.map((x) => x.a)),
          stationaryProbability: this.features?.stationaryProbability ?? 0,
          vibrationEnergy: this.features?.energy ?? 0,
          dominantFrequency: this.features?.dominantFrequency ?? 0,
          stopConfirmed: !!this.context().stopConfirmed,
        },
        orientationReliable: s.orientationReliable,
      });
      this.vehicleSamples = [];
      this.lastEmit = s.t;
      this.lastHeading = this.heading.heading;
    }
  }
  send(o) {
    this.emit({
      protocolVersion: 1,
      deviceId: this.deviceId,
      sessionId: this.sessionId,
      sequenceNumber: ++this.sequence,
      monotonicTimestamp: o.timestamp,
      motionMode: this.machine.mode,
      modeConfidence: this.machine.confidence,
      observationConfidence: this.features?.orientationReliable ? 0.75 : 0.4,
      ...o,
    });
  }
  gps(fix) {
    this.send({
      timestamp: fix.t,
      type: 'GpsFix',
      headingDelta: 0,
      gps: fix,
      headingConfidence: this.heading.confidence,
    });
  }
}

// Diagnostic integration deliberately has no stationary or zero-velocity filter.
export class LiveReference {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.velocity = 0;
    this.previous = null;
    this.origin = null;
    this.path = [{ x: 0, y: 0, t: 0 }];
  }
  update(s, heading) {
    const dt = this.previous === null ? 0 : s.t - this.previous;
    this.previous = s.t;
    if (!s.orientation || dt <= 0 || dt > 0.2) return;
    if (this.origin === null) {
      const m = new CoordinateTransformer().matrix(s.orientation);
      const axis = Math.abs(m[2][1]) > 0.7 ? [0, 0, -1] : [0, 1, 0];
      const v = m.map((row) => row.reduce((sum, x, i) => sum + x * axis[i], 0));
      this.origin = Math.atan2(v[0], v[1]);
    }
    const h = this.origin + radians(heading),
      a = s.nav[0] * Math.sin(h) + s.nav[1] * Math.cos(h);
    const distance = this.velocity * dt + 0.5 * a * dt * dt;
    this.velocity += a * dt;
    this.x += distance * Math.sin(radians(heading));
    this.y += distance * Math.cos(radians(heading));
    if (s.t - this.path.at(-1).t >= 0.1) this.path.push({ x: this.x, y: this.y, t: s.t });
    if (this.path.length > 20000) this.path.splice(1, 1000);
  }
}
