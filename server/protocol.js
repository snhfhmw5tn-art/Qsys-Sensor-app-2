import { config as C, modes } from '../shared/config.js';
const num = (x, a = -1e9, b = 1e9) =>
  typeof x === 'number' && Number.isFinite(x) && x >= a && x <= b;
const nullable = (x, a, b) => x === null || num(x, a, b);
export function validateObservation(o, id) {
  if (
    !o ||
    o.protocolVersion !== 1 ||
    o.sessionId !== id ||
    typeof o.deviceId !== 'string' ||
    o.deviceId.length > 100 ||
    !Number.isSafeInteger(o.sequenceNumber) ||
    o.sequenceNumber < 1 ||
    !num(o.monotonicTimestamp, 0, 864000) ||
    !modes.includes(o.motionMode) ||
    !num(o.modeConfidence, 0, 1) ||
    !num(o.observationConfidence, 0, 1) ||
    !num(o.headingDelta, -180, 180) ||
    !num(o.headingConfidence, 0, 1) ||
    ![
      'Heartbeat',
      'StateChanged',
      'Step',
      'Turn',
      'Stationary',
      'MotionWindow',
      'VehicleMotion',
      'GpsFix',
    ].includes(o.type)
  )
    throw new Error('Invalid observation');
  if (o.steps !== undefined) {
    if (!Array.isArray(o.steps) || o.steps.length > 16) throw new Error('Invalid steps');
    let last = -1;
    for (const p of o.steps) {
      if (
        !num(p.timestamp, 0, o.monotonicTimestamp) ||
        p.timestamp <= last ||
        !num(p.stepInterval, C.minStepInterval, C.maxStepInterval) ||
        !num(p.accelerationAmplitude, 0, 100) ||
        !num(p.cadence, 0.1, 5) ||
        !num(p.heading, -180, 180) ||
        !num(p.signalEnergy, 0, 10000) ||
        !num(p.motionConfidence, 0, 1)
      )
        throw new Error('Invalid step');
      last = p.timestamp;
    }
  }
  if (o.vehicle) {
    const v = o.vehicle;
    if (
      !num(v.duration, 0, 2) ||
      !num(v.accelerationIntegral, -30, 30) ||
      !num(v.stationaryProbability, 0, 1) ||
      !num(v.forwardAccelerationMean, -100, 100) ||
      !num(v.forwardAccelerationVariance, 0, 10000)
    )
      throw new Error('Invalid vehicle window');
  }
  if (o.type === 'GpsFix') {
    const g = o.gps;
    if (
      !g ||
      !num(g.latitude, -90, 90) ||
      !num(g.longitude, -180, 180) ||
      !num(g.accuracy, 0.01, 100000) ||
      !num(g.age, 0, 86400) ||
      !num(g.t, 0, o.monotonicTimestamp) ||
      !nullable(g.speed, 0, 1000) ||
      !nullable(g.heading, 0, 360)
    )
      throw new Error('Invalid GPS fix');
  }
  return o;
}
