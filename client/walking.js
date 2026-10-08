import {
  SensorPreprocessor,
  MotionFeatureExtractor,
  StepDetector,
  HeadingEstimator,
  SensorBuffer,
} from './pipeline.js';
import { radians, wrap, config as C } from '../shared/config.js';
export class WalkingTracker {
  constructor() {
    this.preprocessor = new SensorPreprocessor();
    this.extractor = new MotionFeatureExtractor();
    this.detector = new StepDetector();
    this.heading = new HeadingEstimator();
    this.attitude = new HeadingEstimator();
    this.attitudeOffset = null;
    this.window = new SensorBuffer(C.windowSeconds);
    this.history = [];
    this.raw = [];
    this.lastFeature = -1;
    this.features = null;
    this.state = {
      x: 0,
      y: 0,
      distance: 0,
      steps: 0,
      heading: 0,
      deviceHeading: 0,
      trajectory: [{ x: 0, y: 0, t: 0, distance: 0, kind: 'start' }],
      heatmap: [],
    };
  }
  orient(orientation, t) {
    this.attitude.update({ orientation, gyro: null, yawRate: 0, dt: 0 }, null, 'Standing');
    this.attitudeOffset ??= this.heading.deviceYaw;
    const target = wrap(this.attitude.deviceYaw + this.attitudeOffset);
    // Small, current attitude corrections remove integration lag without accepting
    // abrupt compass jumps. Gyro prediction continues between attitude events.
    if (!this.hasGyro || Math.abs(wrap(target - this.heading.deviceYaw)) < 25) {
      this.heading.deviceYaw = target;
      this.state.heading = this.state.deviceHeading = target;
      this.history.push({ t, phoneHeading: target });
    }
  }
  process(raw) {
    if (this.previous !== undefined && raw.t - this.previous > C.maximumSampleGap) {
      this.window.samples = [];
      this.detector = new StepDetector();
      this.features = null;
      this.preprocessor.previous = null;
    }
    this.previous = raw.t;
    this.hasGyro = Array.isArray(raw.gyro);
    this.raw.push(structuredClone(raw));
    const s = this.preprocessor.process(raw);
    this.window.add(s);
    if (s.t - this.lastFeature >= C.featureInterval) {
      this.features = this.extractor.extract(this.window.samples);
      this.lastFeature = s.t;
    }
    this.heading.update(s, null, 'Standing');
    this.history.push({
      t: s.t,
      phoneHeading: this.heading.deviceYaw,
      orientationHeading: this.heading.orientationYaw,
      yawRate: s.yawRate,
      vertical: s.vertical,
      nav: s.nav,
      features: this.features,
      bias: [...this.preprocessor.bias],
    });
    for (const peak of this.detector.update(s, this.features, true)) {
      const h = this.history.findLast((p) => p.t <= peak.t)?.phoneHeading ?? this.heading.deviceYaw;
      const length = 0.7;
      this.state.x += length * Math.sin(radians(h));
      this.state.y += length * Math.cos(radians(h));
      this.state.distance += length;
      this.state.steps++;
      this.state.trajectory.push({
        x: this.state.x,
        y: this.state.y,
        t: peak.t,
        distance: this.state.distance,
        kind: 'movement',
      });
    }
    this.state.heading = this.state.deviceHeading = this.heading.deviceYaw;
    this.state.t = s.t;
    return this.state;
  }
}
