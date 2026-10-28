/*
 * Boots the real page in jsdom.
 *
 * No Chromium is available in this environment, so the closest honest check is
 * to load `index.html` verbatim, attach the same modules the browser would
 * attach, and assert on the DOM outcomes: the app boots, the HUD is populated,
 * input changes the simulation, and the buttons do what they claim.
 *
 * This is the layer that catches wiring mistakes no unit test sees -- a HUD id
 * that does not exist in the HTML, an event that is never attached, a module
 * that fails to import. Canvas painting is stubbed with a recorder (jsdom has
 * no raster backend), so this does not verify that the scene looks right.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadOptional } from '../tools/optional-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const jsdomPackage = loadOptional('jsdom');
if (jsdomPackage === null) {
  process.stdout.write(
    'SKIP app.test: jsdom is not installed and cannot be downloaded here.\n' +
    '  Chromium/jsdom checks are the ones that exercise the page shell; run\n' +
    '  `tools/run-browser-check.sh` or install jsdom to cover this layer.\n'
  );
  process.exit(0);
}
const { JSDOM } = jsdomPackage;

let passed = 0;
const failures = [];
function test(name, fn) {
  return (async () => {
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push({ name, message: error.message });
    }
  })();
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const html = await readFile(path.join(root, 'index.html'), 'utf8');

/* Static cross-check between the shell and the markup. */
test('the app and index.html agree on element ids', async () => {
  const sources = await Promise.all(
    ['src/app.js', 'src/main.js'].map((relative) => readFile(path.join(root, relative), 'utf8'))
  );
  const sourcesText = sources.join('\n');

  // Ids the app reaches for. Match bare '#id' string literals: the HUD helper
  // passes ids as plain arguments, so a querySelector-only regex would miss them.
  const referenced = new Set();
  // 1. Explicit selectors: '#pond', '#phenomena'.
  for (const match of sourcesText.matchAll(/['"]#([A-Za-z][\w-]*)['"]/g)) {
    referenced.add(match[1]);
  }
  // 2. Ids passed to the panel helpers, which build their own selectors:
  //    setText('speed', ..) writes #speed, and setMeter('depth', ..) writes
  //    #depth plus a #depth-fill bar.
  for (const match of sourcesText.matchAll(/setText\(\s*['"]([A-Za-z][\w-]*)['"]/g)) {
    referenced.add(match[1]);
  }
  for (const match of sourcesText.matchAll(/setMeter\(\s*['"]([A-Za-z][\w-]*)['"]/g)) {
    referenced.add(match[1]);
    referenced.add(`${match[1]}-fill`);
  }
  const declared = new Set();
  for (const match of html.matchAll(/\bid="([\w-]+)"/g)) {
    declared.add(match[1]);
  }
  assert(declared.size >= 12, `index.html declares too few ids: ${declared.size}`);

  // A reference to an id that is not in the page means a silently blank read-out
  // or, for a handler, a button that does nothing at all.
  const missing = [...referenced].filter((id) => !declared.has(id));
  assert(missing.length === 0, `ids used by the app but absent from index.html: ${missing.join(', ')}`);

  // The converse catches markup nobody updates. Ids used only as CSS hooks are
  // in use, so selectors in the page's own stylesheet count as references.
  const styled = new Set();
  for (const match of html.matchAll(/#([A-Za-z][\w-]*)/g)) {
    styled.add(match[1]);
  }
  const unused = [...declared].filter((id) => !referenced.has(id) && !styled.has(id));
  assert(unused.length === 0, `index.html declares ids nothing uses: ${unused.join(', ')}`);
});

function makeCanvasContextStub(calls) {
  const gradient = { addColorStop() {} };
  const handler = {
    get(target, property) {
      if (property in target) {
        return target[property];
      }
      return (...args) => {
        calls.push(String(property));
        for (const arg of args) {
          if (typeof arg === 'number' && !Number.isFinite(arg)) {
            throw new Error(`${String(property)}() got non-finite argument`);
          }
        }
        if (String(property).startsWith('create')) {
          return gradient;
        }
        return undefined;
      };
    },
    set() {
      return true;
    }
  };
  const base = {
    canvas: null,
    getImageData: () => ({ data: new Uint8ClampedArray([10, 20, 30, 255]) })
  };
  return new Proxy(base, handler);
}

async function boot() {
  const dom = new JSDOM(html, {
    url: 'http://localhost/?seed=20261027',
    pretendToBeVisual: true
  });
  const { window } = dom;

  const drawCalls = [];
  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    const context = makeCanvasContextStub(drawCalls);
    this.__context = context;
    return context;
  };
  // jsdom reports 0 for layout, which would make the canvas 1x1; pin a size so
  // the renderer exercises real geometry.
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 1024, configurable: true });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 640, configurable: true });
  window.devicePixelRatio = 1;

  // jsdom implements neither PointerEvent nor pointer capture, both of which the
  // shell uses. A MouseEvent carrying the same fields is a faithful stand-in for
  // the code under test, which only reads coordinates, buttons and shiftKey.
  if (window.PointerEvent === undefined) {
    window.PointerEvent = class PointerEvent extends window.MouseEvent {
      constructor(type, parameters = {}) {
        super(type, parameters);
        this.pointerId = parameters.pointerId ?? 1;
      }
    };
  }
  // jsdom performs no layout, so a real getBoundingClientRect is all zeros. The
  // shell legitimately rejects that (see the degenerate-rect guard), so give it
  // the box a browser would report or pointer mapping is never exercised.
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 1024, bottom: 640, width: 1024, height: 640 };
  };
  window.HTMLCanvasElement.prototype.setPointerCapture = function setPointerCapture() {};
  window.HTMLCanvasElement.prototype.releasePointerCapture = function releasePointerCapture() {};

  const audioCalls = {
    enables: 0,
    impacts: 0,
    phenomena: 0,
    depthUpdates: 0,
    retunes: 0,
    lastSpecimen: null,
    presences: []
  };
  class StubAudio {
    constructor() {
      this.enabled = false;
      this.drone = null;
    }
    async enable() {
      audioCalls.enables += 1;
      this.enabled = true;
      return true;
    }
    disable() {
      this.enabled = false;
      return true;
    }
    retune(specimen) {
      audioCalls.retunes += 1;
      audioCalls.lastSpecimen = specimen;
      this.drone = { oscillators: [1] };
      return true;
    }
    updateDepth() {
      audioCalls.depthUpdates += 1;
    }
    updatePresence(nearness) {
      audioCalls.presences.push(nearness);
      return true;
    }
    playImpact() {
      audioCalls.impacts += 1;
      return true;
    }
    playPhenomenon() {
      audioCalls.phenomena += 1;
      return true;
    }
  }

  // Drive the frame loop manually for determinism.
  const frames = [];
  window.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };

  // Publish the jsdom globals the modules expect, then import them for real.
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.history = window.history;
  globalThis.devicePixelRatio = 1;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.AudioContext = function AudioContext() {
    return { state: 'running', currentTime: 0, destination: {}, createGain: () => ({ gain: { value: 0 }, connect() {} }) };
  };
  globalThis.__FLUX_AUDIO_STUB = StubAudio;

  return { dom, window, frames, drawCalls, audioCalls, StubAudio };
}

/*
 * `main.js` constructs a concrete PondAudio; for the boot test we import the
 * shell directly and inject the stub, which is the dependency the shell already
 * accepts. `main.js` itself is exercised separately for its own wiring.
 */
const { PondApp } = await import(path.join(root, 'src', 'app.js'));

async function bootApp() {
  const env = await boot();
  const canvas = env.window.document.querySelector('#pond');
  const audio = new env.StubAudio();
  const app = new PondApp(env.window.document, canvas, { audio, seed: 20261027 });
  app.attach();
  env.window.fluxPond = { app, audio };
  return { ...env, canvas, audio, app };
}

function step(env, count, msPerFrame = 16) {
  let now = env.clockStart ??= 0;
  for (let i = 0; i < count; i += 1) {
    now += msPerFrame;
    const callback = env.frames.shift();
    if (callback === undefined) {
      // The shell re-arms rAF only inside its own loop; drive the frame
      // function directly when it does not.
      env.app.frame(now);
      continue;
    }
    callback(now);
  }
  env.clockStart = now;
}

await test('app constructs and attaches without throwing', async () => {
  const { app } = await bootApp();
  assert(app.canvas.width === 1024, `canvas width ${app.canvas.width}`);
  assert(app.seed === 20261027, `seed ${app.seed}`);
});

await test('a frame renders and populates the HUD', async () => {
  const env = await bootApp();
  step(env, 40);
  assert(env.drawCalls.length > 100, `only ${env.drawCalls.length} draw calls`);
  const document = env.window.document;
  for (const id of ['#fps', '#speed', '#depth', '#wet', '#distance', '#seed', '#species', '#layer']) {
    const text = document.querySelector(id).textContent;
    assert(text !== '' && text !== '\u2014', `${id} was never populated (got "${text}")`);
  }
  assert(
    document.querySelector('#seed').textContent === '20261027',
    `HUD seed is ${document.querySelector('#seed').textContent}`
  );
});

await test('pointer events drive the creature and the wake', async () => {
  const env = await bootApp();
  const before = env.app.world.creature.centroid().x;
  const ripplesBefore = env.app.world.metrics.wakeEvents;
  step(env, 30);
  const canvas = env.canvas;
  for (let i = 0; i < 120; i += 1) {
    const move = new env.window.PointerEvent('pointermove', {
      clientX: 500 + 200 * Math.sin(i / 8),
      clientY: 220 + 40 * Math.cos(i / 6),
      bubbles: true,
      buttons: 1
    });
    canvas.dispatchEvent(move);
    step(env, 1);
  }
  const after = env.app.world.creature.centroid().x;
  const pointer = env.app.world.pointer;
  assert(Number.isFinite(pointer.x) && Number.isFinite(pointer.y), `pointer not finite: ${pointer.x}, ${pointer.y}`);
  assert(pointer.y > 0.0 && pointer.y < 1.0, `pointer y not mapped into the water column: ${pointer.y}`);
  assert(Math.abs(after - before) > 0.02, `creature did not move: ${before} -> ${after}`);
  assert(
    env.app.world.metrics.wakeEvents > ripplesBefore,
    `no wake: ${ripplesBefore} -> ${env.app.world.metrics.wakeEvents}`
  );
});

await test('shift-key pointer pulls rather than pushes', async () => {
  const env = await bootApp();
  const canvas = env.canvas;
  canvas.dispatchEvent(
    new env.window.PointerEvent('pointermove', { clientX: 512, clientY: 600, shiftKey: true, bubbles: true })
  );
  assert(env.app.world.pointer.attract === true, 'shift did not select pull mode');
  canvas.dispatchEvent(new env.window.PointerEvent('pointermove', { clientX: 512, clientY: 600, bubbles: true }));
  assert(env.app.world.pointer.attract === false, 'pull mode stuck on after shift released');
});

/*
 * The hint promises "press to push harder", and the ring on screen is painted
 * from the same number the force is scaled by, so the two have to agree. This
 * used to be a documentation bug: hovering already reached full pressure, which
 * left nothing for pressing to add -- and made every tow a maximum-strength one.
 */
await test('pressing swells the pointer field; hovering alone does not', async () => {
  const env = await bootApp();
  const canvas = env.canvas;
  const at = { clientX: 512, clientY: 300, bubbles: true };
  canvas.dispatchEvent(new env.window.PointerEvent('pointermove', at));
  step(env, 60);
  const hover = env.app.world.pointer.pressure;
  canvas.dispatchEvent(new env.window.PointerEvent('pointerdown', at));
  step(env, 60);
  const pressed = env.app.world.pointer.pressure;
  canvas.dispatchEvent(new env.window.PointerEvent('pointerup', at));
  step(env, 6);
  const released = env.app.world.pointer.pressure;
  assert(hover > 0.3 && hover < 0.8, `hover pressure should sit mid-range, got ${hover}`);
  assert(pressed > hover + 0.2, `pressing did not swell the field: ${hover} -> ${pressed}`);
  assert(released < pressed, `releasing did not let the field subside: ${pressed} -> ${released}`);
});

await test('pause stops the simulation; resume restarts it', async () => {
  const env = await bootApp();
  step(env, 20);
  env.app.running = false;
  const frozen = env.app.world.creature.centroid().x;
  step(env, 20);
  assert(env.app.world.creature.centroid().x === frozen, 'paused simulation advanced');
  env.app.running = true;
  env.app.world.setPointer({ x: frozen + 2, y: 0.2, pressure: 1, active: true });
  step(env, 30);
  assert(env.app.world.creature.centroid().x !== frozen, 'resume did not restart simulation');
});

await test('R generates a different specimen and updates the URL', async () => {
  const env = await bootApp();
  step(env, 5);
  const before = env.app.seed;
  const beforeName = env.window.document.querySelector('#species').textContent;
  env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
  const after = env.app.seed;
  assert(after !== before, `reroll produced the same seed ${after}`);
  assert(
    env.window.location.search.includes(String(after)),
    `URL not updated: ${env.window.location.search}`
  );
  step(env, 5);
  const afterName = env.window.document.querySelector('#species').textContent;
  assert(typeof afterName === 'string' && afterName.length > 0, 'name not rendered');
  assert(beforeName !== afterName || before !== after, 'no identity change on reroll');
});

/*
 * The bed survives a reroll -- an oscillator cannot be restarted -- so the app
 * has to ask the audio layer to move to the new specimen's key. It did not:
 * `startDrone` refuses to build a second bed, so every specimen after the first
 * swam in the previous one's key and every impact note came from its chord too.
 */
await test('a reroll moves the drone to the new specimen key', async () => {
  const env = await bootApp();
  env.canvas.dispatchEvent(new env.window.PointerEvent('pointerdown', { clientX: 300, clientY: 300, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(env.audioCalls.retunes === 1, `expected one bed to be built, got ${env.audioCalls.retunes}`);
  const firstSpecimen = env.audioCalls.lastSpecimen;
  const firstSeed = env.app.seed;

  env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'r', bubbles: true }));
  assert(env.app.seed !== firstSeed, 'reroll did not change the seed');
  assert(env.audioCalls.retunes === 2, `reroll retuned ${env.audioCalls.retunes - 1} times`);
  assert(
    env.audioCalls.lastSpecimen !== firstSpecimen,
    'reroll retuned with the specimen that was already playing'
  );
  assert(
    env.audioCalls.lastSpecimen.name === env.app.specimen.name,
    `retuned for ${env.audioCalls.lastSpecimen.name}, the creature is ${env.app.specimen.name}`
  );
});

await test('space toggles pause via the keyboard', async () => {
  const env = await bootApp();
  const runningBefore = env.app.running;
  env.window.document.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert(env.app.running === !runningBefore, 'space did not toggle pause');
});

await test('audio is only enabled through the gesture path', async () => {
  const env = await bootApp();
  step(env, 10);
  assert(env.audioCalls.enables === 0, 'audio enabled without a gesture');
  env.canvas.dispatchEvent(new env.window.PointerEvent('pointerdown', { clientX: 300, clientY: 300, bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert(env.audioCalls.enables === 1, `enable called ${env.audioCalls.enables} times`);
  assert(env.audioCalls.retunes === 1, `retune called ${env.audioCalls.retunes} times`);
  step(env, 60);
  assert(env.audioCalls.depthUpdates > 0, 'depth never forwarded to audio');
  // The lurker is only audible because the app forwards its nearness every
  // pumped frame; nothing else connects the two, and the value the audio layer
  // expects is a fraction, which is easy to get wrong and silent when wrong.
  assert(env.audioCalls.presences.length > 0, 'presence never forwarded to audio');
  assert(
    env.audioCalls.presences.every((nearness) => Number.isFinite(nearness) && nearness >= 0 && nearness <= 1),
    `presence forwarded a nearness outside 0-1: ${env.audioCalls.presences.slice(0, 4)}`
  );
});

await test('every module the page loads exists on disk', async () => {
  // jsdom never fetches `<script type="module" src=...>`, so a renamed or
  // missing file passes every other test in this file and yields a completely
  // blank page in a real browser. Walk the graph the way the browser would.
  const pageModules = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const queue = pageModules.map((specifier) => ({ from: 'index.html', specifier, base: root }));
  const seen = new Set();
  const missing = [];
  while (queue.length > 0) {
    const { from, specifier, base } = queue.shift();
    const target = path.resolve(base, specifier);
    let source;
    try {
      source = await readFile(target, 'utf8');
    } catch {
      missing.push(`${from} -> ${specifier}`);
      continue;
    }
    if (seen.has(target)) {
      continue;
    }
    seen.add(target);
    for (const match of source.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
      queue.push({ from: path.relative(root, target), specifier: match[1], base: path.dirname(target) });
    }
  }
  assert(missing.length === 0, `unresolvable modules: ${missing.join(', ')}`);
  // The five app modules; fewer means the walk stopped early rather than that
  // the app got smaller.
  assert(seen.size >= 5, `only reached ${seen.size} modules from index.html: ${[...seen].join(', ')}`);
});

/*
 * The README is the front page of this repo and it embeds the golden frames, so
 * a renamed frame is a wall of broken-image icons for everyone who visits. No
 * other test reads the README; this is the whole contract.
 */
await test('every image the README links exists and is a PNG', async () => {
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  const links = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter((target) => !/^https?:/.test(target));
  assert(links.length >= 4, `expected the README to embed the frames, found ${links.length} local image(s)`);
  const broken = [];
  for (const link of links) {
    let bytes;
    try {
      bytes = await readFile(path.resolve(root, link));
    } catch {
      broken.push(`${link} (missing)`);
      continue;
    }
    // 0x89 'PNG' -- so a truncated file, or one replaced by an error page, fails
    // here rather than as a slightly wrong-looking picture.
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
      broken.push(`${link} (not a PNG)`);
    }
  }
  assert(broken.length === 0, `README images broken: ${broken.join(', ')}`);
});

process.stdout.write(JSON.stringify({ passed, failed: failures.length }) + '\n');
for (const failure of failures) {
  process.stdout.write(`\nFAIL: ${failure.name}\n  ${failure.message}\n`);
}
process.exit(failures.length === 0 ? 0 : 1);
