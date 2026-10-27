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
  bounce: 'floor bounce'
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
    this.droneStarted = false;
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
      void this.enableAudio();
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
    this.document.addEventListener('keydown', (event) => this.onKey(event));
    if (typeof this.document.defaultView !== 'undefined') {
      this.document.defaultView.addEventListener('resize', () => this.resize());
    }
  }

  async enableAudio() {
    await this.audio.enable();
    if (!this.droneStarted) {
      this.audio.startDrone(this.specimen);
      this.droneStarted = true;
    }
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
    const pulling = event.shiftKey === true || event.buttons === 2;
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

  async toggleAudio() {
    if (this.audio.enabled) {
      this.audio.disable();
    } else {
      await this.enableAudio();
    }
    const button = this.document.querySelector('#audio');
    if (button !== null) {
      button.textContent = this.audio.enabled ? 'Audio on' : 'Audio off';
    }
  }

  newCreature() {
    this.seed = Math.floor(Math.random() * 0x100000000) >>> 0;
    this.world.reset(this.seed);
    this.specimen = withFrequencies(makeSpecimen(this.seed), noteFrequency);
    this.droneStarted = false;
    if (this.audio.enabled) {
      this.audio.startDrone(this.specimen);
      this.droneStarted = true;
    }
    const url = new URL(this.document.location.href);
    url.searchParams.set('seed', String(this.seed));
    this.document.defaultView?.history.replaceState(null, '', url);
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
