import { config as C, clamp, wrap, family } from '../shared/config.js';
import { TransportModeManager, SpeedEstimator, move } from './models.js';
import { GpsPositionFusion } from './gps.js';
export function initialState(id) {
  return {
    sessionId: id,
    x: 0,
    y: 0,
    heading: 0,
    totalDistance: 0,
    walkingDistance: 0,
    runningDistance: 0,
    vehicleDistance: 0,
    instantaneousSpeed: 0,
    smoothedSpeed: 0,
    steps: 0,
    motionMode: 'Unknown',
    motionFamily: 'Unknown',
    motionConfidence: 0,
    headingConfidence: 0.3,
    positionConfidence: 0.3,
    vehicleDistanceConfidence: 0,
    positionVariance: 4,
    lastTimestamp: 0,
    lastSequence: 0,
    lastStepTimestamp: -1,
    velocity: 0,
    lastVelocityCorrection: 0,
    origin: null,
    originLocal: null,
    geographicHeading: null,
    predictedPosition: null,
    lastAcceptedGps: null,
    gps: {
      quality: 'Unavailable',
      confidence: 0,
      useForCorrection: false,
      weight: 0,
      reason: 'Ingen fix',
      speed: null,
    },
    gpsCorrectionCount: 0,
    trajectory: [{ x: 0, y: 0, distance: 0, t: 0, kind: 'start', mode: 'Unknown' }],
    heatmap: {},
    calibration: { walking: 1, running: 1 },
    groundTruth: [],
    events: [],
  };
}
export class HeatmapService {
  add(s, start, end, dt, distance, mode) {
    const count = Math.max(
      1,
      Math.ceil(Math.hypot(end.x - start.x, end.y - start.y) / (C.cellSize / 2)),
    );
    for (let i = 0; i < count; i++) {
      const x = start.x + ((end.x - start.x) * (i + 0.5)) / count,
        y = start.y + ((end.y - start.y) * (i + 0.5)) / count,
        cx = Math.floor(x / C.cellSize),
        cy = Math.floor(y / C.cellSize),
        key = `${cx},${cy}`;
      const cell = (s.heatmap[key] ??= {
        x: cx * C.cellSize,
        y: cy * C.cellSize,
        timeSpent: 0,
        visitCount: 0,
        distanceTravelled: 0,
        averageSpeed: 0,
        standingTime: 0,
        walkingTime: 0,
        runningTime: 0,
        vehicleTime: 0,
      });
      if (s.lastCell !== key) {
        cell.visitCount++;
        s.lastCell = key;
      }
      cell.timeSpent += dt / count;
      cell.distanceTravelled += distance / count;
      cell.averageSpeed = cell.timeSpent ? cell.distanceTravelled / cell.timeSpent : 0;
      const k =
        mode === 'Running'
          ? 'runningTime'
          : family(mode) === 'Pedestrian'
            ? 'walkingTime'
            : family(mode) === 'Vehicle'
              ? 'vehicleTime'
              : 'standingTime';
      cell[k] += dt / count;
    }
  }
}
export class MotionObservationReceiver {
  constructor() {
    this.models = new TransportModeManager();
    this.speed = new SpeedEstimator();
    this.fusion = new GpsPositionFusion();
    this.heatmap = new HeatmapService();
  }
  process(s, o) {
    if (o.sequenceNumber <= s.lastSequence) return false;
    if (o.sequenceNumber !== s.lastSequence + 1) throw new Error('Sequence gap');
    if (o.monotonicTimestamp < s.lastTimestamp) throw new Error('Timestamp regression');
    const t = o.monotonicTimestamp,
      dt = t - s.lastTimestamp,
      start = { x: s.x, y: s.y };
    s.motionMode = o.motionMode;
    s.motionFamily = family(o.motionMode);
    s.motionConfidence = o.modeConfidence;
    s.heading = wrap(s.heading + (o.headingDelta ?? 0));
    s.sensorHeading = wrap((s.sensorHeading ?? 0) + (o.headingDelta ?? 0));
    s.headingConfidence = o.headingConfidence ?? s.headingConfidence;
    if (s.lastAcceptedGps && t - s.lastAcceptedGps.t > C.gpsMaxAge) {
      s.gps = {
        ...s.gps,
        quality: 'Unavailable',
        useForCorrection: false,
        weight: 0,
        confidence: 0,
        reason: 'GPS-fix har upphört',
      };
    }
    let distance = 0,
      speed = s.instantaneousSpeed;
    if (o.type === 'GpsFix') {
      this.fusion.apply(o.gps, s);
      if (s.x !== start.x || s.y !== start.y)
        s.trajectory.push({
          x: s.x,
          y: s.y,
          distance: s.totalDistance,
          t,
          kind: 'correction',
          mode: s.motionMode,
        });
    } else {
      const clean = {
        ...o,
        steps: (o.steps ?? []).filter((p) => p.timestamp > s.lastStepTimestamp),
      };
      const result = this.models.model(o.motionMode).advance(clean, s, Math.min(dt, 2));
      distance = result.distance;
      speed = result.speed;
      if (result.lengths) {
        for (let i = 0; i < result.lengths.length; i++) {
          const step = clean.steps[i],
            d = result.lengths[i];
          move(s, d, wrap((step.heading ?? s.sensorHeading) + s.heading - s.sensorHeading));
          s.totalDistance += d;
          s.steps++;
          s.lastStepTimestamp = step.timestamp;
          s.trajectory.push({
            x: s.x,
            y: s.y,
            distance: s.totalDistance,
            t: step.timestamp,
            kind: 'movement',
            mode: o.motionMode,
          });
        }
      } else if (distance) {
        move(s, distance, s.heading);
        s.totalDistance += distance;
        s.trajectory.push({
          x: s.x,
          y: s.y,
          distance: s.totalDistance,
          t,
          kind: 'movement',
          mode: o.motionMode,
        });
      }
      if (o.motionMode === 'Running') s.runningDistance += distance;
      else if (s.motionFamily === 'Pedestrian') s.walkingDistance += distance;
      else if (s.motionFamily === 'Vehicle') s.vehicleDistance += distance;
    }
    this.heatmap.add(
      s,
      start,
      o.type === 'GpsFix' ? start : { x: s.x, y: s.y },
      dt,
      distance,
      s.motionMode,
    );
    this.speed.update(s, speed, dt);
    s.positionVariance += dt * (s.motionFamily === 'Vehicle' ? 0.8 : 0.015) + distance * 0.12;
    s.positionConfidence = clamp(
      Math.exp(-Math.sqrt(s.positionVariance) / 12) *
        Math.max(0.15, s.headingConfidence) *
        Math.max(0.3, o.observationConfidence),
      0.01,
      0.95,
    );
    if (s.motionFamily === 'Vehicle')
      s.positionConfidence = Math.min(s.positionConfidence, s.vehicleDistanceConfidence);
    s.lastTimestamp = t;
    s.lastSequence = o.sequenceNumber;
    if (s.events[0]?.mode !== s.motionMode) {
      s.events.unshift({ t, mode: s.motionMode });
      s.events = s.events.slice(0, 100);
      s.modeHistory ??= [];
      s.modeHistory.push({ t, mode: s.motionMode });
    }
    return true;
  }
}
export function publicState(s, full = false) {
  return {
    ...s,
    trajectory: full ? s.trajectory : s.trajectory.slice(-5000),
    heatmap: Object.values(s.heatmap),
    events: full ? s.events : s.events.slice(0, 30),
  };
}
