/*
 * Behavioural tests for the Flux Pond physics core, run by real Node.
 *
 * These assert observable contracts (does it float, does it stay finite, does
 * motion make waves) rather than mirroring constants, so they keep their value
 * when tuning constants changes.
 */
import FluxPond from '../src/flux-pond.js';

const {
  WORLD, FOOD, World, SurfaceField, makeSpecimen, clamp, smoothstep,
  noteFrequency, buildWavetable, sampleWavetable, layerAt
} = FluxPond;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error.message, stack: error.stack });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual, expected, tolerance, message) {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${message}: expected ${expected} +/- ${tolerance}, got ${actual}`
  );
}

function assertFinite(value, message) {
  assert(Number.isFinite(value), `${message}: got ${value}`);
}

function run(world, seconds, dt = 1 / 60) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    world.step(dt);
    world.followCamera(dt);
  }
}

function allFinite(world) {
  const creature = world.creature;
  for (let i = 0; i < creature.points; i += 1) {
    if (!Number.isFinite(creature.x[i]) || !Number.isFinite(creature.y[i])) {
      return false;
    }
    if (!Number.isFinite(creature.vx[i]) || !Number.isFinite(creature.vy[i])) {
      return false;
    }
  }
  return true;
}

// --- determinism -----------------------------------------------------------
test('same seed produces an identical simulation', () => {
  const a = new World({ seed: 1234 });
  const b = new World({ seed: 1234 });
  run(a, 2.0);
  run(b, 2.0);
  for (let i = 0; i < a.creature.points; i += 1) {
    assert(a.creature.x[i] === b.creature.x[i], `x[${i}] diverged`);
    assert(a.creature.y[i] === b.creature.y[i], `y[${i}] diverged`);
  }
});

test('different seeds produce different creatures', () => {
  const a = makeSpecimen(1);
  const b = makeSpecimen(2);
  const differ = a.memory.some((value, i) => Math.abs(value - b.memory[i]) > 1e-6);
  assert(differ, 'specimens are identical');
});

// --- stability -------------------------------------------------------------
test('simulation stays finite under 30s and 600 seeds', () => {
  for (let seed = 0; seed < 600; seed += 1) {
    const world = new World({ seed });
    run(world, 30.0);
    assert(allFinite(world), `seed ${seed} produced non-finite state`);
    const centroid = world.creature.centroid();
    assert(Math.abs(centroid.x) < 1e4, `seed ${seed} centroid x escaped: ${centroid.x}`);
    assert(
      centroid.y > -0.61 && centroid.y < WORLD.depth + 0.01,
      `seed ${seed} centroid y out of range: ${centroid.y}`
    );
  }
});

test('survives a hostile pointer: maximum pressure, tracking the creature', () => {
  const world = new World({ seed: 7 });
  for (let i = 0; i < 1800; i += 1) {
    const centre = world.creature.centroid();
    world.setPointer({ x: centre.x + Math.sin(i / 7) * 0.1, y: centre.y, pressure: 1.0, active: true });
    world.step(1 / 60);
  }
  assert(allFinite(world), 'hostile pointer produced non-finite state');
});

test('survives degenerate frame times', () => {
  const world = new World({ seed: 11 });
  for (const dt of [0, 1e-6, 1 / 240, 1 / 30, 0.5, 5.0]) {
    world.step(dt);
    world.followCamera(dt);
  }
  assert(allFinite(world), 'degenerate dt produced non-finite state');
});

// --- physics semantics ----------------------------------------------------
test('creature floats at its designed trim depth', () => {
  // The invariant is Archimedes, not a magic y: a body floats where its wetted
  // fraction equals WORLD.floatTrim. The mass-weighted centroid can legitimately
  // sit above the waterline (negative y) while the body is partly submerged, so
  // asserting on centroid.y would encode the old sign bug.
  // A floating body bobs, so the invariant is the time-average, not an
  // instantaneous sample: measured over 110 s per seed the mean wetted fraction
  // lands on floatTrim to within a percent.
  //
  // `food: false` because this measures buoyancy alone. Hunger is a reason for
  // the creature to leave the surface, so running this with the plankton layer
  // present would be measuring two things at once -- and it is exactly the
  // behaviour the feeding tests below assert.
  const world = new World({ seed: 42, food: false });
  let sum = 0.0;
  let samples = 0;
  for (let i = 0; i < 60 * 120; i += 1) {
    world.step(1 / 60);
    world.followCamera(1 / 60);
    if (world.time > 10.0) {
      sum += world.creature.immersion();
      samples += 1;
    }
  }
  const immersion = sum / samples;
  assertClose(immersion, WORLD.floatTrim, 0.05, 'mean wetted fraction should sit at floatTrim');
  // And it must straddle the surface: neither dry nor sunk.
  const deepest = world.creature.lowestDepth();
  const highest = Math.min(...world.creature.y);
  assert(deepest > 0.0, `body entirely above water: lowest point ${deepest}`);
  assert(highest < WORLD.depth, `body resting on the floor: highest point ${highest}`);
});

test('buoyancy is derived from floatTrim, not an independent knob', () => {
  // gravity / floatTrim defines buoyancy, so the equilibrium is exact by
  // construction; this guards the derivation rather than a literal.
  const implied = WORLD.gravity / WORLD.floatTrim;
  const world = new World({ seed: 5 });
  run(world, 25.0);
  const immersion = world.creature.immersion();
  assert(immersion > 0.05 && immersion < 0.95, `did not float: ${immersion}`);
  assert(implied > WORLD.gravity, `floatTrim ${WORLD.floatTrim} must be < 1 so the body is buoyant`);
});

test('creature never passes through the floor', () => {
  const world = new World({ seed: 99 });
  world.setPointer({ x: 0.0, y: 0.0, pressure: 1.0, active: true });
  run(world, 20.0);
  const creature = world.creature;
  let deepest = -Infinity;
  for (let i = 0; i < creature.points; i += 1) {
    deepest = Math.max(deepest, creature.y[i]);
  }
  assert(deepest <= WORLD.depth + 1e-9, `a mass went through the floor: ${deepest}`);
});

test('area is preserved: the body does not collapse or inflate', () => {
  const world = new World({ seed: 5 });
  const start = world.creature.area();
  run(world, 15.0);
  const ratio = world.creature.area() / start;
  assert(ratio > 0.5 && ratio < 2.0, `area drifted to ${ratio.toFixed(3)}x`);
});

test('it swims: an off-centre pointer produces net travel', () => {
  const world = new World({ seed: 21 });
  run(world, 1.0);
  const before = world.creature.centroid().x;
  for (let i = 0; i < 900; i += 1) {
    const centre = world.creature.centroid();
    // Chase from ahead: the classic "follow the finger" drive.
    world.setPointer({ x: centre.x + 0.55, y: centre.y - 0.05, pressure: 0.8, active: true });
    world.step(1 / 60);
    world.followCamera(1 / 60);
  }
  const travelled = world.creature.centroid().x - before;
  assert(Math.abs(travelled) > 0.5, `did not travel: dx=${travelled}`);
});

test('wake events are caused by surface crossings, not by the pointer', () => {
  // Ripples are injected only when a mass crosses the free surface, so a body
  // that keeps crossing makes them and a body held still makes none -- even
  // though the pointer is "on". This is the causal claim the toy depends on: the
  // wake is caused by the creature rather than painted under the cursor.
  const swimming = new World({ seed: 31 });
  run(swimming, 8.0);
  assert(swimming.metrics.wakeEvents > 0, 'a swimming creature made no wake at all');

  const arrested = new World({ seed: 31 });
  const snapshotX = Float64Array.from(arrested.creature.x);
  const snapshotY = Float64Array.from(arrested.creature.y);
  for (let i = 0; i < 60 * 8; i += 1) {
    arrested.setPointer({ x: arrested.creature.centroid().x + 0.4, y: 0.3, pressure: 1.0, active: true });
    arrested.step(1 / 60);
    // Harness-side arrest: pin the body so no mass can cross the surface.
    arrested.creature.x.set(snapshotX);
    arrested.creature.y.set(snapshotY);
    for (let mass = 0; mass < arrested.creature.points; mass += 1) {
      arrested.creature.vx[mass] = 0.0;
      arrested.creature.vy[mass] = 0.0;
    }
  }
  assert(
    arrested.metrics.wakeEvents === 0,
    `an immobile body still injected ${arrested.metrics.wakeEvents} ripples`
  );
});

test('surface field advects ripples to the right and decays them', () => {
  const field = new SurfaceField(WORLD);
  field.inject(2.0, 0.5, WORLD.wakeSigma);
  const peakBefore = field.sample(2.0);
  for (let i = 0; i < 120; i += 1) {
    field.advance(1 / 60);
  }
  const peakAfter = field.sample(2.0);
  assert(peakAfter < peakBefore * 0.9, `ripple did not decay: ${peakBefore} -> ${peakAfter}`);
  const downstream = field.sample(2.0 + WORLD.wakeSpread);
  assert(downstream > field.sample(2.0 - WORLD.wakeSpread), 'ripple did not travel downstream');
});

test('surface field clamps runaway amplitude', () => {
  const field = new SurfaceField(WORLD);
  for (let i = 0; i < 400; i += 1) {
    field.inject(3.0, 5.0, WORLD.wakeSigma);
  }
  assert(Math.abs(field.sample(3.0)) <= WORLD.wakeMaxAmp + 1e-6, 'amplitude not clamped');
});

// --- phenomena ------------------------------------------------------------
test('phenomena latch and unlatch rather than flicker', () => {
  const world = new World({ seed: 63 });
  run(world, 2.0);
  const seen = new Set();
  let transitions = 0;
  let previous = { ...world.phenomena };
  for (let i = 0; i < 3600; i += 1) {
    const centre = world.creature.centroid();
    world.setPointer({
      x: centre.x + 0.5 * Math.sin(i / 40),
      y: 0.05 + 0.5 * Math.abs(Math.sin(i / 190)),
      pressure: 0.9,
      active: true
    });
    world.step(1 / 60);
    world.followCamera(1 / 60);
    for (const key of Object.keys(world.phenomena)) {
      if (world.phenomena[key]) {
        seen.add(key);
      }
      if (world.phenomena[key] !== previous[key]) {
        transitions += 1;
      }
    }
    previous = { ...world.phenomena };
  }
  assert(seen.size > 0, 'no phenomenon ever triggered');
  // Hysteresis: a 60s session should not produce hundreds of edges.
  assert(transitions < 400, `phenomena flickered: ${transitions} transitions`);
});

test('every phenomenon key is reachable by direct condition', () => {
  const world = new World({ seed: 8 });
  for (const key of Object.keys(WORLD ? world.phenomena : {})) {
    world.settle(key, true, 1.0, 0.01, 0.01);
    assert(world.phenomena[key] === true, `${key} never latched`);
    world.settle(key, false, 1.0, 0.01, 0.01);
    assert(world.phenomena[key] === false, `${key} never unlatched`);
  }
});

// --- autonomous behaviour --------------------------------------------------
test('an untouched creature stays alive: it drifts instead of freezing', () => {
  // Idle self-propulsion is what makes the toy worth watching with hands off,
  // so "still moving after a minute" is the contract, not a specific path.
  const world = new World({ seed: 42 });
  let sum = 0.0;
  let samples = 0;
  for (let i = 0; i < 60 * 60; i += 1) {
    world.step(1 / 60);
    world.followCamera(1 / 60);
    if (world.time > 10.0) {
      sum += world.creature.speed();
      samples += 1;
    }
  }
  const meanSpeed = sum / samples;
  assert(meanSpeed > 0.2, `idle creature stalled: mean speed ${meanSpeed}`);
  assert(world.metrics.distance > 5.0, `idle creature went nowhere: ${world.metrics.distance}`);
});

test('idle propulsion undulates the body rather than translating it', () => {
  // A body that only translates looks like a falling object. The tail must move
  // side to side relative to the centroid, which is what the travelling wave is
  // for; measure it as tail lateral motion well above centroid lateral motion.
  const world = new World({ seed: 7 });
  let tailMotion = 0.0;
  let samples = 0;
  for (let i = 0; i < 60 * 30; i += 1) {
    world.step(1 / 60);
    if (world.time > 8.0) {
      const creature = world.creature;
      const tail = creature.tailIndex;
      tailMotion += Math.abs(creature.vy[tail]);
      samples += 1;
    }
  }
  assert(samples > 0, 'no samples taken');
  assert(tailMotion / samples > 0.1, `no undulation: mean |tail vy| ${tailMotion / samples}`);
});

test('self-propulsion yields to the player and resumes when left alone', () => {
  const world = new World({ seed: 3 });
  run(world, 5.0);
  assert(world.selfDrive > 0.5, `expected idle drive, got ${world.selfDrive}`);
  for (let i = 0; i < 300; i += 1) {
    const centre = world.creature.centroid();
    world.setPointer({ x: centre.x + 0.4, y: centre.y, pressure: 0.7, active: true });
    world.step(1 / 60);
  }
  assert(world.selfDrive < 0.05, `drive did not yield to the pointer: ${world.selfDrive}`);
  // The shell clears `active` on pointerleave; without that the world has no
  // way to know the cursor went away.
  world.setPointer({ active: false });
  run(world, 6.0);
  assert(world.selfDrive > 0.5, `drive did not resume: ${world.selfDrive}`);
});

test('idle creatures remain bounded across many seeds', () => {
  // Bounded, not surface-locked. A hungry creature dives, so it is fully
  // submerged for stretches, which an instantaneous `immersion < 1` sample used
  // to forbid (it failed on seed 2 the moment the hunger drive worked). What
  // must hold is that it stays in the water column, is not stranded dry, does
  // not settle on the floor, and is not permanently sunk.
  for (let seed = 0; seed < 150; seed += 1) {
    const world = new World({ seed });
    let dry = 0;
    let onFloor = 0;
    let immersionSum = 0.0;
    let samples = 0;
    for (let i = 0; i < Math.round(45.0 * 60); i += 1) {
      world.step(1 / 60);
      world.followCamera(1 / 60);
      if (world.creature.immersion() <= 0.0) {
        dry += 1;
      }
      if (world.creature.lowestDepth() > WORLD.depth - 0.03) {
        onFloor += 1;
      }
      immersionSum += world.creature.immersion();
      samples += 1;
    }
    assert(allFinite(world), `seed ${seed}: non-finite`);
    assert(dry / samples < 0.25, `seed ${seed}: dry for ${Math.round(100 * dry / samples)}% of the run`);
    assert(
      onFloor / samples < 0.25,
      `seed ${seed}: on the floor for ${Math.round(100 * onFloor / samples)}% of the run`
    );
    const meanImmersion = immersionSum / samples;
    assert(meanImmersion < 0.98, `seed ${seed}: permanently sunk (${meanImmersion})`);
    assert(Math.abs(world.creature.centroid().y) < 0.8, `seed ${seed}: left the column`);
  }
});

// --- feeding ---------------------------------------------------------------
function forage(seed, seconds) {
  // Idle run, sampled: what the creature did, and how wet it was while doing it.
  const world = new World({ seed, food: true });
  let immersionSum = 0.0;
  let samples = 0;
  let minHunger = 1.0;
  let feedEvents = 0;
  world.step(1 / 60);
  for (const event of world.events) {
    if (event.kind === 'feed') {
      feedEvents += 1;
    }
  }
  for (let i = 0; i < Math.round(seconds * 60); i += 1) {
    world.step(1 / 60);
    world.followCamera(1 / 60);
    immersionSum += world.creature.immersion();
    minHunger = Math.min(minHunger, world.hunger);
    samples += 1;
  }
  return { world, meanImmersion: immersionSum / samples, minHunger, feedEvents };
}

test('an idle creature hunts: hunger breaks the trim and ends in meals', () => {
  // The whole point of the layer: with no player, the creature does not merely
  // bob. Compared against the same seed on an empty trench, it sits wetter, and
  // it eats.
  const hungry = forage(7, 60);
  const fasting = new World({ seed: 7, food: false });
  let floatingSum = 0.0;
  for (let i = 0; i < Math.round(60.0 * 60); i += 1) {
    fasting.step(1 / 60);
    fasting.followCamera(1 / 60);
    floatingSum += fasting.creature.immersion();
  }
  const floating = floatingSum / (60.0 * 60);
  assert(hungry.world.metrics.fedCount > 0, 'idle creature never fed in 60 s');
  assert(
    hungry.meanImmersion > floating + 0.05,
    `hunting did not deepen the creature: ${hungry.meanImmersion} vs floating ${floating}`
  );
  assert(hungry.minHunger < FOOD.startHunger, 'hunger never fell, so nothing was eaten');
});

test('hunger rises with time and a bite knocks it back down', () => {
  const world = new World({ seed: 11 });
  const start = world.hunger;
  run(world, 10.0);
  assert(world.hunger > start, 'hunger did not rise while it foraged');

  // Compare every sample with the highest value before it: hunger climbs
  // steadily, so the only thing that can knock it down is a bite, and one bite
  // is a fall of about `biteRelief` against a rising baseline.
  let peak = world.hunger;
  let largestFall = 0.0;
  for (let i = 0; i < 60 * 60; i += 1) {
    world.step(1 / 60);
    world.followCamera(1 / 60);
    largestFall = Math.max(largestFall, peak - world.hunger);
    peak = Math.max(peak, world.hunger);
  }
  assert(world.metrics.fedCount > 0, 'never found a mote in 60 s of hunting');
  assert(
    largestFall > FOOD.biteRelief * 0.5,
    `a bite did not relieve hunger: largest fall ${largestFall}`
  );
});

test('a grazed mote is gone until it regrows', () => {
  const world = new World({ seed: 5 });
  let found = null;
  world.forEachMote(0.0, 5.0, (id, x, y) => {
    if (found === null) {
      found = { id, x, y };
    }
  });
  assert(found !== null, 'no motes in the first five metres of trench');
  const seenBefore = [];
  world.forEachMote(0.0, 5.0, (id) => seenBefore.push(id));
  assert(seenBefore.includes(found.id), 'mote not present before grazing');

  world.foodEaten.set(found.id, world.time + FOOD.regrowSeconds);
  const seenWhileGrazed = [];
  world.forEachMote(0.0, 5.0, (id) => seenWhileGrazed.push(id));
  assert(!seenWhileGrazed.includes(found.id), 'grazed mote still present');

  world.time += FOOD.regrowSeconds + 0.001;
  const seenAfter = [];
  world.forEachMote(0.0, 5.0, (id) => seenAfter.push(id));
  assert(seenAfter.includes(found.id), 'mote did not regrow');
});

test('the plankton field is endless and reproducible', () => {
  // The trench is infinite, so the field is hashed from cell indices rather than
  // stored: it has to still exist 400 m along, and two runs must agree exactly.
  const a = new World({ seed: 1234 });
  const b = new World({ seed: 1234 });
  const far = (world) => {
    const list = [];
    world.forEachMote(400.0, 405.0, (id, x, y, size) => list.push([id, x, y, size]));
    return list;
  };
  const listA = far(a);
  const listB = far(b);
  assert(listA.length > 0, 'no plankton 400 m from the origin');
  assert(JSON.stringify(listA) === JSON.stringify(listB), 'plankton field is not deterministic');
  for (const [, x, y] of listA) {
    assert(x >= 400.0 - FOOD.cellWidth && x <= 405.0 + FOOD.cellWidth, 'mote outside the requested span');
    assert(y > 0.0 && y < WORLD.depth, `mote outside the column: ${y}`);
  }
  const other = new World({ seed: 1235 });
  assert(JSON.stringify(far(other)) !== JSON.stringify(listA), 'every seed grows the same garden');
});

test('feeding events are well formed and the state stays bounded', () => {
  const hunt = forage(20261027, 90);
  const world = hunt.world;
  assert(world.metrics.fedCount > 0, 'no meals in 90 s');
  let feedEvents = 0;
  for (const event of world.events) {
    if (event.kind !== 'feed') {
      continue;
    }
    feedEvents += 1;
    assert(Number.isFinite(event.x) && Number.isFinite(event.y), 'feed event at a non-finite place');
  }
  assert(feedEvents > 0, 'the event log lost the feeding events');
  assert(world.foodEaten.size <= FOOD.maxEaten, 'grazed-mote memory is unbounded');
  assert(world.feedPops.length <= 12, 'bite rings are unbounded');
});

test('an empty trench changes nothing else about the creature', () => {
  const world = new World({ seed: 21, food: false });
  run(world, 30.0);
  assert(world.metrics.fedCount === 0, 'creature fed in an empty trench');
  assert(world.hunger === FOOD.startHunger, 'hunger moved with the layer switched off');
  assert(world.foodTarget === null, 'the creature hunted a layer that is not there');
});

// --- helpers --------------------------------------------------------------
test('clamp and smoothstep behave at and beyond the edges', () => {
  assert(clamp(-1, 0, 1) === 0 && clamp(2, 0, 1) === 1 && clamp(0.5, 0, 1) === 0.5, 'clamp');
  assert(smoothstep(0, 1, -5) === 0 && smoothstep(0, 1, 5) === 1, 'smoothstep edges');
  assertClose(smoothstep(0, 1, 0.5), 0.5, 1e-12, 'smoothstep midpoint');
  assert(smoothstep(1, 1, 0.5) === 0 && smoothstep(1, 1, 1.5) === 1, 'degenerate smoothstep');
});

test('layerAt partitions depth and covers the whole range', () => {
  assert(layerAt(0.0).id === 'surface', 'depth 0 should be surface');
  assert(layerAt(0.999).id === 'abyss', 'depth 1 should be abyss');
  const tones = [0.0, 0.1, 0.2, 0.4, 0.7, 0.9].map((d) => layerAt(d).tone);
  for (let i = 1; i < tones.length; i += 1) {
    assert(tones[i] >= tones[i - 1], 'layer tone is not monotonic with depth');
  }
});

test('noteFrequency is monotonic and octaves double', () => {
  const root = 110;
  let previous = 0;
  for (let degree = 0; degree < 12; degree += 1) {
    const frequency = noteFrequency(root, 'major', degree);
    assert(frequency > previous, `degree ${degree} not monotonic`);
    previous = frequency;
  }
  assertClose(noteFrequency(root, 'major', 5), root * 2, 1e-9, 'one octave up');
  assertClose(noteFrequency(root, 'minor', 5), root * 2, 1e-9, 'minor octave');
  assertClose(noteFrequency(root, 'nonsense', 0), root, 1e-9, 'unknown scale falls back');
});

test('wavetable is normalised, continuous and finite', () => {
  const table = buildWavetable(14);
  let peak = 0;
  for (let i = 0; i < table.length; i += 1) {
    assert(Number.isFinite(table[i]), `table[${i}] not finite`);
    peak = Math.max(peak, Math.abs(table[i]));
  }
  assert(peak <= 1.0001, `table not normalised: peak ${peak}`);
  const step = 1 / table.length;
  let maxJump = 0;
  for (let i = 0; i < table.length; i += 1) {
    const a = sampleWavetable(table, i * step);
    const b = sampleWavetable(table, (i + 1) * step);
    maxJump = Math.max(maxJump, Math.abs(b - a));
  }
  assert(maxJump < 0.05, `wavetable discontinuity: ${maxJump}`);
  // Wraps at both ends without throwing.
  for (const phase of [-1.5, -1, 0, 1, 2.75]) {
    assert(Number.isFinite(sampleWavetable(table, phase)), `phase ${phase} not finite`);
  }
});

test('reset restores a finite creature and clears phenomena', () => {
  const world = new World({ seed: 3 });
  run(world, 5.0);
  world.reset(4);
  assert(world.seed === 4, 'reset kept the old seed');
  assert(
    Object.values(world.phenomena).every((value) => value === false),
    'phenomena survived reset'
  );
  assert(
    Object.keys(world.dwellStates).every((key) => world.dwellStates[key].timer <= 0),
    'dwell timers survived reset'
  );
  run(world, 5.0);
  assert(allFinite(world), 'post-reset simulation is not finite');
});

test('health reports the state of a pathological creature', () => {
  const world = new World({ seed: 13 });
  run(world, 3.0);
  assert(world.health().ok === true, `healthy run reported problems: ${world.health().problems}`);
  world.creature.x.fill(0);
  world.creature.y.fill(0);
  const report = world.health();
  assert(report.ok === false, 'collapsed creature reported healthy');
  assert(report.problems.includes('collapsed'), `expected collapse, got ${report.problems}`);
});

test('a new creature starts stress-free', () => {
  // The bug this guards: rest lengths used to be computed from a formula that
  // disagreed with the loop the spawn code actually placed, so every specimen
  // began inside a huge internal fight (perimeter springs wanted 4.08x the
  // spacing they were given) and the equilibrium shape was decided by that
  // mismatch rather than by the specimen generator. Rest lengths are now
  // measured from the built geometry, so zero initial stress is an invariant.
  for (let seed = 0; seed < 40; seed += 1) {
    const world = new World({ seed });
    const creature = world.creature;
    const n = creature.points;
    for (let i = 0; i < n; i += 1) {
      const pairs = [
        [creature.perimeter[2 * i], creature.perimeter[2 * i + 1], creature.restPerimeter[i]],
        [creature.structural[2 * i], creature.structural[2 * i + 1], creature.restStructural[i]],
        [creature.bend[2 * i], creature.bend[2 * i + 1], creature.restBend[i]]
      ];
      for (const [a, b, rest] of pairs) {
        const built = Math.hypot(creature.x[b] - creature.x[a], creature.y[b] - creature.y[a]);
        assertClose(built, rest, 1e-12, `seed ${seed}: spring ${a}-${b} rest length vs built`);
        assert(rest > 0, `seed ${seed}: non-positive rest length`);
      }
    }
  }
});

test('the body holds its built shape while it floats', () => {
  // With rest lengths measured from the built loop, perimeter springs should
  // neither gather the body into a knot nor blow it apart: the mean spacing has
  // to stay near the rest spacing.
  const world = new World({ seed: 20261027 });
  const creature = world.creature;
  run(world, 12.0);
  let ratioSum = 0.0;
  for (let i = 0; i < creature.points; i += 1) {
    const a = creature.perimeter[2 * i];
    const b = creature.perimeter[2 * i + 1];
    const built = Math.hypot(creature.x[b] - creature.x[a], creature.y[b] - creature.y[a]);
    ratioSum += built / creature.restPerimeter[i];
  }
  const mean = ratioSum / creature.points;
  assert(mean > 0.7 && mean < 1.4, `perimeter spacing drifted from rest: ${mean}`);
});

test('the nose and tail are fixed material points opposite each other', () => {
  // The renderer anchors the eye and the tail fin to these. If they moved
  // between frames the creature's face would teleport, which is why they are
  // derived from the specimen's silhouette rather than from its velocity.
  const world = new World({ seed: 99 });
  const creature = world.creature;
  const noseAtStart = creature.nose;
  let thickest = 0;
  for (let i = 1; i < creature.points; i += 1) {
    if (creature.memory[i] > creature.memory[thickest]) {
      thickest = i;
    }
  }
  assert(noseAtStart === thickest, 'the nose is not at the thickest part of the outline');
  run(world, 15.0);
  assert(
    world.creature.nose === noseAtStart && world.creature.tailIndex === creature.tailIndex,
    'body axis indices changed during the run'
  );
  assert(
    (noseAtStart + Math.floor(creature.points / 2)) % creature.points === creature.tailIndex,
    'the tail is not diametrically opposite the nose'
  );
});

// --- report ---------------------------------------------------------------
const results = { passed, failed: failures.length };
process.stdout.write(JSON.stringify(results) + '\n');
for (const failure of failures) {
  process.stdout.write(`\nFAIL: ${failure.name}\n  ${failure.message}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
