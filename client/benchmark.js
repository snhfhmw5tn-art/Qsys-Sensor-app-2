import { wrap } from '../shared/config.js';
export function benchmark(result) {
  const s = result.state,
    truth = result.groundTruth ?? s.groundTruth ?? [],
    path = s.trajectory,
    positions = truth.filter((x) => x.position);
  const nearest = (t) =>
    path.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), path[0]);
  const errors = positions.map((x) => {
    const p = nearest(x.t);
    return Math.hypot(p.x - x.position.x, p.y - x.position.y);
  });
  const truthDistance = truth.filter((x) => Number.isFinite(x.knownDistance)).at(-1)?.knownDistance;
  const stepTruth = truth.filter((x) => Number.isFinite(x.knownSteps)).at(-1)?.knownSteps;
  const stationaryLabels = truth.some((x) => ['Standing', 'TurningInPlace'].includes(x.mode));
  const falseSteps =
    stationaryLabels && result.observations
      ? result.observations
          .flatMap((o) => o.steps ?? [])
          .filter((step) => {
            const label = truth.filter((x) => x.t <= step.timestamp).at(-1);
            return label && ['Standing', 'TurningInPlace'].includes(label.mode);
          }).length
      : null;
  const headings = truth
    .filter((x) => Number.isFinite(x.heading))
    .map((x) => {
      const p = result.observations?.reduce(
        (a, b) =>
          Math.abs(b.monotonicTimestamp - x.t) < Math.abs(a.monotonicTimestamp - x.t) ? b : a,
        result.observations[0],
      );
      return p?.travelHeading === undefined ? null : Math.abs(wrap(p.travelHeading - x.heading));
    })
    .filter((x) => x !== null);
  // Time-weighted activity accuracy, evaluated only in labeled intervals.
  const events = s.modeHistory ?? [...(s.events ?? [])].reverse();
  let labeled = 0,
    correct = 0,
    falseTransitions = 0;
  const sorted = [...truth].sort((a, b) => a.t - b.t);
  for (let i = 0; i < events.length; i++) {
    const e = events[i],
      end = events[i + 1]?.t ?? s.lastTimestamp;
    for (let j = 0; j < sorted.length; j++) {
      const label = sorted[j],
        labelEnd = sorted[j + 1]?.t ?? s.lastTimestamp,
        overlap = Math.max(0, Math.min(end, labelEnd) - Math.max(e.t, label.t));
      labeled += overlap;
      if (label.mode === e.mode) correct += overlap;
    }
    const label = sorted.filter((x) => x.t <= e.t).at(-1);
    if (i && label && label.mode !== e.mode) falseTransitions++;
  }
  return {
    algorithmVersion: result.algorithmVersion ?? '?',
    datasetHash: result.datasetHash ?? null,
    modeAccuracy: labeled ? (100 * correct) / labeled : null,
    falseTransitions: labeled ? falseTransitions : null,
    confirmedSteps: s.steps,
    falseSteps,
    stepCountError: stepTruth === undefined ? null : s.steps - stepTruth,
    headingError: headings.length ? headings.reduce((a, b) => a + b) / headings.length : null,
    distanceError: truthDistance === undefined ? null : Math.abs(s.totalDistance - truthDistance),
    endpointError: errors.at(-1) ?? null,
    trajectoryError: errors.length
      ? Math.sqrt(errors.reduce((a, b) => a + b * b, 0) / errors.length)
      : null,
    gpsCorrectionCount: s.gpsCorrectionCount,
  };
}
