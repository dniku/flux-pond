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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
      return [d[0], d[1], d[2], d[4]];
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

  const fpsAfterBoot = await page.evaluate(() => window.fluxPond.app.fps);
  check('render loop is running', fpsAfterBoot > 5, `fps ${fpsAfterBoot}`);

  // Drive it: the pointer must move the creature, and the HUD must follow.
  const before = await page.evaluate(() => ({
    x: window.fluxPond.app.world.creature.centroid().x,
    wet: window.fluxPond.app.world.creature.immersion(),
    ripples: window.fluxPond.app.world.metrics.wakeEvents
  }));
  const box = await page.locator('#pond').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await page.mouse.down();
  for (let i = 0; i < 40; i += 1) {
    const t = i / 40;
    await page.mouse.move(
      box.x + box.width * (0.3 + 0.4 * Math.sin(t * Math.PI * 2)),
      box.y + box.height * (0.3 + 0.12 * Math.cos(t * Math.PI * 2))
    );
    await page.waitForTimeout(16);
  }
  await page.mouse.up();

  const after = await page.evaluate(() => ({
    x: window.fluxPond.app.world.creature.centroid().x,
    ripples: window.fluxPond.app.world.metrics.wakeEvents,
    hudSpeed: document.querySelector('#speed').textContent,
    hudRipples: document.querySelector('#ripples').textContent,
    badges: document.querySelectorAll('#phenomena .badge').length
  }));
  check(
    'pointer input moves the creature',
    Math.abs(after.x - before.x) > 0.05,
    `centroid x ${before.x.toFixed(3)} -> ${after.x.toFixed(3)}`
  );
  check(
    'driving generates wake events',
    after.ripples > before.ripples,
    `${before.ripples} -> ${after.ripples}`
  );
  check('HUD updates live', after.hudRipples !== '0', `#ripples reads ${after.hudRipples}`);
  check('HUD speed is populated', after.hudSpeed !== '' && after.hudSpeed !== '0', `#speed reads ${after.hudSpeed}`);
  console.log(`  badges visible while driving: ${after.badges}`);

  await page.screenshot({ path: path.join(OUT, 'driving.png') });

  // Pull mode (shift) is how a dive happens; verify the mode actually flips.
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.9);
  await page.mouse.down();
  let maxDepth = 0;
  for (let i = 0; i < 90; i += 1) {
    await page.waitForTimeout(16);
    const depth = await page.evaluate(() => window.fluxPond.app.world.creature.centroid().y);
    maxDepth = Math.max(maxDepth, depth);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  check('shift+drag dives the creature', maxDepth > 0.1, `deepest centroid y ${maxDepth.toFixed(3)}`);
  await page.screenshot({ path: path.join(OUT, 'diving.png') });

  // R new specimen: deterministic from seed, so reroll must change identity.
  const nameBefore = await page.evaluate(() => document.querySelector('#name').textContent);
  await page.locator('#reroll').click();
  await page.waitForTimeout(300);
  const afterReroll = await page.evaluate(() => ({
    name: document.querySelector('#name').textContent,
    seed: document.querySelector('#seed').textContent,
    urlSeed: new URL(location.href).searchParams.get('seed')
  }));
  check('new specimen changes the seed', afterReroll.seed !== '20261027', `seed ${afterReroll.seed}`);
  check('seed is written to the URL', afterReroll.urlSeed === afterReroll.seed, `url ${afterReroll.urlSeed} vs hud ${afterReroll.seed}`);
  console.log(`  specimen ${nameBefore} -> ${afterReroll.name}`);

  // Audio: constructing the graph is the risky part in headless.
  const audioState = await page.evaluate(async () => {
    const button = document.querySelector('#audio');
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const audio = window.fluxPond.audio;
    return {
      enabled: audio.enabled,
      hasContext: audio.context !== null,
      state: audio.context ? audio.context.state : 'none',
      droneVoices: audio.drone ? audio.drone.oscillators.length : 0,
      label: button.textContent
    };
  });
  check('audio enables on click', audioState.enabled === true, JSON.stringify(audioState));
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
