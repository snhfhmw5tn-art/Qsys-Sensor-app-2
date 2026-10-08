import { WalkingTracker } from './walking.js';
export const testTypes = {
  Walking: { label: 'Gång', slug: 'gang', vehicle: false },
  Standing: { label: 'Stillastående', slug: 'stillastaende', vehicle: false },
  Running: { label: 'Löpning', slug: 'lopning', vehicle: false },
  Cart: { label: 'Rullvagn', slug: 'rullvagn', vehicle: true },
  Forklift: { label: 'Truck', slug: 'truck', vehicle: true },
};
export const bodyPoses = {
  upright: 'Upprätt hand, telefon i handen',
  swinging: 'Telefon i pendlande hand',
  pocket: 'Telefon i byxficka',
};
export const vehiclePoses = {
  up: 'Telefon lagd uppåt',
  down: 'Telefon lagd nedåt',
  right: 'Telefon lutad åt höger',
  left: 'Telefon lutad åt vänster',
};
export const testSpeeds = { walking: 'Gångfart', medium: 'Medelfart', fast: 'Snabb fart' };
export class TestSession {
  constructor({ type, pose, speed = null, distance = null }, now = new Date().toISOString()) {
    const definition = testTypes[type];
    if (!definition || !(pose in (definition.vehicle ? vehiclePoses : bodyPoses)))
      throw new Error('Ogiltigt test eller telefonläge.');
    if (definition.vehicle && !(speed in testSpeeds)) throw new Error('Välj fartkategori.');
    if (distance !== null && (!Number.isFinite(distance) || distance < 0))
      throw new Error('Ogiltig teststräcka.');
    this.metadata = {
      kind: 'movement-test',
      type,
      label: definition.label,
      pose,
      poseLabel: (definition.vehicle ? vehiclePoses : bodyPoses)[pose],
      speed: definition.vehicle ? speed : null,
      speedLabel: definition.vehicle ? testSpeeds[speed] : null,
      knownDistance: type === 'Standing' ? 0 : distance,
      groundTruthSource: 'operator-selected-test',
      startedAt: now,
      endedAt: null,
      stepsEnabled: !definition.vehicle,
    };
    this.tracker = new WalkingTracker({
      drawing: false,
      stepLength: definition.vehicle ? 0 : 0.76,
      countSteps: !definition.vehicle,
    });
    this.tracker.transportType = definition.vehicle ? type : 'Auto';
    this.origin = null;
    this.active = true;
    this.statusEvents = [];
    this.description = ['test', definition.slug, pose, ...(definition.vehicle ? [speed] : [])].join(
      '-',
    );
  }
  process(sample) {
    if (!this.active) return;
    this.origin ??= sample.t;
    this.tracker.process({ ...sample, sourceT: sample.t, t: sample.t - this.origin });
  }
  orient(orientation, t) {
    if (!this.active) return;
    this.origin ??= t;
    this.tracker.orient(orientation, t - this.origin);
  }
  event(event) {
    if (this.active) this.statusEvents.push(structuredClone(event));
  }
  finish(context = {}, now = new Date().toISOString()) {
    if (this.active) {
      this.active = false;
      this.metadata.endedAt = now;
      this.payload = structuredClone({
        ...context,
        format: 'qsys-sensor-history',
        version: 1,
        description: this.description,
        test: this.metadata,
        statusEvents: this.statusEvents,
        segments: [
          {
            phase: 'movement-test',
            sourceTimeOrigin: this.origin,
            history: this.tracker.exportHistory(),
          },
        ],
      });
    }
    return this.payload;
  }
}
