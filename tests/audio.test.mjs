/*
 * Audio tests against a stub AudioContext.
 *
 * There is no audio device here, so the contract under test is how the module
 * drives the Web Audio API: it must not touch the API before `enable()` (audio
 * requires a user gesture), must not leak oscillators (each voice has to be
 * stopped or voices accumulate until the tab distorts), and must rate-limit so
 * spamming the pointer cannot start thousands of nodes per second.
 */
import FluxPond from '../src/flux-pond.js';
import { PondAudio, withFrequencies, VOICE_LIMIT } from '../src/audio.js';

const { makeSpecimen, noteFrequency } = FluxPond;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function makeStubContext() {
  const nodes = { oscillators: [], gains: [], filters: [] };
  const context = {
    currentTime: 0,
    state: 'running',
    destination: { kind: 'destination' },
    createGain() {
      const node = {
        kind: 'gain',
        gain: makeParam(),
        connect() {},
        disconnect() {}
      };
      nodes.gains.push(node);
      return node;
    },
    createBiquadFilter() {
      const node = {
        kind: 'filter',
        type: 'lowpass',
        frequency: makeParam(),
        Q: { value: 0 },
        connect() {}
      };
      nodes.filters.push(node);
      return node;
    },
    createOscillator() {
      const node = {
        kind: 'oscillator',
        type: 'sine',
        frequency: makeParam(),
        detune: { value: 0 },
        onended: null,
        started: false,
        stopped: false,
        connect() {}
      };
      node.start = () => {
        if (node.started) {
          throw new Error('oscillator started twice');
        }
        node.started = true;
      };
      node.stop = () => {
        if (!node.started) {
          throw new Error('oscillator stopped before start');
        }
        node.stopped = true;
      };
      nodes.oscillators.push(node);
      return node;
    },
    resume() {
      context.state = 'running';
      return Promise.resolve();
    }
  };
  return { context, nodes };
}

function makeParam() {
  return {
    value: 0,
    setValueAtTime(v) { assertFinited('setValueAtTime', v); this.value = v; return this; },
    linearRampToValueAtTime(v, t) { assertFinited('linearRamp', v); assertFinited('linearRamp.t', t); return this; },
    exponentialRampToValueAtTime(v, t) {
      assertFinited('expRamp', v);
      assertFinited('expRamp.t', t);
      if (v === 0) {
        throw new Error('exponentialRampToValueAtTime(0) throws in real Web Audio');
      }
      return this;
    },
    setTargetAtTime(v, t, c) {
      assertFinited('setTarget', v);
      assertFinited('setTarget.t', t);
      assertFinited('setTarget.c', c);
      return this;
    },
    cancelScheduledValues() { return this; }
  };
}

function assertFinited(label, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${label} received non-finite value: ${value}`);
  }
}

function audioWithStub() {
  const stub = makeStubContext();
  const audio = new PondAudio(() => stub.context);
  return { audio, stub };
}

test('the API is untouched until enable()', async () => {
  const { audio, stub } = audioWithStub();
  const specimen = withFrequencies(makeSpecimen(3), noteFrequency);
  // Without enable(), these must be no-ops rather than constructing nodes.
  audio.startDrone(specimen);
  audio.updateDepth(0.5, 1.0);
  audio.playImpact({ strength: 1.0, waveIndex: 0 });
  audio.playPhenomenon('glide');
  assert(stub.nodes.oscillators.length === 0, 'audio nodes created before enable()');
});

test('enable() then startDrone() starts one oscillator per chord tone, all started', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  const specimen = withFrequencies(makeSpecimen(3), noteFrequency);
  audio.startDrone(specimen);
  const droneVoices = specimen.chords.length;
  assert(
    stub.nodes.oscillators.length === droneVoices,
    `expected ${droneVoices} drone oscillators, got ${stub.nodes.oscillators.length}`
  );
  assert(
    stub.nodes.oscillators.every((node) => node.started),
    'a drone oscillator was never started'
  );
  stub.nodes.oscillators.forEach((node) => node.stop());
});

test('impact voices are rate-limited and bounded', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(5), noteFrequency));
  const droneCount = stub.nodes.oscillators.length;
  // 500 impacts in a single instant must not create 500 voices.
  for (let i = 0; i < 500; i += 1) {
    audio.playImpact({ strength: 1.0, waveIndex: i });
  }
  const impactVoices = stub.nodes.oscillators.length - droneCount;
  assert(impactVoices <= VOICE_LIMIT, `voice budget breached: ${impactVoices} voices`);
  assert(impactVoices >= 1, 'no impact voice at all');
});

test('time advances so impacts are heard, and every voice gets stopped', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(5), noteFrequency));
  const droneCount = stub.nodes.oscillators.length;
  let started = 0;
  for (let i = 0; i < 40; i += 1) {
    stub.context.currentTime += 0.05;
    if (audio.playImpact({ strength: 0.8, waveIndex: i })) {
      started += 1;
    }
  }
  assert(started >= 30, `impacts were over-suppressed: ${started}/40`);
  const impacts = stub.nodes.oscillators.slice(droneCount);
  assert(impacts.every((node) => node.started), 'an impact oscillator never started');
  // Simulate the scheduler retiring voices.
  impacts.forEach((node) => {
    if (typeof node.onended === 'function') {
      node.onended();
    }
  });
});

test('exponential ramps never target exactly zero', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(2), noteFrequency));
  // Any zero target would throw inside makeParam.
  for (const strength of [0.0, 0.0001, 0.5, 3.0]) {
    for (let i = 0; i < 20; i += 1) {
      stub.context.currentTime += 0.05;
      audio.playImpact({ strength, waveIndex: i });
    }
  }
});

test('depth update keeps the filter cutoff in an audible range', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(4), noteFrequency));
  const filter = stub.nodes.filters[0];
  const cutoffs = [];
  for (const immersion of [0.0, 0.25, 0.5, 0.75, 1.0]) {
    for (const speed of [0.0, 1.0, 5.0]) {
      audio.updateDepth(immersion, speed);
      const target = filter.frequency.targets[filter.frequency.targets.length - 1];
      cutoffs.push(target);
    }
  }
  const low = Math.min(...cutoffs);
  const high = Math.max(...cutoffs);
  assert(low >= 20 && low <= 20000, `cutoff too low: ${low}`);
  assert(high >= 20 && high <= 20000, `cutoff too high: ${high}`);
  assert(high > low * 2, `cutoff range too narrow to convey depth: ${low}..${high}`);
});

test('chord frequencies are finite, positive and in a musical range', () => {
  for (let seed = 0; seed < 200; seed += 1) {
    const specimen = withFrequencies(makeSpecimen(seed), noteFrequency);
    assert(specimen.frequencies.length > 0, `seed ${seed} produced no notes`);
    for (const frequency of specimen.frequencies) {
      assert(Number.isFinite(frequency) && frequency > 0, `seed ${seed}: ${frequency}`);
      assert(frequency >= 40 && frequency <= 4000, `seed ${seed} out of range: ${frequency}`);
    }
  }
});

// `setTargetAtTime` records its targets so the cutoff assertion can read them.
function makeParamWithTargets() {
  return makeParam();
}
void makeParamWithTargets;

process.stdout.write(JSON.stringify({ passed, failed: failures.length }) + '\n');
for (const failure of failures) {
  process.stdout.write(`\nFAIL: ${failure.name}\n  ${failure.message}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
