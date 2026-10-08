import { config as C, clamp, family, radians } from '../shared/config.js';
export class StationaryMotionModel {
  advance() {
    return { distance: 0, speed: 0 };
  }
}
export class ConservativeMotionModel extends StationaryMotionModel {}
export class WalkingMotionModel {
  length(step, calibration = 1) {
    return clamp(
      C.walkingK * Math.pow(step.accelerationAmplitude, 0.25) * calibration,
      C.minWalkingStep,
      C.maxWalkingStep,
    );
  }
  advance(o, s) {
    const lengths = (o.steps ?? []).map((p) => this.length(p, s.calibration.walking));
    return {
      distance: lengths.reduce((a, b) => a + b, 0),
      speed: lengths.length
        ? lengths.at(-1) / o.steps.at(-1).stepInterval
        : o.monotonicTimestamp - s.lastStepTimestamp < C.maxStepInterval
          ? s.instantaneousSpeed
          : 0,
      lengths,
    };
  }
}
export class RunningMotionModel extends WalkingMotionModel {
  length(step, calibration = 1) {
    return clamp(
      C.runningK *
        Math.pow(step.accelerationAmplitude, 0.25) *
        (1 + 0.12 * (step.cadence - 2.5)) *
        calibration,
      C.minRunningStep,
      C.maxRunningStep,
    );
  }
  advance(o, s) {
    const lengths = (o.steps ?? []).map((p) => this.length(p, s.calibration.running));
    return {
      distance: lengths.reduce((a, b) => a + b, 0),
      speed: lengths.length
        ? lengths.at(-1) / o.steps.at(-1).stepInterval
        : o.monotonicTimestamp - s.lastStepTimestamp < C.maxStepInterval
          ? s.instantaneousSpeed
          : 0,
      lengths,
    };
  }
}
export class VehicleMotionModel {
  advance(o, s, dt) {
    const v = o.vehicle;
    if (!v) return { distance: 0, speed: 0 };
    const gpsVelocityReliable =
      s.geographicHeading !== null &&
      s.gps.useForCorrection &&
      s.gps.speed !== null &&
      o.monotonicTimestamp - s.lastVelocityCorrection < C.gpsMaxAge;
    if ((!o.orientationReliable || !v.headingReferenceReliable) && !gpsVelocityReliable) {
      s.vehicleDistanceConfidence = 0;
      return { distance: 0, speed: 0 };
    }
    if (
      v.stopConfirmed ||
      (s.gps.useForCorrection &&
        s.gps.speed !== null &&
        s.gps.speed < C.gpsStationarySpeed &&
        v.stationaryProbability > 0.9)
    ) {
      s.velocity = 0;
      s.lastVelocityCorrection = o.monotonicTimestamp;
      return { distance: 0, speed: 0 };
    }
    const age = o.monotonicTimestamp - s.lastVelocityCorrection;
    s.vehicleDistanceConfidence = Math.exp(-age / C.vehicleMaxSeconds) * o.observationConfidence;
    if (age > C.vehicleMaxSeconds) return { distance: 0, speed: 0 };
    if (!v.headingReferenceReliable && gpsVelocityReliable)
      return { distance: s.velocity * dt, speed: s.velocity };
    const previous = s.velocity;
    s.velocity = clamp(
      previous + clamp(v.accelerationIntegral, -C.maxAcceleration * dt, C.maxAcceleration * dt),
      0,
      C.maxSpeed,
    );
    return { distance: (previous + s.velocity) * 0.5 * dt, speed: s.velocity };
  }
}
export class TransportModeManager {
  constructor() {
    this.stationary = new StationaryMotionModel();
    this.walking = new WalkingMotionModel();
    this.running = new RunningMotionModel();
    this.vehicle = new VehicleMotionModel();
    this.unknown = new ConservativeMotionModel();
  }
  model(mode) {
    return mode === 'Running'
      ? this.running
      : family(mode) === 'Pedestrian'
        ? this.walking
        : family(mode) === 'Vehicle'
          ? this.vehicle
          : family(mode) === 'Stationary'
            ? this.stationary
            : this.unknown;
  }
}
export class SpeedEstimator {
  update(state, speed, dt) {
    state.instantaneousSpeed = speed;
    state.smoothedSpeed += (1 - Math.exp(-dt / C.speedTau)) * (speed - state.smoothedSpeed);
    if (state.motionMode === 'Standing') state.smoothedSpeed = 0;
  }
}
export function move(state, distance, heading) {
  state.x += distance * Math.sin(radians(heading));
  state.y += distance * Math.cos(radians(heading));
}
