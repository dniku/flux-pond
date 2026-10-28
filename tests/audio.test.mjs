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
import { PondAudio, withFrequencies, VOICE_LIMIT, PRESENCE } from '../src/audio.js';

const { makeSpecimen, noteFrequency } = FluxPond;

/*
 * The drone's own two presence voices: the sub-bass and the LFO that pulses it.
 * Asserted against the total oscillator count rather than the chord alone, so a
 * voice leaked per note still fails the leak check.
 */
const PRESENCE_VOICES = 2;

let passed = 0;
const failures = [];

/*
 * The bodies here are async (enabling audio awaits a context resume), so the
 * helper has to await them. It used to call `fn()` and count the test as passed
 * synchronously, which meant every assertion after the first `await` was
 * silently discarded -- including a real NaN bug that only the Chromium check
 * surfaced. Test bodies that reject are now recorded, and the report at the
 * bottom waits for all of them.
 */
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push({ name, message: error.message, stack: error.stack });
    }
  })();
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
    // Every scheduled target, in order: tests assert on the values the module
    // actually asked the param to move to (the cutoff range test is unreadable
    // without this, and was silently dead until the helper began awaiting).
    targets: [],
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
      this.targets.push(v);
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

await test('the API is untouched until enable()', async () => {
  const { audio, stub } = audioWithStub();
  const specimen = withFrequencies(makeSpecimen(3), noteFrequency);
  // Without enable(), these must be no-ops rather than constructing nodes.
  audio.startDrone(specimen);
  audio.updateDepth(0.5, 1.0);
  audio.playImpact({ strength: 1.0, waveIndex: 0 });
  audio.playPhenomenon('glide');
  assert(stub.nodes.oscillators.length === 0, 'audio nodes created before enable()');
});

await test('enable() then startDrone() starts one oscillator per chord tone, all started', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  const specimen = withFrequencies(makeSpecimen(3), noteFrequency);
  audio.startDrone(specimen);
  const droneVoices = specimen.chords.length;
  // The chord, plus the two voices of the presence bed (the sub and the LFO that
  // pulses it) -- and nothing else. Naming the presence voices rather than
  // counting chords alone keeps this a leak check: the day a third voice appears
  // per note, this fails.
  assert(
    stub.nodes.oscillators.length === droneVoices + PRESENCE_VOICES,
    `expected ${droneVoices + PRESENCE_VOICES} oscillators (${droneVoices} chord + ${PRESENCE_VOICES} presence), got ${stub.nodes.oscillators.length}`
  );
  assert(
    stub.nodes.oscillators.every((node) => node.started),
    'a drone oscillator was never started'
  );
  // Driving it must not be another opportunity to leak a voice.
  for (let i = 0; i < 200; i += 1) {
    audio.updatePresence((i % 100) / 100);
  }
  assert(
    stub.nodes.oscillators.length === droneVoices + PRESENCE_VOICES,
    `updatePresence built new oscillators: ${stub.nodes.oscillators.length}`
  );
  stub.nodes.oscillators.forEach((node) => node.stop());
});

/*
 * A reroll cannot rebuild the bed -- an oscillator cannot be restarted -- so a
 * new specimen has to retune the voices already running. There was no path at
 * all before this: `startDrone` refuses a second bed, so specimen two swam in
 * specimen one's key, and so did every impact note it made.
 */
await test('a new specimen retunes the bed that is already playing', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  const first = withFrequencies(makeSpecimen(3), noteFrequency);
  const second = withFrequencies(makeSpecimen(42), noteFrequency);
  audio.startDrone(first);
  const built = stub.nodes.oscillators.length;
  const chordVoices = audio.drone.oscillators;

  assert(audio.retune(second) === true, 'retune refused a live bed');
  assert(
    stub.nodes.oscillators.length === built,
    `retune built ${stub.nodes.oscillators.length - built} new voices instead of reusing ${built}`
  );
  for (const voice of chordVoices) {
    const targets = voice.frequency.targets;
    const target = targets[targets.length - 1];
    assert(
      second.frequencies.includes(target),
      `a chord voice was left at ${target}, not in the new chord ${second.frequencies}`
    );
  }
  const subTargets = audio.drone.sub.frequency.targets;
  assert(
    Math.abs(subTargets[subTargets.length - 1] - second.root / 2.0) < 1e-9,
    `presence sub stayed at ${subTargets[subTargets.length - 1]} instead of ${second.root / 2.0}`
  );

  // The audible consequence: an impact after the reroll is pitched off the new
  // specimen's chord, which is the part no visual check could ever have caught.
  const voiceCount = stub.nodes.oscillators.length;
  audio.playImpact({ strength: 0.5, waveIndex: 0 });
  const impact = stub.nodes.oscillators[voiceCount];
  assert(impact !== undefined, 'no impact voice was started');
  assert(
    Math.abs(impact.frequency.value - second.frequencies[0] * 2.0) < 1e-9,
    `impact pitched ${impact.frequency.value}, expected ${second.frequencies[0] * 2.0} from the new specimen`
  );
});

await test('retune builds a first bed, and refuses a specimen it cannot play', async () => {
  const { audio, stub } = audioWithStub();
  const specimen = withFrequencies(makeSpecimen(5), noteFrequency);
  // Before a gesture there is no context to speak into.
  assert(audio.retune(specimen) === false, 'retune built a bed before enable()');
  assert(stub.nodes.oscillators.length === 0, 'retune touched the API before enable()');

  await audio.enable();
  assert(audio.retune(specimen) === true, 'retune did not build the first bed');
  assert(stub.nodes.oscillators.length > 0, 'retune built nothing once enabled');
  const playable = audio.drone.specimen;

  for (const broken of [{ frequencies: [] }, { frequencies: [NaN, 220] }, { frequencies: [0] }, {}]) {
    assert(audio.retune(broken) === false, `retune accepted ${JSON.stringify(broken)}`);
  }
  assert(audio.drone.specimen === playable, 'a refused retune still replaced the chord');
});

/*
 * The presence voice is the only thing that warns you about the lurker when you
 * are not looking into the dark, so what matters is the shape of the curve, not
 * its existence: silent when the animal is nowhere near, monotonic as it
 * closes, and loud enough to hear without swallowing the chord.
 */
await test('presence is silent at a distance and swells as the lurker closes', async () => {
  const { audio } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(6), noteFrequency));
  const levels = [];
  const pulses = [];
  for (const nearness of [0.0, 0.05, 0.2, 0.5, 0.8, 1.0]) {
    audio.drone.presence.gain.targets.length = 0;
    audio.drone.pulse.frequency.targets.length = 0;
    audio.updatePresence(nearness);
    levels.push(audio.drone.presence.gain.targets[0]);
    pulses.push(audio.drone.pulse.frequency.targets[0]);
  }
  assert(levels[0] === 0.0, `a lurker 2.8 away produced level ${levels[0]}`);
  assert(levels[1] === 0.0, `below the floor the voice should be exactly silent, got ${levels[1]}`);
  for (let i = 2; i < levels.length; i += 1) {
    assert(levels[i] > levels[i - 1], `presence did not swell from nearness ${i}: ${levels}`);
  }
  assert(
    levels[levels.length - 1] <= PRESENCE.peak + 1e-9,
    `presence peaks above its own ceiling: ${levels[levels.length - 1]}`
  );
  assert(
    levels[levels.length - 1] > 0.05,
    'presence never gets loud enough to hear over the bed'
  );
  for (let i = 1; i < pulses.length; i += 1) {
    assert(pulses[i] > pulses[i - 1], `the pulse stopped quickening: ${pulses}`);
  }
  assert(
    pulses[pulses.length - 1] < 12.0,
    `the pulse rate is a buzz, not a throb: ${pulses[pulses.length - 1]} Hz`
  );
});

await test('presence ignores a broken nearness instead of breaking the loop', async () => {
  const { audio } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(9), noteFrequency));
  for (const bad of [NaN, Infinity, -Infinity, undefined, null]) {
    // The stub throws on a non-finite param, which is what a real browser does.
    assert(audio.updatePresence(bad) === true, `updatePresence refused ${String(bad)}`);
    const scheduled = audio.drone.presence.gain.targets;
    assert(
      scheduled[scheduled.length - 1] === 0.0,
      `${String(bad)} reached the presence level as ${scheduled[scheduled.length - 1]}`
    );
  }
  // And with no graph at all there is nothing to speak into.
  const bare = new PondAudio(() => makeStubContext().context);
  assert(bare.updatePresence(1.0) === false, 'presence spoke before audio was enabled');
});

await test('impact voices are rate-limited and bounded', async () => {
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

await test('time advances so impacts are heard, and every voice gets stopped', async () => {
  const { audio, stub } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(5), noteFrequency));
  const droneCount = stub.nodes.oscillators.length;
  let started = 0;
  for (let i = 0; i < 40; i += 1) {
    stub.context.currentTime += 0.05;
    if (audio.playImpact({ strength: 0.8, waveIndex: i })) {
      started += 1;
      // The scheduler retires a voice when it ends; without this the budget
      // (eight live voices) caps the run at eight, which is not what is under
      // test here. `the voice budget caps a burst` covers the limit itself.
      const node = stub.nodes.oscillators[stub.nodes.oscillators.length - 1];
      node.onended();
    }
  }
  assert(started === 40, `impacts were over-suppressed: ${started}/40`);
  const impacts = stub.nodes.oscillators.slice(droneCount);
  assert(impacts.length === 40, `expected 40 impact voices, got ${impacts.length}`);
  assert(impacts.every((node) => node.started), 'an impact oscillator never started');
  assert(impacts.every((node) => node.stopped), 'an impact oscillator was never stopped');
});

await test('exponential ramps never target exactly zero', async () => {
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

await test('depth update keeps the filter cutoff in an audible range', async () => {
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

await test('chord frequencies are finite, positive and in a musical range', () => {
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

await test('an impact survives the endless trench, where the wave index goes negative', async () => {
  // The app derives waveIndex from `Math.round(ripple.x * 3)`, and world x is
  // negative as soon as the creature swims left of its origin. JS `%` keeps the
  // sign of the dividend, so -7 selected `frequencies[-2]` -- undefined -- and
  // NaN reached setValueAtTime, which a real browser throws on. This was found
  // by the Chromium page check, not by these tests, which only ever passed
  // positive indices.
  const { audio, stub } = audioWithStub();
  await audio.enable();
  audio.startDrone(withFrequencies(makeSpecimen(3), noteFrequency));
  for (const waveIndex of [0, -1, -2, -5, -7, -1234, 1234]) {
    stub.context.currentTime += 0.05;  // clear the rate limit between notes
    assert(
      audio.playImpact({ strength: 0.8, waveIndex }) === true,
      `impact at waveIndex ${waveIndex} was not played`
    );
  }
  const last = stub.nodes.oscillators[stub.nodes.oscillators.length - 1];
  assert(Number.isFinite(last.frequency.value), `oscillator frequency not finite: ${last.frequency.value}`);
  assert(last.frequency.value > 0, `oscillator frequency not audible: ${last.frequency.value}`);
});

process.stdout.write(JSON.stringify({ passed, failed: failures.length }) + '\n');
for (const failure of failures) {
  process.stdout.write(`\nFAIL: ${failure.name}\n  ${failure.message}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
