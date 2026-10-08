import GeographicLib from 'geographiclib-geodesic';
import { config as C, clamp, radians, wrap } from '../shared/config.js';
const geodesic = GeographicLib.Geodesic.WGS84;
export function geographicToLocal(origin, fix, rotation) {
  const p = geodesic.Inverse(origin.latitude, origin.longitude, fix.latitude, fix.longitude),
    a = radians(p.azi1 - rotation);
  return { x: p.s12 * Math.sin(a), y: p.s12 * Math.cos(a) };
}
export function localToGeographic(origin, p, rotation) {
  const r = geodesic.Direct(
    origin.latitude,
    origin.longitude,
    rotation + (Math.atan2(p.x, p.y) * 180) / Math.PI,
    Math.hypot(p.x, p.y),
  );
  return { lat: r.lat2, lng: r.lon2 };
}
export class IGpsQualityEvaluator {
  evaluate() {
    throw new Error('Implement evaluate');
  }
}
export class GpsQualityEvaluator extends IGpsQualityEvaluator {
  evaluate(fix, state) {
    const rejected = (reason) => ({
      quality: 'Rejected',
      confidence: 0,
      useForCorrection: false,
      reason,
      weight: 0,
      ...fix,
    });
    if (fix.age > C.gpsMaxAge) return rejected('Fixen är för gammal');
    if (fix.accuracy > C.gpsMaxAccuracy)
      return { ...rejected('För låg noggrannhet'), quality: 'Poor' };
    const previous = state.lastAcceptedGps;
    if (previous) {
      const dt = fix.t - previous.t;
      if (dt <= 0) return rejected('Icke-monoton GPS-fix');
      const d = geodesic.Inverse(
        previous.latitude,
        previous.longitude,
        fix.latitude,
        fix.longitude,
      ).s12;
      if (d > C.gpsMaxSpeed * dt + fix.accuracy + previous.accuracy)
        return rejected('Orimlig förflyttning');
      if (state.motionMode === 'Standing' && d > Math.max(8, fix.accuracy + previous.accuracy))
        return rejected('GPS motsäger stillastående');
    }
    if (fix.speed !== null && fix.speed > C.gpsMaxSpeed) return rejected('Orimlig GPS-hastighet');
    if (state.origin && state.geographicHeading !== null) {
      const p = geographicToLocal(state.origin, fix, state.geographicHeading);
      p.x += state.originLocal?.x ?? 0;
      p.y += state.originLocal?.y ?? 0;
      if (Math.hypot(p.x - state.x, p.y - state.y) > C.gpsMaxInnovation + fix.accuracy)
        return rejected('För stor innovation');
    }
    return {
      ...fix,
      quality:
        fix.accuracy <= C.gpsExcellentAccuracy
          ? 'Excellent'
          : fix.accuracy <= C.gpsGoodAccuracy
            ? 'Good'
            : 'Moderate',
      confidence: clamp(1 - fix.accuracy / 30, 0.2, 0.95),
      useForCorrection: true,
      reason: 'Godkänd kvalitetskontroll',
      weight: 0,
    };
  }
}
export class GpsPositionFusion {
  constructor() {
    this.evaluator = new GpsQualityEvaluator();
  }
  apply(fix, s) {
    s.gps = this.evaluator.evaluate(fix, s);
    if (!s.gps.useForCorrection) return;
    s.lastAcceptedGps = fix;
    if (!s.origin) {
      s.origin = { ...fix };
      s.originLocal = { x: s.x, y: s.y };
    }
    // Anchor start-local frame to geography only when a genuine moving GPS course is present.
    if (s.geographicHeading === null && fix.speed > C.gpsCourseMinSpeed && fix.heading !== null)
      s.geographicHeading = wrap(fix.heading - s.heading);
    else if (
      s.geographicHeading !== null &&
      fix.speed > C.gpsCourseMinSpeed &&
      fix.heading !== null
    )
      s.heading = wrap(
        s.heading +
          C.gpsHeadingGain * s.gps.confidence * wrap(fix.heading - s.geographicHeading - s.heading),
      );
    if (fix.speed !== null) {
      s.velocity = clamp(fix.speed, 0, C.maxSpeed);
      s.lastVelocityCorrection = fix.t;
    }
    if (s.geographicHeading === null) {
      s.gps.reason = 'God fix; inväntar färdriktning för positionsankare';
      s.gps.useForCorrection = false;
      return;
    }
    const p = geographicToLocal(s.origin, fix, s.geographicHeading);
    p.x += s.originLocal.x;
    p.y += s.originLocal.y;
    const r = Math.max(1, (fix.accuracy / 2) ** 2),
      gain = s.positionVariance / (s.positionVariance + r),
      dx = p.x - s.x,
      dy = p.y - s.y,
      d = Math.hypot(dx, dy);
    const actualGain = gain * Math.min(1, C.gpsMaxCorrection / Math.max(0.0001, d * gain));
    s.gpsCorrectionCount++;
    s.predictedPosition = { x: s.x, y: s.y };
    s.x += actualGain * dx;
    s.y += actualGain * dy;
    s.positionVariance = Math.max(0.25, (1 - actualGain) * s.positionVariance);
    s.gps.weight = actualGain;
  }
}
