/*
 * Application shell: frame loop, input, and the read-out panel.
 *
 * Owns no physics state -- the World does that -- so the whole toy can be driven
 * head-less. The audio object is injected because a browser forbids constructing
 * an AudioContext before a user gesture, and because it lets tests pass a spy.
 *
 * The loop is a fixed-timestep accumulator: `World.step` already clamps its own
 * substeps, so a long frame must not become one giant step, and the backlog is
 * capped so returning to a backgrounded tab cannot spiral into catch-up work.
 */

import FluxPond from './flux-pond.js';
import { Camera, render } from './render.js';
import { withFrequencies } from './audio.js';

const { World, makeSpecimen, noteFrequency, layerAt } = FluxPond;

/*
 * Pointer influence, as the ramped `pressure` the World scales its force by.
 * Hovering is deliberately weaker than pressing: the cursor ring is painted from
 * the same number (see `drawCursor`), so the field on screen is the field being
 * applied, and there is a stronger push left over when the button goes down.
 */
const PRESSURE_HOVER = 0.55;
const PRESSURE_PRESS = 1.0;
const PRESSURE_AWAY = 0.45;

const FIXED_STEP = 1 / 120;
const MAX_ACCUMULATOR = 0.25;
const MAX_STEPS_PER_FRAME = 8;

const PHENOMENON_LABELS = {
  skim: 'skimming',
  breach: 'breach',
  skitter: 'skittering',
  glide: 'gliding',
  dive: 'sounding layer',
  bounce: 'floor bounce',
  flee: 'fleeing'
};

/*
 * `?seed=` is the share format: the simulation is deterministic, so a seed
 * reproduces a specimen exactly. Malformed values fall back rather than
 * silently becoming NaN.
 */
function seedFromSearch(search, fallback) {
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0xffffffff) {
    return fallback;
  }
  return parsed;
}

class PondApp {
  constructor(document, canvas, dependencies) {
    this.document = document;
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: false });
    if (this.context === null) {
      throw new Error('This browser cannot provide a 2D canvas context.');
    }
    this.audio = dependencies.audio;
    this.seed = dependencies.seed >>> 0;
    this.world = new World({ seed: this.seed });
    this.specimen = withFrequencies(makeSpecimen(this.seed), noteFrequency);
    this.camera = new Camera(1, 1);
    this.running = true;
    this.accumulator = 0.0;
    this.lastFrameMs = 0.0;
    this.elapsed = 0.0;
    this.frameCount = 0;
    this.fps = 0.0;
    this.fpsFrames = 0;
    this.fpsWindowMs = 0.0;
    this.pressure = 0.0;
    this.pointerInside = false;
    this.pressing = false;
    /*
     * Pull without a modifier key. `Shift` and right-drag are both unreachable
     * on a touch screen, and a phone is a large share of the places this gets
     * opened, so the mode lives on a button as well as on the keyboard.
     */
    this.pullMode = false;
    this.badges = new Map();
    this.processedRipples = new WeakSet();
    this.processedEvents = new WeakSet();
    this.resize();
  }

  attach() {
    const canvas = this.canvas;
    canvas.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvas.addEventListener('pointerdown', (event) => {
      canvas.setPointerCapture?.(event.pointerId);
      this.pressing = true;
      this.onPointerMove(event);
      this.world.setPointer({ active: true });
      // The first touch is the gesture that lets audio start. It is also
      // the first moment we learn whether this browser has Web Audio at all,
      // and a rejection here must not reach the pointer handler that called it.
      this.enableAudio().catch(() => this.toast('No audio in this browser'));
    });
    canvas.addEventListener('pointerup', (event) => {
      canvas.releasePointerCapture?.(event.pointerId);
      // Release lets the field subside through the same ramp rather than
      // snapping to zero, which is what the ramp below is for.
      this.pressing = false;
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointerInside = false;
      this.pressing = false;
      this.world.setPointer({ active: false, pressure: 0.0 });
    });
    // Right-drag is "pull"; the browser menu would otherwise eat the gesture.
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    /*
     * The hint and the extra telemetry are disclosures, and nothing but JS knows
     * whether there is room to leave them open: expanded on a desktop canvas, a
     * single tappable line each on a phone. The query is the CSS phone query
     * turned round -- narrow *or* short, because a phone on its side is 844 wide
     * and 390 tall and is not roomy -- so the stylesheet and this cannot
     * disagree, which they did when only the width was compared.
     *
     * `matchMedia` is absent in jsdom, which is the same answer as "narrow":
     * stay collapsed rather than throw.
     */
    const roomy = this.document.defaultView
      ?.matchMedia?.('(min-width: 721px) and (min-height: 521px)')?.matches === true;
    for (const id of ['hint', 'telemetry']) {
      const disclosure = this.document.querySelector(`#${id}`);
      if (disclosure !== null) {
        disclosure.open = roomy;
      }
    }
    this.syncFullscreen();
    // Escape leaves full screen without asking this code, so the button is
    // re-read from the document rather than tracked in a field of its own.
    this.document.addEventListener('fullscreenchange', () => this.syncFullscreen());
    this.document.addEventListener('keydown', (event) => this.onKey(event));
    if (typeof this.document.defaultView !== 'undefined') {
      this.document.defaultView.addEventListener('resize', () => this.resize());
    }
  }

  async enableAudio() {
    await this.audio.enable();
    // Starts the bed the first time and puts it in this specimen's key after
    // that; the audio module owns whether a bed already exists.
    this.audio.retune(this.specimen);
  }

  /*
   * Cursor position becomes a world-space pressure centre. A collapsed canvas
   * reports a zero box, and dividing by it would map the pointer to Infinity and
   * make the browser throw while building gradients -- so the sample is dropped.
   */
  onPointerMove(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0.0 || rect.height <= 0.0) {
      return;
    }
    const pixelX = ((event.clientX - rect.left) / rect.width) * this.canvas.width;
    const pixelY = ((event.clientY - rect.top) / rect.height) * this.canvas.height;
    const pulling = event.shiftKey === true || event.buttons === 2 || this.pullMode === true;
    this.pointerInside = true;
    this.world.setPointer({
      x: this.camera.worldX(pixelX),
      y: this.camera.worldY(pixelY),
      attract: pulling,
      active: true
    });
  }

  onKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    switch (event.key) {
      case 'r':
      case 'R':
        this.newCreature();
        break;
      case ' ':
        this.togglePause();
        break;
      case 'a':
      case 'A':
        void this.toggleAudio();
        break;
      case 'p':
      case 'P':
        this.togglePull();
        break;
      case 'f':
      case 'F':
        void this.toggleFullscreen();
        break;
      case 'h':
      case 'H': {
        const hint = this.document.querySelector('#hint');
        if (hint !== null) {
          hint.style.display = hint.style.display === 'none' ? '' : 'none';
        }
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  }

  togglePause() {
    this.running = !this.running;
    const button = this.document.querySelector('#pause');
    if (button !== null) {
      button.textContent = this.running ? 'Pause' : 'Resume';
    }
  }

  /*
   * A browser with no Web Audio is allowed to refuse, and the button then says
   * what it always said. The toy swims on either way.
   */
  async toggleAudio() {
    if (this.audio.enabled) {
      this.audio.disable();
    } else {
      try {
        await this.enableAudio();
      } catch {
        this.toast('No audio in this browser');
      }
    }
    const button = this.document.querySelector('#audio');
    if (button !== null) {
      button.textContent = this.audio.enabled ? 'Audio on' : 'Audio off';
    }
  }

  /*
   * Full screen, because on a phone the difference between a preview sheet and
   * the whole glass is most of the toy. The engine can refuse (no gesture, an
   * embedded frame that forbids it) and the API can be absent altogether
   * (Android WebView), so the button states what the document says rather than
   * what was asked for, and hides itself where there is nothing to toggle.
   */
  isFullscreen() {
    const element = this.document.fullscreenElement;
    return element !== null && element !== undefined;
  }

  syncFullscreen() {
    const button = this.document.querySelector('#full');
    if (button === null) {
      return;
    }
    if (typeof this.document.documentElement?.requestFullscreen !== 'function') {
      button.hidden = true;
      return;
    }
    button.setAttribute('aria-pressed', String(this.isFullscreen()));
  }

  async toggleFullscreen() {
    const wasFullscreen = this.isFullscreen();
    const transition = wasFullscreen
      ? this.document.exitFullscreen?.()
      : this.document.documentElement?.requestFullscreen?.();
    if (transition === null || transition === undefined) {
      this.toast('Full screen is not available here');
      return false;
    }
    try {
      await transition;
    } catch {
      this.toast('The browser refused full screen');
    }
    this.syncFullscreen();
    return this.isFullscreen();
  }

  /*
   * Flip the pull mode and let the button say which one is on, the same way the
   * audio button carries its own label.
   */
  togglePull() {
    this.pullMode = !this.pullMode;
    const button = this.document.querySelector('#pull');
    if (button !== null) {
      button.setAttribute('aria-pressed', String(this.pullMode));
    }
    return this.pullMode;
  }

  newCreature() {
    this.seed = Math.floor(Math.random() * 0x100000000) >>> 0;
    this.world.reset(this.seed);
    this.specimen = withFrequencies(makeSpecimen(this.seed), noteFrequency);
    if (this.audio.enabled) {
      this.audio.retune(this.specimen);
    }
    const url = new URL(this.document.location.href);
    url.searchParams.set('seed', String(this.seed));
    try {
      this.document.defaultView?.history.replaceState(null, '', url);
    } catch {
      // A document with no URL of its own -- `file://` in some engines, a
      // srcdoc WebView -- refuses a history write outright. Chromium and a
      // served page take the seed into the URL; those origins keep it in the
      // read-out, which is the same number. WebKit could not be started in this
      // container to find out which side it is on, so the failure is expected
      // here rather than hypothetical.
    }
    this.toast(`${this.specimen.name} \u00b7 seed ${this.seed}`);
    this.updatePanel();
  }

  toast(message) {
    const element = this.document.querySelector('#toast');
    if (element === null) {
      return;
    }
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => element.classList.remove('show'), 1500);
  }

  resize() {
    const ratio = this.document.defaultView?.devicePixelRatio ?? 1;
    const width = Math.max(1, Math.round((this.canvas.clientWidth || 640) * ratio));
    const height = Math.max(1, Math.round((this.canvas.clientHeight || 400) * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.camera = new Camera(width, height);
    this.camera.x = this.world.cameraX;
  }

  /*
   * Pressure ramps instead of snapping, so pressing swells the field and
   * releasing lets it subside; a binary on/off made the creature twitch.
   */
  advancePressure(dt) {
    // Out of the canvas nothing is `active`, so the World applies no pointer
    // force at any pressure; that target only decides how far the ring falls.
    const target = !this.pointerInside
      ? PRESSURE_AWAY
      : (this.pressing ? PRESSURE_PRESS : PRESSURE_HOVER);
    const rate = this.pointerInside ? 5.0 : 2.5;
    this.pressure += (target - this.pressure) * Math.min(1.0, rate * dt);
    this.world.setPointer({ pressure: this.pressure });
  }

  step(dt) {
    this.accumulator = Math.min(this.accumulator + dt, MAX_ACCUMULATOR);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.advancePressure(FIXED_STEP);
      this.world.step(FIXED_STEP);
      this.world.followCamera(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      this.elapsed += FIXED_STEP;
      steps += 1;
    }
    return steps;
  }

  /*
   * Hand new audio events over. Events are tagged rather than removed, so the
   * World keeps a plain log and the audio layer decides what to voice.
   */
  pumpAudio() {
    if (!this.audio.enabled) {
      return;
    }
    const creature = this.world.creature;
    this.audio.updateDepth(creature.immersion(), creature.speed());
    // Presence, not position: the simulation already decided how close the thing
    // in the deep is, and this only turns that into a level.
    this.audio.updatePresence(this.world.lurker.nearness);
    for (const ripple of this.world.audibleRipples) {
      if (ripple.age > 0 && !this.processedRipples.has(ripple)) {
        this.processedRipples.add(ripple);
        this.audio.playImpact({ strength: ripple.speed, waveIndex: Math.round(ripple.x * 3) });
      }
    }
    for (const event of this.world.events) {
      if (!this.processedEvents.has(event)) {
        this.processedEvents.add(event);
        this.audio.playPhenomenon(event.kind);
      }
    }
  }

  frame(nowMs) {
    if (this.lastFrameMs === 0.0) {
      this.lastFrameMs = nowMs;
    }
    const dt = Math.max(0.0, (nowMs - this.lastFrameMs) / 1000.0);
    this.lastFrameMs = nowMs;

    if (this.running) {
      this.step(dt);
      this.pumpAudio();
    }
    render(this.context, this.world, this.camera, this.elapsed);

    this.frameCount += 1;
    this.fpsFrames += 1;
    this.fpsWindowMs += dt * 1000.0;
    if (this.fpsWindowMs >= 500.0) {
      this.fps = (this.fpsFrames * 1000.0) / this.fpsWindowMs;
      this.fpsFrames = 0;
      this.fpsWindowMs = 0.0;
      this.updatePanel();
    }
  }

  setMeter(id, fraction) {
    const element = this.document.querySelector(`#${id}-fill`);
    if (element !== null) {
      const percent = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
      if (element.style.width !== percent) {
        element.style.width = percent;
      }
    }
  }

  setText(id, value) {
    const element = this.document.querySelector(`#${id}`);
    if (element !== null) {
      element.textContent = String(value);
    }
  }

  updatePanel() {
    const creature = this.world.creature;
    const metrics = this.world.metrics;
    const speed = creature.speed();
    const centre = creature.centroid();
    const immersion = creature.immersion();
    const strain = creature.strain || 0.0;

    this.setText('species', this.specimen.name);
    this.setText('seed', this.seed);
    this.setText('speed', speed.toFixed(2));
    this.setText('depth', centre.y.toFixed(2));
    this.setText('wet', `${Math.round(immersion * 100)}%`);
    this.setText('strain', strain.toFixed(2));
    this.setText('hunger', `${Math.round(this.world.hunger * 100)}%`);
    this.setText('fed', metrics.fedCount);
    this.setText('distance', metrics.distance.toFixed(1));
    this.setText('ripples', metrics.wakeEvents);
    this.setText('breaches', metrics.breachCount);
    this.setText('flights', metrics.fleeCount);
    this.setText('fps', this.fps.toFixed(0));

    this.setMeter('speed', speed / 2.5);
    this.setMeter('depth', centre.y);
    this.setMeter('wet', immersion);
    this.setMeter('strain', strain);
    this.setMeter('hunger', this.world.hunger);
    this.setMeter('distance', metrics.distance / 60.0);

    const layer = layerAt(Math.max(0, Math.min(1, centre.y)));
    this.setText('layer', layer.id);

    for (const [key, label] of Object.entries(PHENOMENON_LABELS)) {
      this.setBadge(key, label);
    }
  }

  setBadge(key, label) {
    const container = this.document.querySelector('#phenomena');
    if (container === null) {
      return;
    }
    const on = this.world.phenomena[key] === true;
    const existing = this.badges.get(key);
    if (on && existing === undefined) {
      const badge = this.document.createElement('span');
      badge.className = 'badge';
      badge.textContent = label;
      container.appendChild(badge);
      this.badges.set(key, badge);
    } else if (!on && existing !== undefined) {
      existing.remove();
      this.badges.delete(key);
    }
  }
}

export { PondApp, seedFromSearch, PHENOMENON_LABELS, FIXED_STEP };
