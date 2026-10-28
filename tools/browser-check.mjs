/*
 * End-to-end check of the real page in headless Chromium.
 *
 * This is the only way to verify the parts that only exist in a browser: ES
 * module loading, the render loop actually painting, pointer input driving the
 * creature, and audio graph construction. Static analysis cannot catch "blank
 * canvas" or "module failed to import".
 *
 * The app is served by intercepting requests and answering from disk, so no
 * listening socket is required (the sandbox forbids binding one). Run via
 * `tools/run-browser-check.sh`, which points Playwright at the store's browsers.
 */
// ESM ignores NODE_PATH, so Playwright is resolved from an absolute path when
// the runner supplies one (it lives in a shared node_modules, not here).
const playwrightModule = process.env.PLAYWRIGHT_ENTRY ?? 'playwright';
const playwrightPackage = await import(playwrightModule);
// Playwright's entry is CommonJS, so under ESM interop its exports arrive on
// `default` rather than as named bindings.
const { chromium } = playwrightPackage.chromium
  ? playwrightPackage
  : playwrightPackage.default;
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptional } from './optional-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] ?? path.join(root, '.tmp', 'shots');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json'
};

const ORIGIN = 'https://fluxpond.test';

async function serveFromDisk(rootDir) {
  const table = [];
  for (const relative of ['index.html', 'src/main.js', 'src/app.js', 'src/render.js', 'src/audio.js', 'src/flux-pond.js']) {
    const body = await readFile(path.join(rootDir, relative), 'utf8');
    table.push({ relative, body, type: MIME[path.extname(relative)] ?? 'application/octet-stream' });
  }
  return table;
}

const results = { passed: 0, failed: 0, failures: [] };
function check(name, condition, detail) {
  if (condition) {
    results.passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    results.failed += 1;
    results.failures.push(`${name}: ${detail}`);
    console.log(`  FAIL ${name}: ${detail}`);
  }
}

/*
 * Golden images.
 *
 * Two purposes: to be able to look at what a real browser actually paints, and
 * to fail loudly when a change moves something on screen. This is not
 * hypothetical -- two panels were rendering at the top-left underneath the
 * read-out, which made the buttons unclickable, and every assertion about draw
 * calls was perfectly happy about it.
 *
 * Frames are made deterministic by pausing the clock, resetting the world and
 * advancing a fixed number of fixed steps, so an image depends on the seed
 * alone and not on how long the browser took to paint. Comparison is deliberately
 * tolerant: font antialiasing and GPU differences between hosts are noise, a
 * moved or hidden panel is not.
 *
 * Each frame is chosen to show something the others do not: `idle-5s` the
 * settled surface float, `hunt-40s` a hungry creature working the plankton
 * band, `tow-10s` a held pull to depth -- which is the only one of the three
 * with a phenomenon badge on screen, the panel that a static-layout bug had
 * been hiding behind the read-out.
 *
 *   UPDATE_GOLDEN=1 tools/check.sh --browser   # record current frames
 */
const GOLDEN_DIR = process.env.GOLDEN_DIR ?? path.join(root, 'tests', 'golden');
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';
const png = loadOptional('pngjs');

// Summed |dr|+|dg|+|db| above which a pixel counts as moved, and how much of
// the frame may move before the golden fails. A panel appearing or disappearing
// changes tens of thousands of pixels; text antialiasing changes few, slightly.
// Measured here: two Chromium sessions of one build agree to the pixel on all
// three frames, and a third run moved 0.006 % of one -- the two digits of the fps
// read-out, the only number on screen that describes the machine rather than the
// seed. The last real source of drift was in the renderer, not the test: the
// cursor ring pulsed off `Date.now()`, so one world painted two pictures. The
// budget below is for antialiasing and font rendering on other hosts.
const PIXEL_DELTA_LIMIT = 30;
const DIFF_PIXEL_FRACTION = 0.03;
const MEAN_DELTA_LIMIT = 1.5;

const GOLDEN_FRAMES = [
  { name: 'idle-5s', seconds: 5.0, pull: false },
  { name: 'hunt-40s', seconds: 40.0, pull: false },
  { name: 'tow-10s', seconds: 10.0, pull: true },
  // The lurker is drawn from published state only, so it needs a frame of its
  // own: the other three catch a silhouette in the distance at most.
  { name: 'lurker-2s', seconds: 2.0, pull: true, press: true }
];

async function captureStableFrame(page, frame) {
  const readout = await page.evaluate(({ steps, pull, press }) => {
    const app = window.fluxPond.app;
    app.running = false;
    app.world.reset(app.seed);
    app.elapsed = 0.0;
    /*
     * `pull` holds the pointer at the floor a short way ahead of the creature.
     * The influence field is anchored in world space and the camera chases the
     * creature, so it is re-aimed every step -- exactly as a hand would have to
     * track it. `pointerInside` is what the pressure ramp in `app.step` keys on,
     * and the button stays up: this is the hover-strength tow, which is what a
     * cursor resting in the window does. (Pressed, the field reaches 1.0 and the
     * differential across the body stretches it hard -- strain ~2.8 against
     * ~2.0 here, measured over 10 s.)
     */
    app.pointerInside = pull;
    app.pressing = press === true;
    for (let i = 0; i < steps; i += 1) {
      if (pull) {
        const centre = app.world.creature.centroid();
        app.world.setPointer({ x: centre.x + 0.15, y: 1.0, attract: true, active: true });
      }
      app.step(1 / 120);
    }
    // The read-out has to describe the frame that is about to be painted. It
    // otherwise only refreshes on the 500 ms fps window, which runs on wall
    // time: two captures made inside one window showed identical numbers for
    // two worlds that differed by 6.5% of their pixels.
    app.updatePanel();
    const values = ['depth', 'wet', 'hunger', 'fed', 'layer'].map(
      (id) => `${id}=${document.querySelector(`#${id}`).textContent}`
    );
    const badges = [...document.querySelectorAll('#phenomena .badge')]
      .map((badge) => badge.textContent)
      .join('+');
    return `${values.join(' ')} badges=${badges === '' ? 'none' : badges}`;
  }, { steps: Math.round(frame.seconds * 120), pull: frame.pull, press: frame.press === true });
  // One paint after the state is set, so the screenshot is that state.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  const buffer = await page.screenshot({ path: path.join(OUT, `${frame.name}.png`) });
  return { readout, buffer };
}

function compareWithGolden(name, buffer) {
  if (png === null) {
    console.log(`  SKIP golden ${name}: pngjs is unavailable, cannot decode`);
    return;
  }
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const goldenPath = path.join(GOLDEN_DIR, `${name}.png`);
  if (UPDATE_GOLDEN || !existsSync(goldenPath)) {
    writeFileSync(goldenPath, buffer);
    console.log(`  wrote golden ${name} -> ${path.relative(root, goldenPath)}`);
    return;
  }
  const actual = png.PNG.sync.read(buffer);
  const golden = png.PNG.sync.read(readFileSync(goldenPath));
  if (actual.width !== golden.width || actual.height !== golden.height) {
    check(`golden ${name}`, false, `${actual.width}x${actual.height} != golden ${golden.width}x${golden.height}`);
    return;
  }
  const total = actual.width * actual.height;
  let moved = 0;
  let sum = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    const delta =
      Math.abs(actual.data[o] - golden.data[o]) +
      Math.abs(actual.data[o + 1] - golden.data[o + 1]) +
      Math.abs(actual.data[o + 2] - golden.data[o + 2]);
    sum += delta;
    if (delta > PIXEL_DELTA_LIMIT) {
      moved += 1;
    }
  }
  const fraction = moved / total;
  const mean = sum / (3 * total);
  // Report the margin even when it passes: a golden that quietly drifts up to
  // its threshold is as useful as one that fails.
  console.log(
    `  golden ${name}: ${(fraction * 100).toFixed(3)}% of pixels moved, mean delta ${mean.toFixed(3)}` +
      ` (limits ${DIFF_PIXEL_FRACTION * 100}% and ${MEAN_DELTA_LIMIT})`
  );
  check(
    `golden ${name} matches`,
    fraction <= DIFF_PIXEL_FRACTION && mean <= MEAN_DELTA_LIMIT,
    `${(fraction * 100).toFixed(2)}% of pixels moved (limit ${DIFF_PIXEL_FRACTION * 100}%), mean delta ${mean.toFixed(2)}`
  );
}

async function main() {
  const table = await serveFromDisk(root);
  // The installed Playwright pins a browser revision this host does not have,
  // so point it at whatever Chromium the runner found and skip that lookup.
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader']
  });
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    const wanted = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    const match = table.find((entry) => entry.relative === wanted);
    if (match === undefined) {
      route.fulfill({ status: 404, body: 'not found' });
      return;
    }
    route.fulfill({ status: 200, contentType: match.type, body: match.body });
  });

  console.log('--- loading ---');
  await page.goto(`${ORIGIN}/?seed=20261027`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.fluxPond !== undefined, { timeout: 10000 });

  check('app boots (window.fluxPond present)', true, '');
  check('no page errors during load', pageErrors.length === 0, pageErrors.join(' | '));
  check('no console errors during load', consoleErrors.length === 0, consoleErrors.join(' | '));

  // The canvas must actually contain the scene, not a blank rectangle. Sampling
  // real pixels is what distinguishes "code ran" from "something is visible".
  const sampled = await page.evaluate(() => {
    const canvas = document.querySelector('#pond');
    const ctx = canvas.getContext('2d');
    const probe = (x, y) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    };
    const distinct = new Set();
    let sum = 0;
    for (let x = 0; x < canvas.width; x += 23) {
      for (let y = 0; y < canvas.height; y += 17) {
        const p = probe(x, y);
        distinct.add(p.join(','));
        sum += p[0] + p[1] + p[2];
      }
    }
    return {
      width: canvas.width,
      height: canvas.height,
      distinctColours: distinct.size,
      meanLuma: sum / (Math.ceil(canvas.width / 23) * Math.ceil(canvas.height / 17))
    };
  });
  console.log(`  canvas ${sampled.width}x${sampled.height}, ${sampled.distinctColours} distinct colours, mean luma ${sampled.meanLuma.toFixed(1)}`);
  check('canvas is not blank', sampled.distinctColours > 10, `only ${sampled.distinctColours} distinct colours`);
  check('canvas is not black', sampled.meanLuma > 4, `mean luma ${sampled.meanLuma}`);

  // `fps` is an average over a 500 ms window, so wait for that window to
  // close rather than reading 0 a handful of frames after boot.
  let fpsAfterBoot = 0;
  try {
    await page.waitForFunction(() => window.fluxPond.app.fps > 5, null, { timeout: 5000 });
    fpsAfterBoot = await page.evaluate(() => window.fluxPond.app.fps);
  } catch {
    fpsAfterBoot = await page.evaluate(() => window.fluxPond.app.fps);
  }
  check('render loop is running', fpsAfterBoot > 5, `fps ${fpsAfterBoot}`);

  console.log('--- golden frames ---');
  for (const frame of GOLDEN_FRAMES) {
    const { readout, buffer } = await captureStableFrame(page, frame);
    console.log(`  ${frame.name}: ${readout}`);
    compareWithGolden(frame.name, buffer);
  }
  await page.evaluate(() => {
    // Back to a fresh world: the golden frames ran 45 s of simulation, and the
    // checks below assume a creature that has barely started.
    const app = window.fluxPond.app;
    app.pointerInside = false;
    // A golden recorded under a press would otherwise leave the button down for
    // every live check that follows.
    app.pressing = false;
    app.world.setPointer({ active: false, attract: false, pressure: 0.0 });
    app.world.reset(app.seed);
    app.elapsed = 0.0;
    app.running = true;
    // Drop any badge a golden left on screen before the live checks begin.
    app.updatePanel();
  });

  // Drive it: the pointer must move the creature, and the HUD must follow.
  const before = await page.evaluate(() => ({
    x: window.fluxPond.app.world.creature.centroid().x,
    wet: window.fluxPond.app.world.creature.immersion(),
    ripples: window.fluxPond.app.world.metrics.wakeEvents
  }));
  const box = await page.locator('#pond').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await page.mouse.down();
  let maxShift = 0.0;
  for (let i = 0; i < 40; i += 1) {
    const t = i / 40;
    await page.mouse.move(
      box.x + box.width * (0.3 + 0.4 * Math.sin(t * Math.PI * 2)),
      box.y + box.height * (0.3 + 0.12 * Math.cos(t * Math.PI * 2))
    );
    await page.waitForTimeout(16);
    const x = await page.evaluate(() => window.fluxPond.app.world.creature.centroid().x);
    maxShift = Math.max(maxShift, Math.abs(x - before.x));
  }
  await page.mouse.up();

  const after = await page.evaluate(() => ({
    x: window.fluxPond.app.world.creature.centroid().x,
    ripples: window.fluxPond.app.world.metrics.wakeEvents,
    hudSpeed: document.querySelector('#speed').textContent,
    hudRipples: document.querySelector('#ripples').textContent,
    badges: document.querySelectorAll('#phenomena .badge').length
  }));
  // The drag traces a closed loop, so where the creature ends up is not the
  // point -- a symmetric wiggle has no reason to leave net displacement. What
  // has to hold is that the pointer moved it, measurably, while it was held.
  // (Self-propulsion is suppressed while the pointer is active, so this is the
  // pointer's doing.)
  check(
    'pointer input moves the creature',
    maxShift > 0.05,
    `largest shift while driven ${maxShift.toFixed(3)} (centroid ${before.x.toFixed(3)} -> ${after.x.toFixed(3)})`
  );
  check(
    'driving generates wake events',
    after.ripples > before.ripples,
    `${before.ripples} -> ${after.ripples}`
  );
  check('HUD updates live', after.hudRipples !== '0', `#ripples reads ${after.hudRipples}`);
  check('HUD speed is populated', after.hudSpeed !== '' && after.hudSpeed !== '0', `#speed reads ${after.hudSpeed}`);
  console.log(`  badges visible while driving: ${after.badges}`);

  const afterGesture = await page.evaluate(() => ({
    enabled: window.fluxPond.audio.enabled,
    hasContext: window.fluxPond.audio.context !== null
  }));
  check(
    'a canvas gesture is what switches audio on',
    afterGesture.enabled === true && afterGesture.hasContext === true,
    JSON.stringify(afterGesture)
  );

  const feeding = await page.evaluate(() => ({
    enabled: window.fluxPond.app.world.foodEnabled,
    hunger: window.fluxPond.app.world.hunger,
    fed: window.fluxPond.app.world.metrics.fedCount,
    hudHunger: document.querySelector('#hunger')?.textContent ?? null,
    hudFed: document.querySelector('#fed')?.textContent ?? null
  }));
  check('plankton layer is live in the browser', feeding.enabled === true, JSON.stringify(feeding));
  check(
    'hunger is a fraction and the read-out shows it',
    feeding.hunger >= 0.0 && feeding.hunger <= 1.0 && /%$/.test(feeding.hudHunger ?? ''),
    JSON.stringify(feeding)
  );
  check('fed counter is rendered', /^[0-9]+$/.test(feeding.hudFed ?? ''), JSON.stringify(feeding));

  await page.screenshot({ path: path.join(OUT, 'driving.png') });

  // Pull mode (shift) is how a dive happens; verify the mode actually flips.
  await page.keyboard.down('Shift');
  const pullX = box.x + box.width * 0.5;
  const pullY = box.y + box.height * 0.92;
  await page.mouse.move(pullX, pullY);
  await page.mouse.down();
  let maxDepth = 0;
  for (let i = 0; i < 150; i += 1) {
    // Re-issue the move: the influence field is anchored in world space, and
    // the camera chases the creature, so a silent pointer drifts out of range.
    await page.mouse.move(pullX + (i % 3), pullY);
    await page.waitForTimeout(16);
    const depth = await page.evaluate(() => window.fluxPond.app.world.creature.centroid().y);
    maxDepth = Math.max(maxDepth, depth);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  check('shift+drag dives the creature', maxDepth > 0.1, `deepest centroid y ${maxDepth.toFixed(3)}`);
  await page.screenshot({ path: path.join(OUT, 'diving.png') });

  // R new specimen: deterministic from seed, so reroll must change identity.
  const nameBefore = await page.evaluate(() => document.querySelector('#species').textContent);
  await page.locator('#reroll').click();
  await page.waitForTimeout(300);
  const afterReroll = await page.evaluate(() => ({
    name: document.querySelector('#species').textContent,
    seed: document.querySelector('#seed').textContent,
    urlSeed: new URL(location.href).searchParams.get('seed')
  }));
  check('new specimen changes the seed', afterReroll.seed !== '20261027', `seed ${afterReroll.seed}`);
  check('seed is written to the URL', afterReroll.urlSeed === afterReroll.seed, `url ${afterReroll.urlSeed} vs hud ${afterReroll.seed}`);
  console.log(`  specimen ${nameBefore} -> ${afterReroll.name}`);

  // Audio: constructing the graph is the risky part in headless.
  const audioState = await page.evaluate(async () => {
    const button = document.querySelector('#audio');
    const before = window.fluxPond.audio.enabled;
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const audio = window.fluxPond.audio;
    return {
      before,
      enabled: audio.enabled,
      hasContext: audio.context !== null,
      state: audio.context ? audio.context.state : 'none',
      droneVoices: audio.drone ? audio.drone.oscillators.length : 0,
      label: button.textContent
    };
  });
  check(
    'audio button toggles the audio state',
    audioState.enabled === !audioState.before,
    JSON.stringify(audioState)
  );
  check(
    'audio button label follows the audio state',
    (audioState.label === 'Audio on') === audioState.enabled,
    JSON.stringify(audioState)
  );
  check('audio graph built', audioState.droneVoices > 0, JSON.stringify(audioState));
  console.log(`  audio state=${audioState.state} voices=${audioState.droneVoices} label="${audioState.label}"`);

  // Pause must stop simulation without stopping the renderer.
  const pauseState = await page.evaluate(async () => {
    const app = window.fluxPond.app;
    document.querySelector('#pause').click();
    const x = app.world.creature.centroid().x;
    const fpsBefore = app.frameCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { frozen: Math.abs(app.world.creature.centroid().x - x) < 1e-12, paused: !app.running, fpsBefore };
  });
  check('pause freezes the simulation', pauseState.frozen, JSON.stringify(pauseState));

  const finalErrors = [...consoleErrors, ...pageErrors];
  check('no errors across the whole session', finalErrors.length === 0, finalErrors.slice(0, 4).join(' | '));

  await page.screenshot({ path: path.join(OUT, 'final.png') });
  await browser.close();

  console.log(`\n${JSON.stringify({ passed: results.passed, failed: results.failed })}`);
  process.exit(results.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('browser check crashed:', error);
  process.exit(2);
});
