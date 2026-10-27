/*
 * Flux Pond -- physics core.
 *
 * Pure logic: no DOM, no canvas, no audio. A "mass-spring-ponton" closed loop of
 * buoyant springs lives inside a shallow, stratified, laterally traveling fluid
 * layer. Everything here is deterministic given the same World, so it can be
 * exercised head-less (see tests/sim.test.mjs).
 *
 * Coordinate space is normalised: the fluid layer is the strip 0 <= y <= 1,
 * where y = 0 is the surface (air above) and y = 1 is the floor. x advances
 * continuously to the right while the camera follows the creature, so the
 * world is an endless side-scrolling trench.
 */

const WORLD = {
  depth: 1.0,
  halfWidth: 1.6,
  segments: 22,
  /* Spawn pose: deep enough to be seen surface, and slightly squashed so the
   * first thing that happens is the body rounding out as it rises. */
  spawnDepth: 0.42,
  spawnSquash: 0.9,
  substeps: 8,
  dt: 1 / 120,
  gravity: 4.4,
  fluidRho: 0.045,
  dragLinear: 0.95,
  dragQuad: 2.6,
  springK: 220,
  bendK: 60,
  structuralK: 130,
  structuralRatio: 2,
  maxSpeed: 9.0,
  maxStep: 0.05,
  impulseLimit: 4.0,
  wakeSigma: 0.05,
  wakeMass: 0.012,
  wakeMinSpeed: 0.16,
  wakeGain: 0.55,
  wakeDecay: 0.9955,
  wakeSpread: 0.42,
  wakeMaxAmp: 1.6,
  fieldCells: 1024,
  fieldWidth: 24.0,
  minVolume: 0.0035,
  injectMinInterval: 1 / 60,
  injectMinDistance: 0.055,
  maxRipples: 240,

  /*
   * Buoyancy is derived, not tuned: `gravity / floatTrim` puts the Archimedes
   * equilibrium exactly at the intended wetted fraction. Floating is then one
   * law rather than two competing accelerations.
   *
   * A mass in the fluid feels `liftFraction * buoyantAccel` upward, where
   * `buoyantAccel = buoyancy - gravity` is the body's excess buoyancy when
   * fully submerged, and `liftFraction` is how much of the body is under
   * water. That is Archimedes: buoyant force is proportional to displaced
   * volume. At the waterline `liftFraction` crosses `weightFraction`, which is
   * the equilibrium riding depth `floatTrim`, so the creature settles at the
   * surface instead of being launched out of it (pure buoyancy) or pinned to
   * the floor (an over-stiff restoring term).
   */
  /*
   * Equilibrium wetted fraction. Archimedes: a body floats where its weight is
   * balanced by the weight of fluid it displaces, so with weight `gravity` and
   * fully-submerged buoyancy `buoyancy`, equilibrium is reached at
   * `gravity / buoyancy` = 4.4 / 10.8. `floatTrim` is that ratio written the
   * other way round -- it sets `buoyancy = gravity / floatTrim` -- so the
   * creature rides with a third of its height under water by construction and
   * the test suite can assert the waterline rather than a magic depth.
   */
  floatTrim: 0.34,

  /*
   * Pointer force as an acceleration at the cursor, at full pressure and zero
   * distance. Chosen against the drag law above rather than by feel: drag
   * accel is `dragLinear * v + dragQuad * v^2`, so a steady cruise at
   * `glide.speed` needs sustained pointer accel of the same order, and the
   * linear falloff means only part of the body contributes at once. Measured
   * outcome: ~2.4 top sustained speed against the ~12.9 net buoyancy, which is
   * what makes the floor reachable and every phenomenon triggerable.
   */
  pointerForce: 22.0,

  /*
   * Self-propulsion, so an untouched creature paddles about instead of bobbing
   * like a balloon. It uses the same body-force mechanism as the pointer, which
   * keeps one force law and means the idle creature interacts with its own wake
   * exactly the way a driven one does.
   *
   * Two components: thrust along a slowly turning heading, and a travelling
   * lateral wave along the body. The wave is what sells it -- a body that
   * translates without undulating reads as a falling object, not an animal.
   */
  idleDelay: 1.8,
  idleRamp: 1.4,
  selfThrust: 0.95,
  selfWaveForce: 1.0,
  selfWaveCycles: 1.6,
  selfWaveHz: 1.5,
  /* Depth steering target: the swimmer keeps itself near its floating trim
   * rather than drifting up out of the water or settling on the floor. */
  selfDepthGain: 1.6
};

const LAYERS = [
  { id: 'surface', bottom: 0.055, tone: 0.06 },
  { id: 'photic', bottom: 0.30, tone: 0.26 },
  { id: 'twilight', bottom: 0.58, tone: 0.52 },
  { id: 'sounding', bottom: 0.82, tone: 0.76 },
  { id: 'abyss', bottom: 1.0, tone: 1.0 }
];

/*
 * Integer -> [0,1). Cheap and dependency-free; the field only needs to be
 * stable and decorrelated enough not to look gridded.
 */
function hashUnit(a, b) {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function foodBand(seed) {
  const rng = makeRng((seed ^ 0x9e3779b1) >>> 0);
  const top = FOOD.bandTop + rng() * FOOD.bandTopSpan;
  return { top, bottom: Math.min(WORLD.depth - 0.05, top + FOOD.bandThickness) };
}

/*
 * Visit the live motes whose cell overlaps [minX, maxX]. A mote that has been
 * grazed is skipped until it regrows, and the expiry is pruned here rather than
 * on a timer, because this is the only place its id is in hand.
 */
function forEachMote(world, minX, maxX, visit) {
  const first = Math.floor(minX / FOOD.cellWidth);
  const last = Math.floor(maxX / FOOD.cellWidth);
  const seed = world.seed;
  for (let cell = first; cell <= last; cell += 1) {
    for (let sub = 0; sub < FOOD.maxMotesPerCell; sub += 1) {
      const salt = (sub + 1) * 0x3f7311;
      if (hashUnit(cell, seed ^ salt) >= FOOD.presence) {
        continue;
      }
      const id = cell * FOOD.maxMotesPerCell + sub;
      const regrows = world.foodEaten.get(id);
      if (regrows !== undefined) {
        if (world.time >= regrows) {
          world.foodEaten.delete(id);
        } else {
          continue;
        }
      }
      const x = (cell + hashUnit(cell, seed ^ (salt + 17))) * FOOD.cellWidth;
      const y =
        lerp(world.foodBand.top, world.foodBand.bottom, hashUnit(cell, seed ^ (salt + 29))) +
        FOOD.bobAmplitude * Math.sin(2.0 * Math.PI * (world.time * FOOD.bobHz + hashUnit(cell, seed ^ (salt + 41))));
      visit(id, x, y, 0.55 + 0.45 * hashUnit(cell, seed ^ (salt + 53)));
    }
  }
}

function nearestMote(world, x, y, radius) {
  let best = null;
  let bestDistanceSq = radius * radius;
  forEachMote(world, x - radius, x + radius, (id, moteX, moteY, size) => {
    const dx = moteX - x;
    const dy = moteY - y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq;
      best = { id, x: moteX, y: moteY, size };
    }
  });
  return best;
}

/* Shortest-arc blend: headings wrap, and a linear one would spin the long way. */
function lerpAngle(a, b, t) {
  let delta = (b - a) % (Math.PI * 2.0);
  if (delta > Math.PI) {
    delta -= Math.PI * 2.0;
  } else if (delta < -Math.PI) {
    delta += Math.PI * 2.0;
  }
  return a + delta * t;
}

/*
 * One graze pass: every mass is a possible mouth. Cheap vertical reject first,
 * because the band is a fraction of the column and the body usually misses it.
 */
function graze(world) {
  const creature = world.creature;
  const biteSq = FOOD.biteRadius * FOOD.biteRadius;
  const top = world.foodBand.top - FOOD.biteRadius;
  const bottom = world.foodBand.bottom + FOOD.biteRadius;
  for (let i = 0; i < creature.points; i += 1) {
    const y = creature.y[i];
    if (y < top || y > bottom) {
      continue;
    }
    const x = creature.x[i];
    forEachMote(world, x - FOOD.biteRadius, x + FOOD.biteRadius, (id, moteX, moteY) => {
      const dx = moteX - x;
      const dy = moteY - y;
      if (dx * dx + dy * dy > biteSq) {
        return;
      }
      world.foodEaten.set(id, world.time + FOOD.regrowSeconds);
      if (world.foodEaten.size > FOOD.maxEaten) {
        world.foodEaten.delete(world.foodEaten.keys().next().value);
      }
      world.hunger = clamp(world.hunger - FOOD.biteRelief, 0.0, 1.0);
      world.metrics.fedCount += 1;
      world.feedPops.push({ x: moteX, y: moteY, age: 0.0 });
      if (world.feedPops.length > 12) {
        world.feedPops.shift();
      }
      world.emit({ kind: 'feed', x: moteX, y: moteY, strength: 1.0 });
    });
  }
}

/*
 * Detection thresholds, in units the sim actually produces.
 *
 * `depth` fields are *wetted fractions* of the body (0 = dry, 1 = submerged),
 * matching `Creature.immersion`, so `skim` and `dive` bound the same quantity
 * from opposite ends.
 *
 * Set from measured distributions rather than guessed: a resting body sits at
 * immersion ~0.32 (that is `floatTrim`), so skim must sit below it, and 0.14 was
 * the ~10th percentile of an actively worked run (598 of 6000 frames). Speeds
 * are relative to the ~2.4 top speed the pointer can sustain.
 */
const PHENOMENA = {
  skim: { depth: 0.14 },
  breach: { speed: 1.1 },
  skitter: { speed: 1.5, depth: 0.2 },
  glide: { speed: 0.55, straightness: 0.9, depth: 0.7 },
  dive: { depth: 0.72 },
  bounce: { impulse: 0.15 }
};

/*
 * Plankton: the reason an untouched creature has somewhere to be.
 *
 * The trench is endless, so the layer is generated rather than stored. Each
 * cell of world x hashes to up to `maxMotesPerCell` motes inside a seed-
 * dependent band; only two things are remembered -- which mote ids have been
 * grazed (with a regrow time) and the creature's hunger -- so walking forever
 * cannot grow the state, and any position is reproducible from the seed alone.
 *
 * Hunger is not a new force. It re-aims the body-wide steering acceleration the
 * idle creature already uses, which keeps one force law and means a hungry
 * creature interacts with its own wake exactly the way a steered one does.
 */
const FOOD = {
  cellWidth: 0.5,
  maxMotesPerCell: 3,
  presence: 0.55,
  bandTop: 0.24,
  bandTopSpan: 0.38,
  bandThickness: 0.2,
  bobAmplitude: 0.014,
  bobHz: 0.06,
  moteRadius: 0.0075,
  biteRadius: 0.075,
  searchRadius: 2.0,
  hungerRate: 0.035,
  biteRelief: 0.34,
  startHunger: 0.62,
  biasThreshold: 0.42,
  steerGain: 0.85,
  /*
   * A hunting dive has to beat the body's own excess buoyancy, and there is no
   * way to fake that: a fully submerged body is accelerated upward at
   * `gravity / floatTrim - gravity` = 8.5, so the old 3.0 ceiling on the depth
   * steering could never have held one down, and a hungry creature simply
   * bobbed and starved. `diveThrust` cancels that excess -- what fins do -- and
   * the proportional term then steers on top of it. `huntDepthGain` is the gain
   * for a committed dive; the surface gain stays where it was.
   */
  diveThrust: 1.0,
  huntDepthGain: 8.0,
  authority: 16.0,
  regrowSeconds: 50,
  maxEaten: 600
};

const SPECIES = [
  { name: 'Dewlap', chords: [5, 7, 9, 11], scale: 'major', bulge: 0.34, tail: 0.6 },
  { name: 'Tinker', chords: [5, 7, 10, 11], scale: 'major', bulge: 0.2, tail: 0.95 },
  { name: 'Lissom', chords: [0, 3, 5, 7, 10], scale: 'minor', bulge: 0.5, tail: 0.45 },
  { name: 'Gristle', chords: [0, 2, 6, 7, 9], scale: 'major', bulge: 0.06, tail: 1.25 },
  { name: 'Vellum', chords: [0, 2, 4, 7, 9], scale: 'major', bulge: 0.42, tail: 0.75 },
  { name: 'Murk', chords: [0, 3, 6, 9, 10], scale: 'minor', bulge: 0.28, tail: 1.05 }
];

const WAVETABLE_PARTIALS = 14;

function makeRng(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return function nextFloat() {
    state = (state + 0x6d2b79f5) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) {
    return x < edge0 ? 0.0 : 1.0;
  }
  const t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

/*
 * Strata with explicit top/bottom edges, derived from `LAYERS` so the renderer
 * and any depth logic share one definition of where a layer starts and ends.
 */
function buildStrata() {
  const strata = [];
  let top = 0.0;
  for (const layer of LAYERS) {
    strata.push({ id: layer.id, top, bottom: layer.bottom, tone: layer.tone });
    top = layer.bottom;
  }
  return strata;
}

function layerAt(depth) {
  for (let index = 0; index < LAYERS.length; index += 1) {
    if (depth < LAYERS[index].bottom) {
      return LAYERS[index];
    }
  }
  return LAYERS[LAYERS.length - 1];
}

/*
 * Height field of the free surface, stored as cells in world x.
 *
 * Two mechanisms share one array:
 *  - explicit ripples: a Gaussian bump injected at the wetted/surface
 *    crossing, which then advects to the right at `advection` and decays;
 *  - global standing waves: non-advecting, decay-free sinusoids, so a creature
 *    moving at constant speed excites a phase-locked wake and a slow sloshing
 *    mode appears at the ends of the trench.
 */
class SurfaceField {
  constructor(config) {
    this.cells = config.fieldCells;
    this.width = config.fieldWidth;
    this.cellSize = this.width / this.cells;
    this.amp = new Float32Array(this.cells);
    this.ripple = new Float32Array(this.cells);
    this.advection = WORLD.wakeSpread;
    this.decay = config.wakeDecay;
    this.standing = [
      { k: 0.42, amp: 0.0055, speed: 0.55, phase: 0.0 },
      { k: 1.05, amp: 0.0028, speed: 1.15, phase: 1.7 },
      { k: 2.15, amp: 0.0013, speed: 2.1, phase: 3.4 }
    ];
    this.injected = 0;
    this.maxCells = config.maxRipples;
    this.active = 0;
  }

  indexAt(x) {
    return Math.floor(x / this.cellSize);
  }

  cellCenter(index) {
    return (index + 0.5) * this.cellSize;
  }

  /*
   * Inject a Gaussian bump. Repeated injections at the same spot interfere
   * constructively (they add), which is what turns a rapid sequence of footfalls
   * into a coherent wake; saturation keeps a stuck pointer from blowing up.
   */
  inject(x, amp, sigma) {
    const radius = Math.max(1, Math.ceil((3.0 * sigma) / this.cellSize));
    const centre = this.indexAt(x);
    const scale = 0.5 * radius * radius;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const index = centre + offset;
      if (index < 0 || index >= this.cells) {
        continue;
      }
      const d = index - centre;
      this.ripple[index] += amp * Math.exp(-(d * d) / (2.0 * scale));
    }
    this.injected += 1;
  }

  sample(x) {
    const raw = this.rawHeight(x);
    return clamp(raw, -WORLD.wakeMaxAmp, WORLD.wakeMaxAmp);
  }

  rawHeight(x) {
    const index = this.indexAt(x);
    let value = 0.0;
    if (index >= 0 && index < this.cells) {
      value += this.ripple[index];
    }
    for (let i = 0; i < this.standing.length; i += 1) {
      const mode = this.standing[i];
      value += mode.amp * Math.sin(mode.k * x + mode.phase);
    }
    return value;
  }

  slope(x) {
    const h = this.cellSize;
    return (this.sample(x + h) - this.sample(x - h)) / (2.0 * h);
  }

  advance(dt) {
    const { ripple, amp, cells, cellSize } = this;
    const shift = this.advection * dt;
    const move = Math.max(1, Math.round(shift / cellSize));
    const factor = Math.pow(this.decay, dt * 120.0);
    let active = 0;
    for (let i = cells - 1; i >= 0; i -= 1) {
      const source = i - move;
      const value = source >= 0 ? ripple[source] * factor : 0.0;
      ripple[i] = value;
      amp[i] = value;
      if (value > 0.0016 || value < -0.0016) {
        active += 1;
      }
    }
    this.active = Math.min(active, this.maxCells);
    for (let i = 0; i < this.standing.length; i += 1) {
      const mode = this.standing[i];
      mode.phase += mode.k * mode.speed * dt;
    }
  }
}

/*
 * The creature: a closed loop of point masses.
 *
 * Constraints, in decreasing stiffness:
 *  - structural springs (chord between masses `structuralRatio` apart) hold
 *    the loop's overall size;
 *  - perimeter springs hold local spacing;
 *  - bend springs (skip one mass) hold local curvature, which is what makes
 *    the body read as an animal rather than a wet sock.
 * A soft area constraint stops it collapsing, and a shape memory gives each
 * generated specimen a characteristic silhouette it relaxes towards.
 */
class Creature {
  constructor(specimen, field) {
    this.field = field;
    this.name = specimen.name;
    this.scale = specimen.scale;
    this.hue = specimen.hue;
    this.chords = specimen.chords;
    this.scaleName = specimen.scaleName;
    this.memory = specimen.memory;
    /*
     * Body axis, as material indices fixed when the specimen is generated. The
     * nose is the thickest mass, which is also the heaviest one because mass
     * tracks local radius, so the head is where the body genuinely is
     * front-heavy. Deriving it from velocity instead -- an earlier `heading()`,
     * the argmax of (position - centroid) . velocity -- returned solver noise
     * whenever the creature was at rest, so the eye and tail fin the renderer
     * anchors to them leapt between masses from frame to frame.
     */
    this.nose = specimen.nose;
    this.tailIndex = (specimen.nose + Math.floor(specimen.points / 2)) % specimen.points;
    this.mass = new Float64Array(specimen.points);
    this.x = new Float64Array(specimen.points);
    this.y = new Float64Array(specimen.points);
    this.vx = new Float64Array(specimen.points);
    this.vy = new Float64Array(specimen.points);
    this.points = specimen.points;
    // Constraint topology and rest lengths are filled by `buildStructure`, once
    // the masses have positions to measure.
    this.perimeter = new Int32Array(specimen.points * 2);
    this.restPerimeter = new Float64Array(specimen.points);
    this.structural = new Int32Array(specimen.points * 2);
    this.restStructural = new Float64Array(specimen.points);
    this.bend = new Int32Array(specimen.points * 2);
    this.restBend = new Float64Array(specimen.points);
    this.thickness = specimen.thickness;
    this.impulse = 0.0;
    this.wakeEvents = 0;
    this.wakeStrength = 0.0;
  }

  centroid() {
    let sumX = 0.0;
    let sumY = 0.0;
    let total = 0.0;
    for (let i = 0; i < this.points; i += 1) {
      sumX += this.x[i] * this.mass[i];
      sumY += this.y[i] * this.mass[i];
      total += this.mass[i];
    }
    return { x: sumX / total, y: sumY / total };
  }

  speed() {
    let sumX = 0.0;
    let sumY = 0.0;
    let total = 0.0;
    for (let i = 0; i < this.points; i += 1) {
      sumX += this.vx[i] * this.mass[i];
      sumY += this.vy[i] * this.mass[i];
      total += this.mass[i];
    }
    return Math.hypot(sumX / total, sumY / total);
  }

  velocity() {
    let sumX = 0.0;
    let sumY = 0.0;
    let total = 0.0;
    for (let i = 0; i < this.points; i += 1) {
      sumX += this.vx[i] * this.mass[i];
      sumY += this.vy[i] * this.mass[i];
      total += this.mass[i];
    }
    return { vx: sumX / total, vy: sumY / total };
  }

  area() {
    let sum = 0.0;
    for (let i = 0; i < this.points; i += 1) {
      const j = (i + 1) % this.points;
      sum += this.x[i] * this.y[j] - this.x[j] * this.y[i];
    }
    return Math.abs(sum) * 0.5;
  }

  /*
   * Fraction of the body below the free surface, in [0, 1].
   *
   * Deliberately the same quantity the buoyancy term uses, so a creature cannot
   * be simultaneously "airborne" and "immersed": an earlier revision averaged
   * the depth of only the wetted masses, which scored a barely-damp belly as
   * 0.16 and a fully sunken body above 1.0, making every depth threshold mean
   * something different depending on which helper asked.
   */
  immersion() {
    let wet = 0;
    for (let i = 0; i < this.points; i += 1) {
      if (this.y[i] > this.field.sample(this.x[i])) {
        wet += 1;
      }
    }
    return wet / this.points;
  }

  radius() {
    return Math.sqrt(this.area() / Math.PI);
  }

  /* Depth of the lowest point of the body; the floor contact test needs this. */
  lowestDepth() {
    let lowest = -Infinity;
    for (let i = 0; i < this.points; i += 1) {
      if (this.y[i] > lowest) {
        lowest = this.y[i];
      }
    }
    return lowest;
  }

  perimeterRest(k) {
    return this.restPerimeter[k];
  }

  structuralScale(k) {
    return this.restStructural[k];
  }

  bendRest(k) {
    return this.restBend[k];
  }

}

/*
 * Generate a specimen from a seed: a closed loop whose radius is modulated by a
 * few harmonics (a bulged forebody, a tapered tail), then tuned to a
 * pentatonic-ish scale so its chord sequence always sounds consonant.
 */
function makeSpecimen(seed) {
  const rng = makeRng(seed);
  const species = SPECIES[Math.floor(rng() * SPECIES.length) % SPECIES.length];
  const n = WORLD.segments;
  const bulgePhase = rng() * Math.PI * 2;
  const tailPhase = rng() * Math.PI * 2;
  const harmonics = [
    { order: 1, amp: species.bulge * (0.7 + rng() * 0.6), phase: bulgePhase },
    { order: 2, amp: 0.16 * (0.5 + rng() * 1.0), phase: tailPhase },
    { order: 3, amp: 0.08 * rng(), phase: rng() * Math.PI * 2 }
  ];

  const base = new Float64Array(n);
  let sum = 0.0;
  for (let i = 0; i < n; i += 1) {
    const theta = (2.0 * Math.PI * i) / n;
    let radius = 1.0;
    for (const harmonic of harmonics) {
      radius += harmonic.amp * Math.cos(harmonic.order * theta + harmonic.phase);
    }
    base[i] = Math.max(0.34, radius);
    sum += base[i];
  }
  const mean = sum / n;
  for (let i = 0; i < n; i += 1) {
    base[i] /= mean;
  }

  const scale = 0.30 + rng() * 0.18;
  const hue = Math.floor(rng() * 360);
  // Radius of the outline at each mass. The rest lengths of every spring are
  // derived from the loop this actually produces (see `buildCreature`), so this
  // is the only place the silhouette is defined.
  const memory = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    memory[i] = scale * base[i] * 0.5;
  }

  // Thickest point of the outline; the renderer puts the eyes here and the tail
  // sits diametrically opposite. See the comment on `Creature.nose`.
  let nose = 0;
  for (let i = 1; i < n; i += 1) {
    if (base[i] > base[nose]) {
      nose = i;
    }
  }

  const chords = species.chords;
  return {
    name: species.name,
    scaleName: species.scale,
    points: n,
    scale,
    hue,
    nose,
    chords,
    thickness: scale * (0.42 + species.tail * 0.1),
    memory
  };
}

/*
 * Build the initial loop resting on its neutral buoyancy depth, with the
 * per-species point masses: mass tracks local thickness, so a bulged forebody
 * is heavier and the thing naturally pitches nose-down when it slows. That is
 * the whole reason these creatures feel like animals and not like blobs.
 */
/*
 * Connect the loop and set every rest length by measuring the positions that
 * were just built.
 *
 * Deriving rest lengths analytically (the previous approach) required the formula
 * to agree with the placement code, and it did not: the body was assembled at
 * 4.08x-compressed perimeter spacing and 2.04x-compressed chord spacing, so it
 * started inside a huge internal fight. The equilibrium shape was then decided
 * by that mismatch rather than by the specimen generator, and creatures rendered
 * as taut braced squares instead of rounded animals.
 */
function buildStructure(creature) {
  const n = creature.points;
  const skip = WORLD.structuralRatio;
  for (let i = 0; i < n; i += 1) {
    const next = (i + 1) % n;
    const far = (i + skip) % n;
    const bend = (i + 2) % n;

    creature.perimeter[2 * i] = i;
    creature.perimeter[2 * i + 1] = next;
    creature.restPerimeter[i] = Math.hypot(
      creature.x[next] - creature.x[i],
      creature.y[next] - creature.y[i]
    );

    creature.structural[2 * i] = i;
    creature.structural[2 * i + 1] = far;
    creature.restStructural[i] = Math.hypot(
      creature.x[far] - creature.x[i],
      creature.y[far] - creature.y[i]
    );

    creature.bend[2 * i] = i;
    creature.bend[2 * i + 1] = bend;
    creature.restBend[i] = Math.hypot(
      creature.x[bend] - creature.x[i],
      creature.y[bend] - creature.y[i]
    );
  }
}

function buildCreature(seed, field) {
  const specimen = makeSpecimen(seed);
  const creature = new Creature(specimen, field);
  const n = specimen.points;
  /*
   * Spawned well under water: the body is buoyant, so it rises to its trim depth
   * and the first seconds of the session show it surfacing.
   */
  const centreY = WORLD.spawnDepth;
  for (let i = 0; i < n; i += 1) {
    const angle = (2.0 * Math.PI * i) / n;
    const radius = specimen.memory[i];
    creature.x[i] = Math.cos(angle) * radius;
    creature.y[i] = centreY + Math.sin(angle) * radius * WORLD.spawnSquash;
    creature.vx[i] = 0.0;
    creature.vy[i] = 0.0;
    const thickness = 0.6 + 0.8 * (radius / specimen.scale);
    creature.mass[i] = 0.02 * thickness;
  }
  buildStructure(creature);
  return creature;
}

/*
 * Fluid velocity in the creature's frame.
 *
 * The water is at rest: forward motion comes from the pointer pushing against
 * this fluid, and the sense of speed comes from the camera scrolling past the
 * parallax layers. A background current here would act as a permanent force --
 * drag against it never vanishes, so the creature could never settle, which is
 * exactly the limit cycle an earlier revision shipped with.
 *
 * Two small real effects remain:
 *  - `orbital`: wave orbital motion, which reverses direction over a wavelength
 *    and so averages out rather than accumulating;
 *  - `slam`: an added-mass-like reaction while plunging into the surface.
 */
function fluidVelocity(x, y, vy, time, field) {
  const depth = clamp(y, 0.0, WORLD.depth);
  const surfaceSlope = field.slope(x);
  const orbital = -0.11 * surfaceSlope * (1.0 - smoothstep(0.0, 0.22, depth));
  const nearSurface = 1.0 - smoothstep(0.0, 0.08, depth);
  const slam = vy > 0.0 ? -vy * 0.55 * nearSurface : 0.0;
  return {
    u: orbital,
    v: slam
  };
}

/*
 * Semi-implicit Euler with a fixed substep and per-mass velocity/step clamps.
 * Stability here matters more than physical fidelity: the clamps turn a
 * would-be explosion into a visibly squirming creature.
 */
function integrate(world, dt) {
  const creature = world.creature;
  const field = world.field;
  const pointer = world.pointer;
  const time = world.time;

  /*
   * Submerged fraction drives the waterplane restoring force. Archimedes for a
   * floating body: the net vertical force is proportional to the extra volume
   * under the waterline, so the whole body feels one restoring acceleration
   * toward the surface, shared out over its mass. Without this the buoyancy
   * term has no counterweight and the creature is shot out of the water.
   */
  const liftFraction = creature.immersion();
  const buoyancy = WORLD.gravity / WORLD.floatTrim;

  for (let i = 0; i < creature.points; i += 1) {
    const x = creature.x[i];
    const y = creature.y[i];
    let vx = creature.vx[i];
    let vy = creature.vy[i];
    const mass = creature.mass[i];
    const surface = field.sample(x);
    const submerged = y > surface;

    let fx = 0.0;
    /*
     * Weight acts everywhere; buoyancy is the wetted fraction of the full
     * displacement force, shared over the body as a body force so a partly
     * submerged loop still accelerates as one object.
     */
    let fy = (WORLD.gravity - liftFraction * buoyancy) * mass;

    if (submerged) {
      const depth = clamp(y, 0.0, WORLD.depth);
      const relativeX = vx - fluidVelocity(x, y, vy, time, field).u;
      const relativeY = vy - fluidVelocity(x, y, vy, time, field).v;
      const speed = Math.hypot(relativeX, relativeY);
      const density = 1.0 - 0.35 * smoothstep(0.0, 0.1, depth);
      const drag =
        WORLD.dragLinear + WORLD.dragQuad * speed * density;
      fx -= drag * relativeX * mass;
      fy -= drag * relativeY * mass;

      /*
       * Meniscus drag: breaking or re-entering the surface costs energy, so this
       * opposes vertical velocity within a thin band under the waterline.
       *
       * Deliberately velocity-based. The previous version was position-based and
       * sat inside the submerged branch, where `penetration` is always positive,
       * so `Math.sign(penetration)` was a constant +1 and the term could only
       * ever push up -- a second, surface-local buoyancy that stranded creatures
       * bone dry on top of the waterline (reproduced by seed 23 in 45 s idle).
       */
      const penetration = y - surface;
      const meniscus = 6.0 * Math.exp(-penetration / 0.02);
      fy -= meniscus * vy * mass;
    }

    if (world.selfDrive > 0.0) {
      const heading = world.driveHeading;
      const forwardX = Math.cos(heading);
      const forwardY = Math.sin(heading);
      /*
       * A wave travelling from head to tail. Applied perpendicular to travel it
       * makes the body undulate; forward thrust is added along the heading. Both
       * scale with mass so the whole body accelerates as one object.
       */
      const along = i / creature.points;
      const wave = Math.sin(
        WORLD.selfWaveCycles * Math.PI * 2 * along - world.time * WORLD.selfWaveHz * Math.PI * 2
      );
      const drive = world.selfDrive;
      fx += (forwardX * WORLD.selfThrust - forwardY * wave * WORLD.selfWaveForce) * mass * drive;
      fy +=
        (forwardY * WORLD.selfThrust + forwardX * wave * WORLD.selfWaveForce + world.driveVertical) *
        mass *
        drive;
    }

    if (pointer.active) {
      const dx = pointer.x - x;
      const dy = pointer.y - y;
      const distanceSq = dx * dx + dy * dy;
      const radius = pointer.radius;
      if (distanceSq < radius * radius) {
        const distance = Math.sqrt(distanceSq) + 1e-6;
        // Linear falloff: squared left ~1.5 acceleration at one body-radius,
        // less than the 12.9 buoyancy it must overcome, so a creature resting
        // near the floor could not be pulled anywhere and the floor was
        // effectively decorative.
        const falloff = 1.0 - distance / radius;
        const strength = pointer.pressure * WORLD.pointerForce * falloff;
        // `dx`/`dy` point from the mass toward the cursor, so a positive
        // coefficient pulls and a negative one pushes.
        const coefficient = pointer.attract ? 1.0 : -1.0;
        fx += coefficient * (dx / distance) * strength * mass;
        fy += coefficient * (dy / distance) * strength * mass;
      }
    }

    /* Floor: stiff contact with friction, never penetrates. */
    if (y > WORLD.depth - 0.012) {
      const overlap = y - (WORLD.depth - 0.012);
      fy -= 320.0 * overlap * mass;
      fy -= 14.0 * vy * mass;
      fx -= 9.0 * vx * mass * smoothstep(0.0, 0.02, overlap);
    }

    vx += (dt * fx) / mass;
    vy += (dt * fy) / mass;

    const speedNow = Math.hypot(vx, vy);
    if (speedNow > WORLD.maxSpeed) {
      const shrink = WORLD.maxSpeed / speedNow;
      vx *= shrink;
      vy *= shrink;
    }
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      vx = 0.0;
      vy = 0.0;
    }
    creature.vx[i] = vx;
    creature.vy[i] = vy;
  }
}

function solvePair(creature, indexA, indexB, rest, stiffness, dt2) {
  const dx = creature.x[indexB] - creature.x[indexA];
  const dy = creature.y[indexB] - creature.y[indexA];
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-9) {
    return 0.0;
  }
  const error = distance - rest;
  const impulsive = stiffness * dt2;
  const wa = 1.0 / creature.mass[indexA];
  const wb = 1.0 / creature.mass[indexB];
  const scale = (impulsive * error) / (wa + wb);
  const nx = dx / distance;
  const ny = dy / distance;
  creature.x[indexA] += nx * scale * wa;
  creature.y[indexA] += ny * scale * wa;
  creature.x[indexB] -= nx * scale * wb;
  creature.y[indexB] -= ny * scale * wb;
  return Math.abs(error) / (rest + 1e-9);
}

/*
 * Soft area preservation, applied as a uniform radial correction about the
 * centroid.
 *
 * The obvious formulation pushes each mass along the local outline normal, but
 * that normal flips sign wherever the loop goes concave, which is exactly what
 * happens when the body is squeezed against the floor: the correction then
 * oscillates instead of inflating, and the creature stays collapsed (reproduced
 * by seed 145, which reached 23% of its rest area and never recovered). For a
 * loop that is at worst mildly concave, moving every mass radially changes the
 * enclosed area monotonically, so a single signed correction always inflates or
 * deflates as intended.
 */
function preserveArea(creature, targetArea, dt) {
  const area = creature.area();
  if (area <= 0.0) {
    return;
  }
  const centre = creature.centroid();
  const ratio = targetArea / Math.max(area, 1e-9);
  // Area scales with the square of a uniform radial scale, so the displacement
  // factor is the square root of the area ratio.
  const desiredScale = Math.sqrt(ratio);
  // Clamp so a violent pinch cannot pop the body open in one substep.
  const scale = 1.0 + clamp(desiredScale - 1.0, -0.06, 0.06) * clamp(24.0 * dt, 0.0, 1.0);
  if (scale === 1.0) {
    return;
  }
  for (let i = 0; i < creature.points; i += 1) {
    creature.x[i] = centre.x + (creature.x[i] - centre.x) * scale;
    creature.y[i] = centre.y + (creature.y[i] - centre.y) * scale;
  }
}

function applyConstraints(creature, dt, targetArea) {
  const dt2 = dt * dt;
  let worst = 0.0;
  const structuralCount = creature.structural.length / 2;
  for (let k = 0; k < structuralCount; k += 1) {
    const a = creature.structural[2 * k];
    const b = creature.structural[2 * k + 1];
    worst = Math.max(worst, solvePair(creature, a, b, creature.structuralScale(k), WORLD.structuralK, dt2));
  }
  const count = creature.perimeter.length / 2;
  for (let k = 0; k < count; k += 1) {
    const a = creature.perimeter[2 * k];
    const b = creature.perimeter[2 * k + 1];
    worst = Math.max(worst, solvePair(creature, a, b, creature.perimeterRest(k), WORLD.springK, dt2));
  }
  const bendCount = creature.bend.length / 2;
  for (let k = 0; k < bendCount; k += 1) {
    const a = creature.bend[2 * k];
    const b = creature.bend[2 * k + 1];
    worst = Math.max(worst, solvePair(creature, a, b, creature.bendRest(k), WORLD.bendK, dt2));
  }
  preserveArea(creature, targetArea, dt);
  /* Hard floor: constraints must not be able to shove a mass underground. */
  for (let i = 0; i < creature.points; i += 1) {
    if (creature.y[i] > WORLD.depth) {
      creature.y[i] = WORLD.depth;
      if (creature.vy[i] > 0.0) {
        creature.vy[i] = 0.0;
      }
    }
    if (creature.y[i] < -0.6) {
      creature.y[i] = -0.6;
      if (creature.vy[i] < 0.0) {
        creature.vy[i] = 0.0;
      }
    }
  }
  return worst;
}

/*
 * Convert the positions just integrated into velocities (position-based
 * dynamics style). This is what makes the stiff constraints stable: constraint
 * corrections feed back into momentum instead of fighting it.
 */
function commitVelocities(creature, previousX, previousY, dt) {
  for (let i = 0; i < creature.points; i += 1) {
    const dx = creature.x[i] - previousX[i];
    const dy = creature.y[i] - previousY[i];
    const step = Math.hypot(dx, dy);
    if (step > WORLD.maxStep) {
      const shrink = WORLD.maxStep / step;
      creature.vx[i] = (dx * shrink) / dt;
      creature.vy[i] = (dy * shrink) / dt;
    } else {
      creature.vx[i] = dx / dt;
      creature.vy[i] = dy / dt;
    }
    if (!Number.isFinite(creature.vx[i])) {
      creature.vx[i] = 0.0;
    }
    if (!Number.isFinite(creature.vy[i])) {
      creature.vy[i] = 0.0;
    }
  }
}

function dampTangential(creature) {
  /* Slimes are sticky: shear between neighbouring masses bleeds away. */
  const n = creature.points;
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const dvx = creature.vx[j] - creature.vx[i];
    const dvy = creature.vy[j] - creature.vy[i];
    const damping = 0.06;
    creature.vx[i] += dvx * damping;
    creature.vy[i] += dvy * damping;
    creature.vx[j] -= dvx * damping;
    creature.vy[j] -= dvy * damping;
  }
}

/*
 * One substep. Wetting events -- a mass crossing the free surface -- are the
 * only source of ripples, so the wake is caused by the creature rather than
 * painted under it.
 */
/*
 * Update the idle "intent" of the creature. Called every substep so the heading
 * turns smoothly at any frame rate, and so the ramp to/from self-propulsion is
 * continuous -- a sudden onset would look like the creature being kicked.
 */
function updateSelfDrive(world, dt) {
  if (world.pointer.active) {
    world.idleSeconds = 0.0;
  } else {
    world.idleSeconds += dt;
  }
  const target = smoothstep(WORLD.idleDelay, WORLD.idleDelay + WORLD.idleRamp, world.idleSeconds);
  world.selfDrive = lerp(world.selfDrive, target, clamp(4.0 * dt, 0.0, 1.0));

  // Two incommensurate sines: quasi-periodic, so the path never visibly loops,
  // and deterministic, so a seed replays identically.
  const phases = world.wanderPhases;
  const time = world.time;
  world.driveHeading =
    Math.sin(0.13 * time + phases[0]) * 0.9 +
    Math.sin(0.047 * time + phases[1]) * 0.6 +
    Math.sin(0.011 * time + phases[2]) * 0.35;

  /*
   * Vertical steering is a single body-wide acceleration based on the centroid,
   * never a per-mass pull toward the surface: pulling each mass independently
   * would flatten the body into a pancake.
   *
   * Hunger moves the target, nothing else. A hungry creature steers toward the
   * nearest mote -- in heading, and by aiming the same depth controller at the
   * mote instead of at the surface -- so the drive that already exists acquires
   * a purpose rather than gaining a second force law. `foodBlend` ramps the
   * switch so the creature eases onto a course instead of snapping to it, and
   * it holds the last target between searches so the aim does not jitter.
   */
  const centre = world.creature.centroid();
  let targetY = 0.0;
  let wanted = 0.0;
  if (world.foodEnabled && world.hunger > FOOD.biasThreshold) {
    const mote = nearestMote(world, centre.x, centre.y, FOOD.searchRadius);
    if (mote !== null) {
      world.foodTarget = mote;
    }
  } else {
    world.foodTarget = null;
  }
  if (world.foodTarget !== null) {
    wanted = FOOD.steerGain *
      smoothstep(FOOD.biasThreshold, 1.0, world.hunger) *
      (1.0 - smoothstep(FOOD.searchRadius * 0.45, FOOD.searchRadius, Math.hypot(
        world.foodTarget.x - centre.x, world.foodTarget.y - centre.y
      )));
  }
  world.foodBlend = lerp(world.foodBlend, wanted, clamp(1.5 * dt, 0.0, 1.0));
  if (world.foodBlend > 0.01 && world.foodTarget !== null) {
    const desired = Math.atan2(world.foodTarget.y - centre.y, world.foodTarget.x - centre.x);
    world.driveHeading = lerpAngle(world.driveHeading, desired, world.foodBlend);
    targetY = world.foodTarget.y * world.foodBlend;
  }
  const hunt = world.foodBlend;
  const depthGain = lerp(WORLD.selfDepthGain, FOOD.huntDepthGain, hunt);
  // Cancels the upward excess buoyancy of a submerged body, so a committed dive
  // can actually commit. Zero whenever the creature is not hunting, which is
  // what keeps the surface trim untouched by any of this.
  const excessBuoyancy = WORLD.gravity / WORLD.floatTrim - WORLD.gravity;
  world.driveVertical = clamp(
    (targetY - centre.y) * depthGain + hunt * FOOD.diveThrust * excessBuoyancy,
    -FOOD.authority,
    FOOD.authority
  );
}

function stepCreature(world, dt) {
  const creature = world.creature;
  const field = world.field;
  updateSelfDrive(world, dt);
  const n = creature.points;
  const previousX = world.scratchX;
  const previousY = world.scratchY;

  for (let i = 0; i < n; i += 1) {
    previousX[i] = creature.x[i];
    previousY[i] = creature.y[i];
  }

  integrate(world, dt);
  for (let i = 0; i < n; i += 1) {
    creature.x[i] += dt * creature.vx[i];
    creature.y[i] += dt * creature.vy[i];
  }

  const targetArea = creature.restArea;
  let worst = 0.0;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    worst = applyConstraints(creature, dt, targetArea);
  }
  dampTangential(creature);
  commitVelocities(creature, previousX, previousY, dt);

  let strongest = 0.0;
  for (let i = 0; i < n; i += 1) {
    const previous = previousY[i];
    const current = creature.y[i];
    const surface = field.sample(creature.x[i]);
    const wasWet = previous > surface;
    const isWet = current > surface;
    if (wasWet === isWet) {
      continue;
    }
    const normalSpeed = Math.abs(current - previous) / dt;
    if (normalSpeed < WORLD.wakeMinSpeed) {
      continue;
    }
    const amp = clamp(WORLD.wakeGain * normalSpeed * WORLD.wakeMass, 0.0, 0.5);
    field.inject(creature.x[i], isWet ? amp : -amp, WORLD.wakeSigma);
    world.metrics.wakeEvents += 1;
    creature.wakeEvents += 1;
    strongest = Math.max(strongest, normalSpeed);
    if (world.pendingWetting.length < 8) {
      world.pendingWetting.push({
        x: creature.x[i],
        amp,
        speed: normalSpeed,
        submersion: isWet,
        index: i
      });
    }
  }
  creature.wakeStrength = lerp(creature.wakeStrength, strongest, 0.2);
  creature.strain = worst;
}

/*
 * A creature plus its fluid. Owns no rendering and no audio: it exposes state
 * and a `step(dtSeconds)`, and records events for the audio and HUD layers.
 */
class World {
  constructor(options) {
    /*
     * The plankton layer is what gives the creature a reason to leave its trim.
     * It is on by default and off only where that is the point: the Archimedes
     * invariant below, that a floating body settles at `floatTrim`, cannot be
     * measured on a creature that has somewhere it would rather be.
     */
    this.foodEnabled = options.food !== false;
    /*
     * Three things belong to the trench or to the session rather than to a
     * specimen, so the constructor owns them and `reset` deliberately leaves
     * them alone: the strata are a fixed backdrop, the pointer is input state,
     * and `metrics` are session totals that outlive any one animal.
     */
    this.strata = buildStrata();
    this.pointer = {
      x: 0.0,
      y: 0.5,
      pressure: 0.0,
      // Wide enough that a cursor at the floor still reaches a creature
      // floating at the surface; the squared falloff keeps it local in effect.
      radius: 1.35,
      active: false,
      attract: false
    };
    this.ripplesPlayed = 0;
    this.metrics = {
      steps: 0,
      wakeEvents: 0,
      distance: 0.0,
      maxSpeed: 0.0,
      maxDepth: 0.0,
      airTime: 0.0,
      submergedTime: 0.0,
      skimTime: 0.0,
      glideTime: 0.0,
      breachCount: 0,
      bounceCount: 0,
      fedCount: 0,
      diveHunts: 0,
      solverStrain: 0.0
    };
    this.phenomena = {
      skim: false,
      breach: false,
      skitter: false,
      glide: false,
      dive: false,
      bounce: false
    };
    /* Everything else is a specimen's own state, established by `reset` -- the
     * one place it is written, so a reroll cannot drift from a first boot. */
    this.reset(options.seed >>> 0);
  }

  /*
   * The public way for a painter to ask what is in a slice of the trench. The
   * renderer imports no physics, only this: it never has to know that a mote's
   * position comes from a hash of its cell.
   */
  forEachMote(minX, maxX, visit) {
    if (!this.foodEnabled) {
      return;
    }
    forEachMote(this, minX, maxX, visit);
  }

  setPointer(state) {
    if (state.x !== undefined) {
      this.pointer.x = state.x;
    }
    if (state.y !== undefined) {
      this.pointer.y = clamp(state.y, -0.2, WORLD.depth + 0.2);
    }
    if (state.pressure !== undefined) {
      this.pointer.pressure = clamp(state.pressure, 0.0, 1.0);
    }
    if (state.active !== undefined) {
      this.pointer.active = state.active;
    }
    if (state.attract !== undefined) {
      this.pointer.attract = state.attract;
    }
  }

  /* Emitted for the audio layer: loud, low thuds on wetting events only. */
  collectRipples() {
    const out = [];
    for (const event of this.pendingWetting) {
      out.push(event);
    }
    this.pendingWetting.length = 0;
    return out;
  }

  step(dtSeconds) {
    const substep = WORLD.dt;
    const substeps = clamp(Math.round(dtSeconds / substep), 1, WORLD.substeps);
    this.pendingWetting = [];
    for (let step = 0; step < substeps; step += 1) {
      stepCreature(this, substep);
      this.field.advance(substep);
      this.time += substep;
      this.metrics.steps += 1;
      this.observe(substep);
    }
    if (this.foodEnabled) {
      this.hunger = clamp(this.hunger + FOOD.hungerRate * dtSeconds, 0.0, 1.0);
      graze(this);
      for (let i = this.feedPops.length - 1; i >= 0; i -= 1) {
        this.feedPops[i].age += dtSeconds;
        if (this.feedPops[i].age > 0.7) {
          this.feedPops.splice(i, 1);
        }
      }
    }
    this.consumeWetting();
    this.field.advance(Math.max(0.0, dtSeconds - substeps * substep));
  }

  /*
   * Collapse one frame's crossings into a single thud and hand it to the audio
   * layer, which reads `audibleRipples` (each entry carries an `age` so a note
   * is never retriggered).
   */
  consumeWetting() {
    if (this.pendingWetting.length === 0) {
      return;
    }
    let loudest = this.pendingWetting[0];
    let sum = 0.0;
    for (const event of this.pendingWetting) {
      if (event.amp > loudest.amp) {
        loudest = event;
      }
      sum += event.amp;
    }
    this.audibleRipples.push({
      x: loudest.x,
      amp: Math.min(0.6, sum),
      speed: loudest.speed,
      submersion: loudest.submersion,
      age: 0.0
    });
    if (this.audibleRipples.length > 16) {
      this.audibleRipples.shift();
    }
  }

  /*
   * Phenomenon detection, with explicit hysteresis so a single noisy sample
   * cannot flicker a badge, and dwell timers so "glide" means sustained glide.
   */
  observe(dt) {
    const creature = this.creature;
    const centre = creature.centroid();
    const velocity = creature.velocity();
    const speed = Math.hypot(velocity.vx, velocity.vy);
    const surface = this.field.sample(centre.x);
    const depth = clamp(centre.y, 0.0, WORLD.depth);
    const immersion = creature.immersion();

    this.metrics.distance = Math.max(
      this.metrics.distance,
      centre.x - (this.originX === undefined ? centre.x : this.originX)
    );
    this.metrics.maxSpeed = Math.max(this.metrics.maxSpeed, speed);
    this.metrics.maxDepth = Math.max(this.metrics.maxDepth, depth);

    /*
     * Straightness: how much of the recent travel was in one direction, from
     * the ratio of distance covered to path length. Unlike differencing
     * `atan2` of the velocity, this is well defined when the body is nearly
     * still -- an angle sampled from a ~0 velocity vector is solver noise, and
     * feeding that noise into a turn rate pinned straightness near zero.
     */
    const travelledX = centre.x - this.previousCentre.x;
    const travelledY = centre.y - this.previousCentre.y;
    const stepDistance = Math.hypot(travelledX, travelledY);
    const straightComponent = stepDistance > 1e-9
      ? (travelledX * velocity.vx + travelledY * velocity.vy) / (stepDistance * (speed + 1e-9))
      : 0.0;
    const straightSample = clamp(straightComponent, 0.0, 1.0);
    this.straightness = lerp(this.straightness, straightSample, clamp(6.0 * dt, 0.0, 1.0));
    void this.lastHeadingAngle;

    if (depth < PHENOMENA.dive.depth) {
      this.metrics.submergedTime += dt * immersion;
    }
    if (centre.y <= surface) {
      this.metrics.airTime += dt;
    }

    /* Airborne only when the whole body has left the water. */
    const airborne = immersion <= 0.0;
    this.settle('skim', !airborne && immersion < PHENOMENA.skim.depth, dt, 0.12, 0.35);

    const skittering =
      immersion < PHENOMENA.skitter.depth && speed > PHENOMENA.skitter.speed;
    this.settle('skitter', skittering, dt, 0.1, 0.3);

    const gliding =
      speed > PHENOMENA.glide.speed &&
      this.straightness > PHENOMENA.glide.straightness &&
      depth < PHENOMENA.glide.depth &&
      !airborne;
    this.settle('glide', gliding, dt, 0.5, 0.4);
    if (this.phenomena.glide) {
      this.metrics.glideTime += dt;
    }

    const diving = immersion > PHENOMENA.dive.depth;
    this.settle('dive', diving, dt, 0.2, 0.5);

    const breaching = airborne && speed > PHENOMENA.breach.speed;
    if (breaching && !this.phenomena.breach) {
      this.metrics.breachCount += 1;
      this.emit({ kind: 'breach', x: centre.x, y: centre.y, strength: speed });
    }
    this.settle('breach', breaching, dt, 0.05, 0.25);

    // Contact is detected on the lowest mass, not the centroid: the body has
    // finite radius, so the centroid can never approach the floor closer than
    // its own height and a centroid-based test never fired.
    const bounced =
      creature.lowestDepth() > WORLD.depth - 0.03 &&
      velocity.vy < -PHENOMENA.bounce.impulse;
    if (bounced && !this.phenomena.bounce) {
      this.metrics.bounceCount += 1;
      this.emit({ kind: 'bounce', x: centre.x, y: WORLD.depth, strength: -velocity.vy });
    }
    this.settle('bounce', bounced, dt, 0.02, 0.2);

    if (this.metrics.solverStrain < creature.strain) {
      this.metrics.solverStrain = creature.strain;
    }
    this.previousCentre = centre;

    for (let i = this.audibleRipples.length - 1; i >= 0; i -= 1) {
      const ripple = this.audibleRipples[i];
      ripple.age = (ripple.age || 0.0) + dt;
      if (ripple.age > 2.0) {
        this.audibleRipples.splice(i, 1);
      }
    }
  }

  /*
   * Hysteresis for one phenomenon. `timer` runs into [+enterDwell, -exitDwell]
   * and the phenomenon is on only at the positive end, so a single noisy frame
   * cannot flicker a badge and a real state change needs sustained evidence.
   */
  settle(key, isOn, dt, enterDwell, exitDwell) {
    let current = this.dwellStates[key];
    if (current === undefined) {
      current = { on: false, timer: 0.0 };
      this.dwellStates[key] = current;
    }
    if (isOn) {
      current.timer = Math.min(current.timer + dt, enterDwell);
    } else {
      current.timer = Math.max(current.timer - dt * 2.0, -exitDwell);
    }
    const should = current.timer >= enterDwell;
    if (should !== current.on) {
      current.on = should;
      this.phenomena[key] = should;
      if (should) {
        this.emit({ kind: key, x: this.creature.centroid().x, strength: 1.0 });
      }
    }
    if (key === 'skim' && current.on) {
      this.metrics.skimTime += dt;
    }
  }

  emit(event) {
    this.events.push(event);
    if (this.events.length > 32) {
      this.events.shift();
    }
  }

  /* Camera follows with a velocity lead so you can see where you are going. */
  followCamera(dt) {
    const centre = this.creature.centroid();
    const velocity = this.creature.velocity();
    const target = centre.x + velocity.vx * 0.22;
    this.cameraX = lerp(this.cameraX, target, clamp(3.2 * dt, 0.0, 1.0));
    if (!Number.isFinite(this.cameraX)) {
      this.cameraX = centre.x;
    }
  }

  /*
   * Resurface after a pathological state (a deep pinch, a fling off the top of
   * the world). Deliberately rare; the clamps in `integrate` do the real work.
   */
  health() {
    const area = this.creature.area();
    const centroid = this.creature.centroid();
    const problems = [];
    if (!Number.isFinite(centroid.x) || !Number.isFinite(centroid.y)) {
      problems.push('nan-position');
    }
    if (area < WORLD.minVolume) {
      problems.push('collapsed');
    }
    if (Math.abs(centroid.y) > 4.0) {
      problems.push('escaped');
    }
    return { ok: problems.length === 0, problems, area, centroid };
  }

  /*
   * Establish a specimen from its seed. The constructor and a reroll share this
   * path because `?seed=` is the share format: replaying a seed has to
   * reproduce the animal exactly, and what decides how it moves is not only the
   * body. The wander phases come from the seed, and `idleSeconds`, `selfDrive`
   * and `straightness` decide whether it starts coasting or thrashing, so they
   * belong to the specimen and not to the session; leaking one hands the next
   * creature the previous animal's momentum and personality.
   * `tests/sim.test.mjs` compares a reset replay with a first boot so that
   * cannot come back.
   *
   * Time restarts too -- the plankton bob, the standing waves and the wander are
   * all functions of it -- which is also what lets the browser check pin one
   * frame and hold it against a golden image.
   */
  reset(seed) {
    if (seed !== undefined) {
      this.seed = seed >>> 0;
    }
    this.time = 0.0;
    this.field = new SurfaceField(WORLD);
    this.creature = buildCreature(this.seed, this.field);
    this.creature.restArea = Math.max(this.creature.area(), WORLD.minVolume);
    this.scratchX = new Float64Array(this.creature.points);
    this.scratchY = new Float64Array(this.creature.points);
    this.originX = this.creature.centroid().x;
    this.cameraX = this.originX;
    this.pendingWetting = [];
    this.audibleRipples = [];
    this.rippleBudgetTime = 0.0;
    this.events = [];
    this.foodBand = foodBand(this.seed);
    this.foodEaten = new Map();
    this.foodTarget = null;
    this.foodBlend = 0.0;
    this.feedPops = [];
    this.hunger = FOOD.startHunger;
    const wander = makeRng((this.seed ^ 0x5bf03635) >>> 0);
    this.wanderPhases = [wander() * Math.PI * 2, wander() * Math.PI * 2, wander() * Math.PI * 2];
    this.idleSeconds = 0.0;
    this.selfDrive = 0.0;
    this.driveHeading = 0.0;
    this.driveVertical = 0.0;
    this.lastHeadingAngle = 0.0;
    this.straightness = 1.0;
    this.previousCentre = this.creature.centroid();
    for (const key of Object.keys(this.phenomena)) {
      this.phenomena[key] = false;
    }
    // Dwell timers carry hysteresis; leaving them behind would let a phenomenon
    // re-latch instantly from a stale timer instead of requiring fresh evidence.
    this.dwellStates = {};
  }
}

/* Note names for the procedural soundtrack, pentatonic by default. */
const SCALES = {
  major: [0, 2, 4, 7, 9],
  minor: [0, 3, 5, 7, 10]
};

function noteFrequency(rootHz, scaleName, degree) {
  const scale = SCALES[scaleName] || SCALES.major;
  const length = scale.length;
  const octave = Math.floor(degree / length);
  const index = ((degree % length) + length) % length;
  return rootHz * Math.pow(2, (scale[index] + 12 * octave) / 12.0);
}

/*
 * Additive wavetable, built once. A harmonic stack with a rolled-off tail is
 * cheap to sample and, unlike a raw oscillator, its timbre carries information
 * about how hard the surface was struck.
 */
function buildWavetable(partials) {
  const table = new Float32Array(2048);
  for (let i = 0; i < table.length; i += 1) {
    const phase = (2.0 * Math.PI * i) / table.length;
    let sum = 0.0;
    let norm = 0.0;
    for (let k = 1; k <= partials; k += 1) {
      const weight = 1.0 / (k * Math.sqrt(k));
      sum += weight * Math.sin(k * phase);
      norm += weight;
    }
    table[i] = sum / norm;
  }
  return table;
}

function sampleWavetable(table, phase) {
  const length = table.length;
  let position = phase * length;
  position -= Math.floor(position / length) * length;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = table[index % length];
  const b = table[(index + 1) % length];
  return a + (b - a) * fraction;
}

const FluxPond = {
  WORLD,
  FOOD,
  LAYERS,
  PHENOMENA,
  SPECIES,
  SCALES,
  World,
  SurfaceField,
  makeRng,
  makeSpecimen,
  buildCreature,
  foodBand,
  forEachMote,
  nearestMote,
  layerAt,
  buildStrata,
  clamp,
  lerp,
  smoothstep,
  noteFrequency,
  buildWavetable,
  sampleWavetable,
  fluidVelocity
};

/*
 * One ES module export. The browser loads this file with `type="module"`; Node
 * imports it the same way (a CommonJS `require` of an ES module throws, so a
 * dual export would have to go here rather than be probed at runtime).
 */
export {
  WORLD,
  FOOD,
  LAYERS,
  PHENOMENA,
  SPECIES,
  SCALES,
  World,
  SurfaceField,
  makeRng,
  makeSpecimen,
  buildCreature,
  foodBand,
  forEachMote,
  nearestMote,
  layerAt,
  clamp,
  lerp,
  smoothstep,
  noteFrequency,
  buildWavetable,
  sampleWavetable,
  fluidVelocity
};

export default FluxPond;
