import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SensorPipeline } from '../client/pipeline.js';
import { validateRecording, demoSamples } from '../client/sources.js';
import { initialState, MotionObservationReceiver, publicState } from '../server/state.js';
import { config as C } from '../shared/config.js';
import { benchmark } from '../client/benchmark.js';
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error(
    'Usage: node tools/replay.mjs recording.json result.json\n       node tools/replay.mjs --demo result.json',
  );
  process.exit(1);
}
const recording =
  input === '--demo'
    ? { format: 'qsys-recording', version: 1, samples: demoSamples(), groundTruth: [] }
    : validateRecording(JSON.parse(await readFile(input, 'utf8')));
const s = initialState('offline-replay'),
  observations = [],
  engine = new MotionObservationReceiver();
const p = new SensorPipeline(
  (o) => {
    observations.push({ ...o, travelHeading: p.heading.heading });
    engine.process(s, o);
  },
  { deviceId: 'replay', sessionId: s.sessionId },
);
const first = recording.samples[0].t;
for (const sample of recording.samples) {
  const normalized = { ...sample, t: sample.t - first };
  if (sample.kind === 'gps') p.gps(normalized);
  else p.process(normalized);
}
const result = {
  format: 'qsys-result',
  version: 1,
  algorithmVersion: C.version,
  datasetHash: createHash('sha256').update(JSON.stringify(recording.samples)).digest('hex'),
  state: publicState(s),
  observations,
  groundTruth: recording.groundTruth ?? [],
};
await writeFile(output, JSON.stringify(result, null, 2));
const bytes = observations.reduce((sum, o) => sum + Buffer.byteLength(JSON.stringify(o)), 0),
  seconds = s.lastTimestamp;
console.log(
  JSON.stringify(
    {
      metrics: benchmark(result),
      traffic: {
        seconds,
        observations: observations.length,
        observationsPerSecond: observations.length / seconds,
        observationJsonBytes: bytes,
        observationJsonBytesPerSecond: bytes / seconds,
        finalStateJsonBytes: Buffer.byteLength(JSON.stringify(publicState(s))),
      },
    },
    null,
    2,
  ),
);
