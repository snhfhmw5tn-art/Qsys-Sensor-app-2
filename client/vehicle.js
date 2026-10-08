// Experimental fixed-mount, planar nonholonomic model. Starts at rest.
// Forward axis is learned from the initial acceleration in the navigation frame.
// Lateral/centripetal acceleration is diagnostic, never added to forward speed.
export class VehicleDistance {
  constructor() {
    this.reset();
  }
  reset() {
    this.previousT = null;
    this.elapsed = 0;
    this.speed = 0;
    this.heading = null;
    this.forwardFiltered = 0;
    this.initial = [0, 0];
    this.initialTime = 0;
  }
  update(sample) {
    const dt = this.previousT === null ? 0 : sample.t - this.previousT;
    this.previousT = sample.t;
    if (!sample.orientationReliable || !Number.isFinite(dt) || dt < 0 || dt > 0.5) {
      this.reset();
      this.previousT = sample.t;
      return { distance: 0, speed: 0, valid: false, reason: 'sensor-gap-or-missing-orientation' };
    }
    this.elapsed += dt;
    const yaw = ((sample.yawRate ?? 0) * Math.PI) / 180;
    if (this.heading === null) {
      // Establish the mount-to-travel offset only from sustained initial motion.
      if (Math.hypot(sample.nav[0], sample.nav[1]) > 0.15 && Math.abs(yaw) < 0.15) {
        this.initial[0] += sample.nav[0] * dt;
        this.initial[1] += sample.nav[1] * dt;
        this.initialTime += dt;
        if (this.initialTime >= 0.2) {
          this.heading = Math.atan2(this.initial[0], this.initial[1]);
          this.speed = Math.hypot(...this.initial);
        }
      } else {
        this.initial = [0, 0];
        this.initialTime = 0;
      }
      return {
        distance: 0,
        speed: this.speed,
        valid: true,
        experimental: true,
        assumedInitialSpeed: 0,
        initializing: this.heading === null,
      };
    }
    // nav yaw is counterclockwise; heading is clockwise from north.
    const middle = this.heading - (yaw * dt) / 2;
    this.heading -= yaw * dt;
    const forward = sample.nav[0] * Math.sin(middle) + sample.nav[1] * Math.cos(middle);
    const lateral = sample.nav[0] * Math.cos(middle) - sample.nav[1] * Math.sin(middle);
    this.forwardFiltered += (1 - Math.exp(-dt / 0.15)) * (forward - this.forwardFiltered);
    const acceleration =
      Math.abs(this.forwardFiltered) < 0.08 ? 0 : Math.max(-4, Math.min(4, this.forwardFiltered));
    const before = this.speed;
    // Forward-only model; reverse travel requires a new initialization.
    this.speed = Math.max(0, Math.min(20, this.speed + acceleration * dt));
    return {
      distance: ((before + this.speed) * dt) / 2,
      speed: this.speed,
      valid: true,
      experimental: true,
      assumedInitialSpeed: 0,
      elapsed: this.elapsed,
      limited: this.speed === 20,
      forwardAcceleration: forward,
      lateralAcceleration: lateral,
      yawRate: sample.yawRate ?? 0,
      heading: (this.heading * 180) / Math.PI,
      expectedLateralAcceleration: -this.speed * yaw,
      model: 'fixed-mount-longitudinal-no-sideslip',
    };
  }
}
