// Units: seconds, metres, m/s², degrees. Experimental defaults, not universal constants.
export const config = Object.freeze({
  version: '1.0.0',
  gravity: 9.80665,
  gravityCutoff: 0.3,
  gaitCutoff: 5,
  windowSeconds: 3,
  featureInterval: 0.25,
  rawBufferSeconds: 60,
  calibrationSeconds: 2,
  minStepInterval: 0.26,
  maxStepInterval: 1.2,
  stepThreshold: 0.65,
  stepProminence: 1.1,
  confirmationSteps: 3,
  intervalVariation: 0.28,
  periodicityThreshold: 0.48,
  stationaryRms: 0.16,
  stationaryGyro: 3,
  turnRate: 18,
  runningCadence: 2.5,
  transitionSeconds: 0.75,
  minimumStateSeconds: 1,
  transitionConfidence: 0.6,
  walkingK: 0.43,
  runningK: 0.65,
  minWalkingStep: 0.25,
  maxWalkingStep: 1.2,
  minRunningStep: 0.45,
  maxRunningStep: 2,
  speedTau: 1.2,
  vehicleMaxSeconds: 5,
  maxAcceleration: 6,
  maxSpeed: 18,
  heartbeatSeconds: 2,
  sendInterval: 200,
  cellSize: 0.5,
  gpsMaxAge: 5,
  gpsMaxAccuracy: 20,
  gpsMaxInnovation: 60,
  gpsMaxSpeed: 35,
  gpsMaxCorrection: 1.5,
  maxQueue: 30000,
  maxBatch: 100,
  maxBodyBytes: 256000,
  maxSessionObservations: 500000,
  pcaAnisotropy: 0.65,
  pcaGain: 0.08,
  maximumSampleGap: 0.5,
  minimumSampleRate: 15,
  featureSampleRate: 50,
  gaitMinRms: 0.35,
  runningMinRms: 2,
  vehicleMinHorizontalEnergy: 1,
  vehicleMaxPeriodicity: 0.35,
  vehicleGpsSpeed: 2.8,
  gpsStationarySpeed: 0.25,
  gpsCourseMinSpeed: 1,
  gpsHeadingGain: 0.1,
  gpsExcellentAccuracy: 5,
  gpsGoodAccuracy: 10,
});
export const modes = [
  'Unknown',
  'Standing',
  'Walking',
  'Running',
  'TurningInPlace',
  'WalkingTurn',
  'Vehicle',
  'Forklift',
  'Scooter',
];
export const family = (m) =>
  ['Standing', 'TurningInPlace'].includes(m)
    ? 'Stationary'
    : ['Walking', 'WalkingTurn', 'Running'].includes(m)
      ? 'Pedestrian'
      : ['Vehicle', 'Forklift', 'Scooter'].includes(m)
        ? 'Vehicle'
        : 'Unknown';
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const radians = (x) => (x * Math.PI) / 180;
export const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const variance = (a) => {
  const m = mean(a);
  return mean(a.map((x) => (x - m) ** 2));
};
