import { readFileSync } from 'node:fs';
import { WalkingTracker } from '../client/walking.js';
// Usage: node tools/analyze-gait.mjs recording.json [recording.json ...]
// Local recordings remain local; only aggregate results are printed.
if (!process.argv[2]) throw new Error('Provide one or more sensor-history JSON files.');
for (const path of process.argv.slice(2)) {
  const data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const history = data.segments?.find((s) => s.phase === 'movement-test')?.history;
  if (!history?.samples || !data.test) throw new Error('Not a movement-test recording: ' + path);
  const tracker = new WalkingTracker({
    drawing: false,
    countSteps: data.test.stepsEnabled !== false,
  });
  tracker.transportType = ['Cart', 'Forklift'].includes(data.test.type) ? data.test.type : 'Auto';
  const events = [
    ...history.samples.map((s) => ({ t: s.t, s })),
    ...history.orientationEvents.map((o) => ({ t: o.t, o })),
  ].sort((a, b) => a.t - b.t);
  for (const e of events) {
    if (e.s) tracker.process(e.s);
    else tracker.orient(e.o.orientation, e.t);
  }
  const rows = tracker.history.filter((r) => r.features && r.t >= 3);
  const counts = {};
  for (const r of rows) counts[r.activity.mode] = (counts[r.activity.mode] ?? 0) + 1;
  const stats = {};
  for (const key of [
    'rms',
    'gyroRms',
    'periodicity',
    'cadence',
    'confirmedCadence',
    'verticalAmplitude',
    'horizontalEnergy',
    'verticalFrequency',
    'verticalHighFrequencyRatio',
  ]) {
    const values = rows
      .map((r) => r.features[key])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    stats[key] = values.length
      ? [0.1, 0.5, 0.9].map((q) => +values[Math.floor((values.length - 1) * q)].toFixed(3))
      : null;
  }
  console.log(
    JSON.stringify(
      {
        type: data.test.type,
        pose: data.test.pose,
        sourceCommit: data.build?.commit,
        samples: history.samples.length,
        duration: history.samples.at(-1)?.t,
        recordedSteps: history.state.steps,
        replayedSteps: tracker.state.steps,
        actualSteps: null,
        classificationAfterThreeSeconds: counts,
        percentiles10_50_90: stats,
      },
      null,
      2,
    ),
  );
}
