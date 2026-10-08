// Experimental inertial distance. Initial speed is assumed zero; quiet IMU
// does NOT imply stopped. No gait/stride or GPS input is used.
export class VehicleDistance {
  constructor() {
    this.reset();
  }
  reset() {
    this.velocity = [0, 0];
    this.filtered = [0, 0];
    this.previousT = null;
    this.elapsed = 0;
    this.speed = 0;
  }
  update(sample, type) {
    const t = sample.t;
    const dt = this.previousT === null ? 0 : t - this.previousT;
    this.previousT = t;
    if (!sample.orientationReliable || !Number.isFinite(dt) || dt < 0 || dt > 0.5) {
      this.reset();
      this.previousT = t;
      return { distance: 0, speed: 0, valid: false, reason: 'sensor-gap-or-missing-orientation' };
    }
    this.elapsed += dt;
    const before = this.speed;
    const gain = 1 - Math.exp(-dt / 0.15);
    for (let i = 0; i < 2; i++) {
      this.filtered[i] += gain * (sample.nav[i] - this.filtered[i]);
      const acceleration =
        Math.abs(this.filtered[i]) < 0.08 ? 0 : Math.max(-4, Math.min(4, this.filtered[i]));
      this.velocity[i] += acceleration * dt;
    }
    this.speed = Math.hypot(...this.velocity);
    const maximum = type === 'Cart' ? 3 : 8;
    const limited = this.speed > maximum;
    if (limited) {
      this.velocity = this.velocity.map((v) => (v * maximum) / this.speed);
      this.speed = maximum;
    }
    return {
      distance: ((before + this.speed) * dt) / 2,
      speed: this.speed,
      valid: true,
      experimental: true,
      assumedInitialSpeed: 0,
      elapsed: this.elapsed,
      limited,
    };
  }
}
