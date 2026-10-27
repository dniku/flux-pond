/*
 * Renderer tests using a recording canvas.
 *
 * No raster backend exists in this environment (jsdom throws on `getContext`
 * without the `canvas` package), so instead of comparing pixels we assert on the
 * 2D calls the renderer makes. This catches the failure modes that actually
 * break a browser at runtime: NaN coordinates, out-of-range gradient radii or
 * colour components, unbalanced save/restore, and nothing being drawn at all.
 */
import FluxPond from '../src/flux-pond.js';
import { Camera, creatureGeometry, render } from '../src/render.js';

const { World } = FluxPond;

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

function makeRecorder(width, height) {
  const calls = [];
  const gradients = [];
  const PATH_METHODS = [
    'clearRect', 'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'quadraticCurveTo', 'bezierCurveTo', 'stroke', 'fill', 'arc', 'arcTo', 'ellipse',
    'rect', 'translate', 'scale', 'rotate', 'clip', 'drawImage', 'setTransform',
    'fillRect', 'strokeRect', 'strokeText', 'fillText'
  ];

  function record(name) {
    return (...args) => {
      calls.push({ name, args });
      for (const arg of args) {
        if (typeof arg === 'number' && !Number.isFinite(arg)) {
          throw new Error(`${name}() received non-finite argument: ${JSON.stringify(args)}`);
        }
      }
      if (name === 'createLinearGradient' || name === 'createRadialGradient') {
        if (name === 'createRadialGradient' && (args[2] < 0 || args[5] < 0)) {
          throw new Error(`radial gradient with negative radius: ${JSON.stringify(args)}`);
        }
        const gradient = { stops: [], addColorStop(offset, colour) {
          if (!(offset >= 0 && offset <= 1)) {
            throw new Error(`addColorStop offset out of range: ${offset}`);
          }
          if (/NaN|undefined/.test(String(colour))) {
            throw new Error(`bad colour string: ${colour}`);
          }
          this.stops.push([offset, colour]);
          calls.push({ name: 'addColorStop', args: [offset, colour] });
        } };
        gradients.push(gradient);
        return gradient;
      }
      if (name === 'arc' && args[2] < 0) {
        throw new Error(`arc with negative radius: ${JSON.stringify(args)}`);
      }
      if (name === 'fillRect' && (args[2] < 0 || args[3] < 0)) {
        throw new Error(`fillRect with negative size: ${JSON.stringify(args)}`);
      }
    };
  }

  const context = {
    canvas: { width, height },
    ...Object.fromEntries(PATH_METHODS.map((name) => [name, record(name)])),
    createLinearGradient: record('createLinearGradient'),
    createRadialGradient: record('createRadialGradient'),
    set fillStyle(value) {
      calls.push({ name: 'fillStyle', args: [value] });
      if (typeof value === 'string' && /NaN|undefined/.test(value)) {
        throw new Error(`fillStyle is not a valid colour: ${value}`);
      }
    },
    set strokeStyle(value) {
      calls.push({ name: 'strokeStyle', args: [value] });
      if (typeof value === 'string' && /NaN|undefined/.test(value)) {
        throw new Error(`strokeStyle is not a valid colour: ${value}`);
      }
    },
    set lineWidth(value) {
      calls.push({ name: 'lineWidth', args: [value] });
      if (!(value > 0)) {
        throw new Error(`lineWidth must be positive, got ${value}`);
      }
    }
  };
  return { context, calls, gradients };
}

function namesOf(calls) {
  return calls.map((call) => call.name);
}

test('renders a settled creature without non-finite draw arguments', () => {
  const world = new World({ seed: 42 });
  for (let i = 0; i < 300; i += 1) {
    world.step(1 / 60);
    world.followCamera(1 / 60);
  }
  const { context, calls } = makeRecorder(900, 600);
  render(context, world, new Camera(900, 600), world.time);
  assert(calls.length > 50, `suspiciously few draw calls: ${calls.length}`);
  assert(namesOf(calls).includes('fill'), 'nothing was filled');
  assert(namesOf(calls).includes('stroke'), 'nothing was stroked');
});

test('save/restore are balanced', () => {
  const world = new World({ seed: 8 });
  const { context, calls } = makeRecorder(640, 480);
  for (let frame = 0; frame < 30; frame += 1) {
    render(context, world, new Camera(640, 480), frame / 60);
    world.step(1 / 60);
  }
  const saves = calls.filter((call) => call.name === 'save').length;
  const restores = calls.filter((call) => call.name === 'restore').length;
  assert(saves === restores, `unbalanced canvas state: ${saves} saves vs ${restores} restores`);
  assert(saves > 0, 'renderer never isolated its state');
});

test('renders every creature from a wide seed range without throwing', () => {
  for (let seed = 0; seed < 120; seed += 1) {
    const world = new World({ seed });
    for (let i = 0; i < 40; i += 1) {
      world.step(1 / 60);
      world.followCamera(1 / 60);
    }
    const { context } = makeRecorder(800, 500);
    render(context, world, new Camera(800, 500), world.time);
  }
});

test('handles degenerate viewport sizes', () => {
  const world = new World({ seed: 4 });
  world.step(1 / 60);
  for (const [width, height] of [[1, 1], [320, 240], [1, 900], [900, 1]]) {
    const { context } = makeRecorder(width, height);
    render(context, world, new Camera(width, height), 0.5);
  }
});

test('renders with the pointer active in both modes', () => {
  const world = new World({ seed: 11 });
  world.step(1 / 60);
  for (const attract of [false, true]) {
    world.setPointer({ x: 0.4, y: 0.3, pressure: 1.0, active: true, attract });
    const { calls, context } = makeRecorder(700, 500);
    render(context, world, new Camera(700, 500), 1.0);
    const arcs = calls.filter((call) => call.name === 'arc');
    assert(arcs.length > 0, 'cursor produced no arcs');
  }
});

test('camera round-trips screen space and world space', () => {
  // The pointer handler maps client pixels into world coordinates with
  // worldX(screenX(...)); if that inverse were wrong the cursor force would be
  // applied somewhere other than under the cursor.
  const camera = new Camera(800, 600);
  camera.x = 3.0;
  for (const worldX of [2.0, 2.9, 3.0, 3.7, 11.25]) {
    const screen = camera.screenX(worldX);
    assert(Number.isFinite(screen), `screenX(${worldX}) = ${screen}`);
    assertCloseTo(camera.worldX(screen), worldX, 1e-9, `worldX(screenX(${worldX}))`);
  }
  for (const worldY of [-0.3, 0.0, 0.5, 1.0]) {
    const screen = camera.screenY(worldY);
    assertCloseTo(camera.worldY(screen), worldY, 1e-9, `worldY(screenY(${worldY}))`);
  }
  // The camera tracks the subject: at camera.x, the subject sits mid-screen.
  assertCloseTo(camera.screenX(3.0), 400, 1e-9, 'subject should be centred');
  // Depth increases downward on screen, and the surface is above the floor.
  assert(camera.screenY(0.0) < camera.screenY(1.0), 'screen y must increase with depth');
  // A world point to the right must land to the right on screen.
  assert(camera.screenX(3.5) > camera.screenX(2.5), 'x orientation flipped');
});


test('creature geometry is finite at every viewport size', () => {
  for (const seed of [1, 23, 145, 20261027]) {
    const world = new World({ seed });
    for (let i = 0; i < 120; i += 1) {
      world.step(1 / 60);
      world.followCamera(1 / 60);
      const geometry = creatureGeometry(world.creature, new Camera(1024, 640));
      for (const point of [...geometry.outline, ...geometry.core, ...geometry.fin]) {
        assert(Number.isFinite(point.x) && Number.isFinite(point.y), 'non-finite geometry point');
      }
      assert(Number.isFinite(geometry.eye.r) && geometry.eye.r > 0, 'eye radius not positive');
    }
  }
});

test('the eye is visible: sized from the projected body, not the world radius', () => {
  // Regression: the eye used to be `creature.radius() * 12` -- a world radius
  // (0..1 strip) used as a pixel size -- which put a 2.6 px dot on a 100 px
  // body, so the creature read as a blob with specks on it.
  for (const height of [480, 640, 1200]) {
    const camera = new Camera(1024, height);
    const world = new World({ seed: 20261027 });
    for (let i = 0; i < 180; i += 1) {
      world.step(1 / 60);
    }
    const geometry = creatureGeometry(world.creature, camera);
    const ratio = geometry.eye.r / geometry.radius;
    assert(ratio > 0.08 && ratio < 0.3, `eye/body radius ratio ${ratio} at height ${height}`);
    assert(geometry.eye.r >= 4, `eye is only ${geometry.eye.r} px at height ${height}`);
  }
});

test('the tail fin is attached to the body and points backwards', () => {
  const world = new World({ seed: 7 });
  for (let i = 0; i < 120; i += 1) {
    world.step(1 / 60);
  }
  const camera = new Camera(900, 600);
  const geometry = creatureGeometry(world.creature, camera);
  const [baseA, tipUp, notch, tipDown, baseB] = geometry.fin;
  // The fin base is a pair of real outline masses, which is what makes it swing
  // with the body instead of being drawn independently of it.
  const samePoint = (a, b) => Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  assert(geometry.outline.some((p) => samePoint(p, baseA)), 'fin base is not on the outline');
  assert(geometry.outline.some((p) => samePoint(p, baseB)), 'fin base is not on the outline');
  // Both lobes and the notch lie further from the centroid than the base does,
  // i.e. the fin sticks out behind the body rather than across it.
  const distance = (p) => Math.hypot(p.x - geometry.centre.x, p.y - geometry.centre.y);
  const base = (distance(baseA) + distance(baseB)) / 2;
  for (const point of [tipUp, notch, tipDown]) {
    assert(distance(point) > base, 'fin lobe does not extend behind the body');
  }
  // And it is smaller than the body, so a creature cannot grow a sail.
  assert(distance(tipUp) < geometry.radius * 2.2, 'fin is larger than the body');
});

test('the tail fin is a simple polygon, not a self-intersecting one', () => {
  // The canvas fills self-intersections with the even-odd rule, so a fin whose
  // outer edges cross renders as two thin needles. Asserting simplicity is the
  // only way to catch that without a raster: nothing else about the draw calls
  // looks wrong.
  const intersects = (p1, q1, p2, q2) => {
    const side = (a, b, p) => Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    return side(p1, q1, p2) !== side(p1, q1, q2) && side(p2, q2, p1) !== side(p2, q2, q1);
  };
  for (let seed = 0; seed < 60; seed += 1) {
    const world = new World({ seed });
    for (let frame = 0; frame < 12; frame += 1) {
      const fin = creatureGeometry(world.creature, new Camera(800, 600)).fin;
      for (let i = 0; i < fin.length; i += 1) {
        for (let j = i + 1; j < fin.length; j += 1) {
          // Skip edges that share a vertex.
          if (j === i + 1 || (i === 0 && j === fin.length - 1)) {
            continue;
          }
          const a = fin[i];
          const b = fin[(i + 1) % fin.length];
          const c = fin[j];
          const e = fin[(j + 1) % fin.length];
          assert(
            !intersects(a, b, c, e),
            `seed ${seed}: fin edges ${i} and ${j} cross (${JSON.stringify([a, b, c, e])})`
          );
        }
      }
    }
    for (let i = 0; i < 60; i += 1) {
      world.step(1 / 60);
    }
  }
});

test('the eye sits at the head, not the tail', () => {
  for (const seed of [4, 5, 6, 145, 20261027]) {
    const world = new World({ seed });
    for (let i = 0; i < 150; i += 1) {
      world.step(1 / 60);
    }
    const geometry = creatureGeometry(world.creature, new Camera(900, 600));
    const nose = geometry.outline[world.creature.nose];
    const tail = geometry.outline[world.creature.tailIndex];
    const to = (p) => Math.hypot(p.x - geometry.eye.x, p.y - geometry.eye.y);
    assert(to(nose) < to(tail), `eye is nearer the tail than the nose (seed ${seed})`);
  }
});

function assertCloseTo(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`);
}

process.stdout.write(JSON.stringify({ passed, failed: failures.length }) + '\n');
for (const failure of failures) {
  process.stdout.write(`\nFAIL: ${failure.name}\n  ${failure.message}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
