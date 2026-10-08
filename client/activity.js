// Heuristic activity scores, not calibrated statistical probabilities.
// Cart and forklift have no reliable generic IMU-only distinguishing feature.
export class ActivityEstimator {
  constructor() {
    this.current = {
      mode: 'Unknown',
      label: 'Inväntar data',
      probability: 0,
      probabilities: {},
      source: 'sensors',
    };
    this.last = null;
    this.candidate = null;
    this.since = 0;
  }
  update(f, t, transport = 'Auto', vehicleMoving = false, speed = 0) {
    if (!f || f.sampleRate < 15) return this.current;
    const highSpeed = Number.isFinite(speed) && speed > 35 / 3.6;
    this.last = f;
    this.transport = transport;
    const quiet = f.rms < 0.2 && f.gyroRms < 5;
    const gait =
      f.periodicity >= 0.48 &&
      f.verticalAmplitude >= 1.1 &&
      f.horizontalEnergy >= 0.012 &&
      f.cadence >= 0.8 &&
      f.cadence <= 3.8 &&
      (f.verticalHighFrequencyRatio ?? 0) < 0.65;
    const running = gait && f.cadence >= 2.5 && f.rms >= 2;
    const vehicle = !gait && f.horizontalEnergy >= 0.08 && f.periodicity < 0.4;
    let scores = quiet
      ? { Standing: 0.8, Walking: 0.03, Running: 0.01, Cart: 0.03, Forklift: 0.03, Unknown: 0.1 }
      : gait
        ? {
            Standing: 0.02,
            Walking: running ? 0.15 : 0.76,
            Running: running ? 0.7 : 0.08,
            Cart: 0.03,
            Forklift: 0.03,
            Unknown: running ? 0.07 : 0.08,
          }
        : vehicle
          ? {
              Standing: 0.05,
              Walking: 0.05,
              Running: 0.02,
              Cart: 0.34,
              Forklift: 0.34,
              Unknown: 0.2,
            }
          : {
              Standing: 0.15,
              Walking: 0.18,
              Running: 0.07,
              Cart: 0.1,
              Forklift: 0.1,
              Unknown: 0.4,
            };
    if (!gait && vehicleMoving && transport === 'Auto')
      scores = {
        Standing: 0.15,
        Walking: 0.05,
        Running: 0.02,
        Cart: 0.24,
        Forklift: 0.24,
        Unknown: 0.3,
      };
    if (!gait && ['Cart', 'Forklift'].includes(transport) && (!quiet || vehicleMoving)) {
      scores = {
        Standing: quiet ? 0.25 : 0.08,
        Walking: 0.05,
        Running: 0.02,
        Cart: 0.03,
        Forklift: 0.03,
        Unknown: quiet ? 0.1 : 0.14,
        [transport]: quiet ? 0.55 : 0.65,
      };
    }
    if (highSpeed)
      scores = { Standing: 0, Walking: 0, Running: 0, Cart: 0, Forklift: 1, Unknown: 0 };
    if (gait && !highSpeed) {
      scores.Cart = 0;
      scores.Forklift = 0;
    }
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const probabilities = Object.fromEntries(
      Object.entries(scores).map(([key, value]) => [key, value / total]),
    );
    let mode = Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0];
    let probability = probabilities[mode];
    if (!highSpeed && !gait && transport === 'Auto' && (vehicle || vehicleMoving)) {
      mode = 'VehicleUnknown';
      probability = probabilities.Cart + probabilities.Forklift;
    }
    const labels = {
      Standing: 'Står',
      Walking: 'Går',
      Running: 'Springer',
      Cart: 'Kör vagn',
      Forklift: 'Kör truck',
      VehicleUnknown: 'Vagn / truck',
      Unknown: 'Osäkert',
    };
    if (mode !== this.candidate) {
      this.candidate = mode;
      this.since = t;
    }
    // Require persistent evidence; the displayed percentage always belongs to
    // the displayed activity, even while a new candidate is being confirmed.
    if (
      highSpeed ||
      (gait && ['Cart', 'Forklift', 'VehicleUnknown'].includes(this.current.mode)) ||
      this.current.mode === 'Unknown' ||
      t - this.since >= 0.7 ||
      transport !== this.current.transport
    ) {
      this.current = {
        mode,
        label: labels[mode],
        probability,
        probabilities,
        transport,
        source: transport === 'Auto' ? 'sensors' : 'sensors-and-selected-transport',
        calibrated: false,
        reason: highSpeed
          ? 'user-rule-estimated-speed-over-35-kmh'
          : gait
            ? 'persistent-gait-pattern'
            : 'heuristic',
      };
    } else {
      this.current = {
        ...this.current,
        probabilities,
        probability:
          this.current.mode === 'VehicleUnknown'
            ? probabilities.Cart + probabilities.Forklift
            : (probabilities[this.current.mode] ?? 0),
      };
    }
    return this.current;
  }
}
