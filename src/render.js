/*
 * Canvas renderer for Flux Pond.
 *
 * Draw-only: it owns no state and mutates no `World`, so the simulation stays
 * reproducible and the renderer can be driven by a recording stub in tests
 * (there is no raster backend in this environment -- see tests/render.test.mjs).
 *
 * Coordinate convention: the world is the strip 0 <= y <= 1 (0 = surface,
 * 1 = floor) and x is unbounded. The camera scrolls in x and follows the
 * creature; depth is stretched to the canvas height with a margin of air above
 * the waterline so breaches are visible.
 */

const VIEW = {
  airAbove: 0.34,
  floorBelow: 0.06,
  viewWidth: 3.4
};

/* Creature proportions, as fractions of the body's projected radius. */
/* Plankton are drawn in pixels: a fraction of viewport height keeps them legible
 * at any size without importing the simulation's idea of a metre. */
const MOTE_FRACTION = 0.0045;
const POP_LIFE = 0.7;

/* Bubbles are shed every SHED seconds and live BUBBLE_LIFE; see `drawBubbles`. */
const SHED = 0.13;
const BUBBLE_LIFE = 0.95;

const CORE_SCALE = 0.56;
const FIN_REACH = 0.66;
const FIN_FLARE = 0.55;
const EYE_RATIO = 0.17;

/* Pixels per world unit of depth: the same number `creatureGeometry` uses, so
 * anything sized in world units agrees between the body and its surroundings. */
function pixelsPerUnit(camera) {
  return camera.height / (1 + VIEW.airAbove + VIEW.floorBelow);
}

/* Deterministic stand-in for randomness: a slot number in, 0-1 out. The renderer
 * owns no state, so anything that has to look irregular has to be hashed from
 * something the frame already knows. */
function slotFraction(slot) {
  const scaled = Math.sin(slot * 12.9898) * 43758.5453;
  return scaled - Math.floor(scaled);
}

function hsl(hue, saturation, lightness, alpha) {
  return `hsla(${hue.toFixed(1)},${saturation.toFixed(1)}%,${lightness.toFixed(1)}%,${alpha.toFixed(3)})`;
}

class Camera {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.x = 0.0;
  }

  screenX(worldX) {
    return ((worldX - this.x) / VIEW.viewWidth + 0.5) * this.width;
  }

  worldX(screenX) {
    return this.x + (screenX / this.width - 0.5) * VIEW.viewWidth;
  }

  screenY(worldY) {
    const span = 1.0 + VIEW.airAbove + VIEW.floorBelow;
    return ((worldY + VIEW.airAbove) / span) * this.height;
  }

  worldY(screenY) {
    const span = 1.0 + VIEW.airAbove + VIEW.floorBelow;
    return (screenY / this.height) * span - VIEW.airAbove;
  }
}

/*
 * Background: a deep gradient plus one parallax band per stratum. Band offsets
 * derive from the camera and time rather than from randomness, so panning is
 * smooth and two frames at the same camera position match exactly.
 */
function drawWater(context, camera, world, time) {
  const { width, height } = camera;
  const gradient = context.createLinearGradient(0, camera.screenY(0.0), 0, height);
  gradient.addColorStop(0.0, 'hsl(196,72%,26%)');
  gradient.addColorStop(0.45, 'hsl(205,74%,14%)');
  gradient.addColorStop(1.0, 'hsl(232,64%,5%)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (let i = 0; i < world.strata.length; i += 1) {
    const stratum = world.strata[i];
    const top = camera.screenY(stratum.top);
    const bottom = camera.screenY(stratum.bottom);
    const parallax = 0.25 + 0.6 * stratum.tone;
    const spacing = 130 + 90 * stratum.tone;
    const offset = ((-camera.x * parallax * 90 + time * (6 + 14 * stratum.tone)) % spacing + spacing) % spacing;

    context.fillStyle = hsl(190 - 30 * stratum.tone, 62, 46 + 10 * stratum.tone, 0.05 + 0.035 * stratum.tone);
    for (let x = -spacing; x < width + spacing; x += spacing) {
      const bandX = x + offset;
      context.beginPath();
      context.ellipse(
        bandX + spacing * 0.5,
        (top + bottom) / 2,
        spacing * 0.42,
        Math.max(2, (bottom - top) * 0.16),
        0, 0, Math.PI * 2
      );
      context.fill();
    }
  }
}

/*
 * Sunlight. Shafts are wedges from the waterline to the floor, one per slice of
 * world x, swaying on two time scales so they never quite repeat. They are placed
 * in world space and not screen space: a shaft is a place in the trench, and
 * scrolling past one is part of the sense of moving through water.
 */
function drawSunlight(context, camera, time) {
  const surfaceTop = camera.screenY(0.0);
  const floor = camera.screenY(1.0);
  if (!(floor > surfaceTop)) {
    return;
  }
  const period = 1.25;
  const first = Math.floor((camera.x - VIEW.viewWidth / 2) / period) - 1;
  const last = Math.ceil((camera.x + VIEW.viewWidth / 2) / period) + 1;
  /*
   * Soft edges from nested wedges. A canvas gradient runs along one axis, so
   * there is no way to feather a wedge sideways; four overlapping wedges, widest
   * and faintest first, add up to a falloff that reads as light. Drawn as one,
   * however subtle, it reads as a pane of glass -- which is exactly what the
   * first version of this looked like.
   */
  const layers = [
    { width: 3.2, alpha: 0.28 },
    { width: 2.0, alpha: 0.40 },
    { width: 1.2, alpha: 0.62 },
    { width: 0.55, alpha: 1.0 }
  ];
  const slant = camera.width * 0.11;
  for (let slot = first; slot <= last; slot += 1) {
    const phase = slot * 0.79;
    const sway = Math.sin(time * 0.11 + phase) * 0.13 + Math.sin(time * 0.037 + phase * 2.3) * 0.08;
    const px = camera.screenX((slot + 0.5) * period + sway);
    const width = camera.width * (0.014 + 0.020 * slotFraction(slot * 3.7));
    const strength = 0.018 + 0.020 * (0.5 + 0.5 * Math.sin(time * 0.13 + phase * 1.7));
    for (const layer of layers) {
      const top = width * layer.width;
      const bottom = top * 3.4;
      context.beginPath();
      context.moveTo(px - top * 0.5, surfaceTop);
      context.lineTo(px + top * 0.5, surfaceTop);
      context.lineTo(px + slant + bottom * 0.5, floor);
      context.lineTo(px + slant - bottom * 0.5, floor);
      context.closePath();
      const alpha = strength * layer.alpha;
      const gradient = context.createLinearGradient(0, surfaceTop, 0, floor);
      gradient.addColorStop(0.0, hsl(186, 94, 80, alpha));
      gradient.addColorStop(0.45, hsl(192, 88, 62, alpha * 0.40));
      gradient.addColorStop(1.0, hsl(204, 80, 52, 0.0));
      context.fillStyle = gradient;
      context.fill();
    }
  }
}

/*
 * The band of light just under the surface, and the bright patch where the sun
 * happens to be. Both are what makes water read as water rather than as a
 * gradient with a line on it.
 */
function drawSurfaceLight(context, camera, field, time) {
  const surfaceTop = camera.screenY(0.0);
  const band = Math.max(1.0, camera.height * 0.15);
  const near = context.createLinearGradient(0, surfaceTop, 0, surfaceTop + band);
  near.addColorStop(0.0, 'hsla(186,92%,82%,0.17)');
  near.addColorStop(1.0, 'hsla(188,90%,70%,0)');
  context.fillStyle = near;
  context.fillRect(0, surfaceTop, camera.width, band);

  const glintX = camera.x + 0.85 * Math.sin(time * 0.047);
  const px = camera.screenX(glintX);
  const py = camera.screenY(field.sample(glintX));
  const reach = Math.max(1.0, camera.width * 0.26);
  const glint = context.createRadialGradient(px, py, 0, px, py, reach);
  glint.addColorStop(0.0, 'hsla(52,96%,88%,0.16)');
  glint.addColorStop(0.45, 'hsla(190,96%,80%,0.06)');
  glint.addColorStop(1.0, 'hsla(190,96%,80%,0)');
  context.fillStyle = glint;
  context.fillRect(px - reach, py - reach, reach * 2.0, reach * 2.0);
}

/*
 * Free surface. Drawn from the height field, so the wake the creature caused is
 * literally the line you see. The band under the line brightens with local
 * amplitude, which makes wave energy visible without a HUD readout.
 */
function drawSurface(context, camera, field) {
  const { width } = camera;
  const stepPx = Math.max(1, Math.round(width / 220));
  const surfaceY = [];
  const screens = [];
  for (let px = 0; px <= width; px += stepPx) {
    const worldX = camera.worldX(px);
    const elevation = field.sample(worldX);
    screens.push(px);
    surfaceY.push(camera.screenY(elevation));
  }

  // Air above the waterline, so a breaching body is silhouetted against it.
  context.beginPath();
  context.moveTo(0, 0);
  for (let i = 0; i < screens.length; i += 1) {
    context.lineTo(screens[i], surfaceY[i]);
  }
  context.lineTo(width, 0);
  context.closePath();
  context.fillStyle = 'hsla(210,60%,78%,0.10)';
  context.fill();

  context.beginPath();
  context.moveTo(screens[0], surfaceY[0]);
  for (let i = 1; i < screens.length; i += 1) {
    context.lineTo(screens[i], surfaceY[i]);
  }
  context.strokeStyle = 'hsla(188,96%,86%,0.72)';
  context.lineWidth = 1.5;
  context.stroke();
}

/*
 * Crest highlights from the height field itself. Only cells above a threshold
 * are drawn, which keeps the cost proportional to actual wave activity.
 */
function drawWake(context, camera, field) {
  const { width } = camera;
  const cellsVisible = VIEW.viewWidth;
  const cellSize = field.cellSize;
  const startCell = Math.floor(camera.x - cellsVisible / 2);
  const endCell = Math.ceil(camera.x + cellsVisible / 2);
  const scale = width / cellsVisible;
  context.lineWidth = 1.25;
  for (let cell = startCell; cell <= endCell; cell += 1) {
    if (cell < 0 || cell >= field.cells) {
      continue;
    }
    const amplitude = field.amp[cell];
    if (Math.abs(amplitude) < 0.006) {
      continue;
    }
    const worldX = (cell + 0.5) * cellSize;
    const px = camera.screenX(worldX);
    if (px < -scale || px > camera.width + scale) {
      continue;
    }
    const elevation = field.sample(worldX);
    const y = camera.screenY(elevation);
    const reach = Math.min(26, Math.abs(amplitude) * 900);
    const bright = Math.min(1, Math.abs(amplitude) * 4.5);
    context.strokeStyle = hsl(186, 100, 88, 0.16 + 0.5 * bright);
    context.beginPath();
    context.moveTo(px - reach * 0.5, y);
    context.lineTo(px + reach * 0.5, y);
    context.stroke();
  }
}

/*
 * Screen-space geometry for the creature, computed once per frame.
 *
 * This exists so the canvas renderer and `tools/preview.mjs` (the only way to
 * look at anything in this environment) describe the animal from one source of
 * truth: they are two painters over the same polygons rather than two
 * descriptions of it. It is pure -- no allocation-free constraint, no state.
 *
 * Everything here is in pixels. The previous version sized the eye from
 * `creature.radius()`, which is a *world* radius in the 0..1 depth strip, so the
 * eyes were 2.6 px dots on a 100 px body and the creature looked like a blob
 * with two specks on it.
 */
function creatureGeometry(creature, camera) {
  const n = creature.points;
  const centre = creature.centroid();
  const depth = Math.max(0, Math.min(1, centre.y));
  const pxPerUnit = camera.height / (1 + VIEW.airAbove + VIEW.floorBelow);
  const radius = Math.max(6, creature.radius() * pxPerUnit);
  const cx = camera.screenX(centre.x);
  const cy = camera.screenY(centre.y);

  const outline = [];
  for (let i = 0; i < n; i += 1) {
    outline.push({ x: camera.screenX(creature.x[i]), y: camera.screenY(creature.y[i]) });
  }

  /*
   * An inner copy of the outline. Two chords across the middle of the body read
   * as a wireframe; a scaled-down silhouette reads as a body cavity seen through
   * translucent tissue, and it deforms with the swim so the motion is legible.
   */
  const core = outline.map((point) => ({
    x: cx + (point.x - cx) * CORE_SCALE,
    y: cy + (point.y - cy) * CORE_SCALE
  }));

  /*
   * Caudal fin. Its base is a chord of the outline itself, four masses across
   * the tail, so it stays attached as the body bends and swings side to side with
   * the travelling wave instead of being animated separately.
   */
  const tail = creature.tailIndex;
  const baseA = outline[(tail - 2 + n) % n];
  const baseB = outline[(tail + 2) % n];
  const baseX = (baseA.x + baseB.x) / 2;
  const baseY = (baseA.y + baseB.y) / 2;
  let backX = baseX - cx;
  let backY = baseY - cy;
  const backLength = Math.hypot(backX, backY) || 1.0;
  backX /= backLength;
  backY /= backLength;
  const spanX = baseB.x - baseA.x;
  const spanY = baseB.y - baseA.y;
  const spanLength = Math.hypot(spanX, spanY) || 1.0;
  const unitX = spanX / spanLength;
  const unitY = spanY / spanLength;
  const reach = radius * FIN_REACH;
  const flare = reach * FIN_FLARE;
  /*
   * Walk the outline without crossing it: from `baseA` out to the lobe on
   * `baseA`'s own side, in to the notch, out to the lobe on `baseB`'s side, back
   * to `baseB`. Putting the first lobe on the far side instead (what the first
   * version did) makes the two outer edges cross, and a self-intersecting
   * polygon fills wrong whatever rule the painter uses: the offline raster fills
   * even-odd crossings and showed two thin needles instead of a fan, and a
   * browser's default nonzero winding would invert the near-side lobe.
   */
  const fin = [
    baseA,
    { x: baseX + backX * reach - unitX * flare, y: baseY + backY * reach - unitY * flare },
    { x: baseX + backX * reach * 0.38, y: baseY + backY * reach * 0.38 },
    { x: baseX + backX * reach + unitX * flare, y: baseY + backY * reach + unitY * flare },
    baseB
  ];

  /*
   * One eye: the loop is a side view, so a single eye near the nose reads as an
   * animal in profile, and it sits offset to the dorsal side (up on screen) the
   * way a fish's does.
   */
  const nose = outline[creature.nose];
  let inX = cx - nose.x;
  let inY = cy - nose.y;
  const inLength = Math.hypot(inX, inY) || 1.0;
  inX /= inLength;
  inY /= inLength;
  const eyeR = radius * EYE_RATIO;
  // Perpendicular to the body axis, with the sign chosen so it points up the
  // screen: screen y grows with depth, so "dorsal" is the negative-y normal.
  let dorsalX = -backY;
  let dorsalY = backX;
  if (dorsalY > 0.0) {
    dorsalX = -dorsalX;
    dorsalY = -dorsalY;
  }
  const eye = {
    x: nose.x + inX * eyeR * 1.7 + dorsalX * eyeR * 0.9,
    y: nose.y + inY * eyeR * 1.7 + dorsalY * eyeR * 0.9,
    r: eyeR
  };
  // The pupil leads with the body's mass-weighted drift -- the same velocity the
  // physics core reports -- so it agrees with what the creature is doing.
  const drift = creature.velocity();
  const speed = Math.hypot(drift.vx, drift.vy);
  const gazeX = speed > 0.05 ? drift.vx / speed : -backX;
  const gazeY = speed > 0.05 ? drift.vy / speed : -backY;
  eye.pupil = { x: eye.x + gazeX * eye.r * 0.34, y: eye.y + gazeY * eye.r * 0.34, r: eye.r * 0.46 };

  return { centre: { x: cx, y: cy }, depth, radius, outline, core, fin, eye, hue: (creature.hue + 18 * depth) % 360 };
}

/*
 * The creature: one closed spline through the masses, filled with a gradient
 * centred on its centroid. Depth darkens it, because light is absorbed.
 */
function drawCreature(context, camera, creature, time) {
  const geometry = creatureGeometry(creature, camera);
  const { hue, radius, centre } = geometry;
  const lightness = 72 - 34 * geometry.depth;

  drawFin(context, geometry, hue);

  const gradient = context.createRadialGradient(
    centre.x - radius * 0.25, centre.y - radius * 0.3, radius * 0.08, centre.x, centre.y, radius * 1.15
  );
  gradient.addColorStop(0, hsl(hue + 14, 92, Math.min(92, lightness + 18), 0.97));
  gradient.addColorStop(0.55, hsl(hue, 78, lightness, 0.92));
  gradient.addColorStop(1, hsl(hue - 26, 66, Math.max(8, lightness - 34), 0.9));

  context.beginPath();
  traceLoop(context, geometry.outline);
  context.fillStyle = gradient;
  context.fill();
  context.lineWidth = 1.4;
  context.strokeStyle = hsl(hue - 40, 70, 12, 0.55);
  context.stroke();

  // Body cavity.
  context.beginPath();
  traceLoop(context, geometry.core);
  context.fillStyle = hsl(hue + 24, 84, 80, 0.16 - 0.08 * geometry.depth);
  context.fill();

  drawEye(context, geometry, time);
}

/* Smooth closed curve through the points, using each point as a control point. */
function traceLoop(context, points) {
  context.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    context.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2);
  }
  context.closePath();
}

/*
 * Drawn before the body, so the fin emerges from under it and no seam shows.
 * Semi-transparent: fins are tissue, and the wake shows through them.
 */
function drawFin(context, geometry, hue) {
  const { fin } = geometry;
  context.beginPath();
  context.moveTo(fin[0].x, fin[0].y);
  for (let i = 1; i < fin.length; i += 1) {
    context.lineTo(fin[i].x, fin[i].y);
  }
  context.closePath();
  context.fillStyle = hsl(hue + 8, 74, 66, 0.5 - 0.22 * geometry.depth);
  context.fill();
  context.lineWidth = 1;
  context.strokeStyle = hsl(hue - 30, 70, 20, 0.35);
  context.stroke();
}

function drawEye(context, geometry, time) {
  const { eye } = geometry;
  // A rare blink: one in a long while, and it flattens the eye rather than
  // hiding it, so the head keeps its orientation.
  const blink = Math.sin(time * 0.7 + geometry.hue) > 0.985 ? 0.15 : 1.0;
  context.beginPath();
  context.ellipse(eye.x, eye.y, eye.r, Math.max(0.4, eye.r * blink), 0, 0, Math.PI * 2);
  context.fillStyle = 'hsla(45,30%,96%,0.94)';
  context.fill();
  if (blink > 0.5) {
    context.beginPath();
    context.arc(eye.pupil.x, eye.pupil.y, eye.pupil.r, 0, Math.PI * 2);
    context.fillStyle = 'hsla(220,60%,8%,0.95)';
    context.fill();
  }
}

/*
 * The plankton layer: a faint band, the motes in it, and the rings left where
 * the creature bit one. Everything is read off the World through its own
 * accessor, so the renderer never learns that positions come from a hash, and
 * the layer is drawn only when the simulation has one.
 */
function drawPlankton(context, camera, world) {
  if (world.foodEnabled !== true) {
    return;
  }
  const top = camera.screenY(world.foodBand.top);
  const bottom = camera.screenY(world.foodBand.bottom);
  const haze = context.createLinearGradient(0, top, 0, bottom);
  haze.addColorStop(0.0, 'hsla(152,62%,58%,0)');
  haze.addColorStop(0.42, 'hsla(152,66%,60%,0.085)');
  haze.addColorStop(1.0, 'hsla(152,62%,55%,0)');
  context.fillStyle = haze;
  context.fillRect(0, top, camera.width, Math.max(1, bottom - top));

  const unit = Math.max(1.1, camera.height * MOTE_FRACTION);
  const halfView = VIEW.viewWidth / 2 + 0.25;
  const target = world.foodTarget;
  world.forEachMote(camera.x - halfView, camera.x + halfView, (id, x, y, size) => {
    const px = camera.screenX(x);
    const py = camera.screenY(y);
    const r = unit * (0.7 + 0.6 * size);
    const lit = target !== null && target.id === id ? 1.0 : 0.6;
    context.beginPath();
    context.arc(px, py, r * 3.4, 0, Math.PI * 2);
    context.fillStyle = hsl(146, 88, 72, 0.055 * lit);
    context.fill();
    context.beginPath();
    context.arc(px, py, r, 0, Math.PI * 2);
    context.fillStyle = hsl(150, 80, 64 + 22 * lit, 0.45 + 0.45 * lit);
    context.fill();
  });

  for (const pop of world.feedPops) {
    const age = Math.min(1, Math.max(0, pop.age / POP_LIFE));
    context.beginPath();
    context.arc(camera.screenX(pop.x), camera.screenY(pop.y), 2 + 15 * age, 0, Math.PI * 2);
    context.strokeStyle = hsl(150, 92, 82, 0.34 * (1 - age));
    context.lineWidth = 1.2;
    context.stroke();
  }
}

/*
 * The bubble string a swimming body leaves behind.
 *
 * The renderer owns no state, so it cannot remember where the creature was. It
 * does not need to: bubbles are shed on a fixed interval, so the age of the
 * k-th oldest is `k * SHED + (time mod SHED)`, and where it was shed is
 * approximately where the creature is now, walked back along its own velocity.
 * That is a straight-ish line of rising, growing bubbles, and it is a pure
 * function of one frame -- which is what keeps golden frames reproducible.
 */
function drawBubbles(context, camera, world) {
  const creature = world.creature;
  if (creature.immersion() < 0.5) {
    return;
  }
  const drift = creature.velocity();
  const speed = Math.hypot(drift.vx, drift.vy);
  if (speed < 0.16) {
    return;
  }
  const centre = creature.centroid();
  const scale = pixelsPerUnit(camera);
  const presence = Math.min(1.0, (speed - 0.16) / 0.5);
  const ageOfFirst = world.time % SHED;
  for (let slot = 0; slot < 9; slot += 1) {
    const age = ageOfFirst + slot * SHED;
    if (age >= BUBBLE_LIFE) {
      continue;
    }
    const life = age / BUBBLE_LIFE;
    // The string lags the body, and the bubbles are buoyant, so they climb out
    // of the wake as they age.
    const worldX = centre.x - drift.vx * age * 0.8 + Math.sin(age * 5.4 + slot) * 0.006;
    const worldY = centre.y - drift.vy * age * 0.8 - 0.34 * age;
    if (worldY < 0.01 || worldY > 0.99) {
      continue;
    }
    const px = camera.screenX(worldX);
    const py = camera.screenY(worldY);
    const radius = Math.max(0.6, scale * (0.0032 + 0.0055 * life) * (0.6 + 0.8 * slotFraction(slot)));
    const alpha = 0.42 * (1.0 - life) * presence;
    context.beginPath();
    context.arc(px, py, radius, 0, Math.PI * 2);
    context.fillStyle = hsl(190, 96, 88, alpha * 0.45);
    context.fill();
    context.beginPath();
    context.arc(px, py, radius, 0, Math.PI * 2);
    context.strokeStyle = hsl(190, 100, 94, alpha);
    context.lineWidth = 1;
    context.stroke();
  }
}

/*
 * Cursor field. Colour encodes mode: warm = push, cool = pull. Radius is the
 * real influence radius from the simulation, so what you see is what acts.
 */
function drawCursor(context, camera, pointer, time) {
  if (!pointer.active) {
    return;
  }
  const x = camera.screenX(pointer.x);
  const y = camera.screenY(pointer.y);
  const radiusPx = (pointer.radius / VIEW.viewWidth) * camera.width;
  const hue = pointer.attract ? 168 : 26;
  const alpha = 0.12 + 0.5 * pointer.pressure;

  const gradient = context.createRadialGradient(x, y, 0, x, y, Math.max(1, radiusPx));
  gradient.addColorStop(0, hsl(hue, 100, 70, alpha));
  gradient.addColorStop(1, hsl(hue, 100, 55, 0));
  context.beginPath();
  context.arc(x, y, Math.max(1, radiusPx), 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.fill();

  // Pulsed off simulated time, not the wall clock: a frame of this renderer has
  // to depend on the seed alone, and a ring that breathed on `Date.now()` made
  // the same world paint two different pictures.
  context.beginPath();
  context.arc(x, y, Math.max(1, radiusPx * (0.86 + 0.05 * Math.sin(time * 3.8))), 0, Math.PI * 2);
  context.strokeStyle = hsl(hue, 100, 78, 0.35 + 0.4 * pointer.pressure);
  context.lineWidth = 1.2;
  context.stroke();
}

/*
 * How dark it gets, and how fast: everything below this depth starts to close
 * in, which is the cheapest way to make the sounding layer feel somewhere you
 * should not linger. The cursor field is drawn after this so the one piece of
 * interface in the water stays as readable as the water itself.
 */
function drawDepthVignette(context, camera) {
  const from = camera.screenY(0.45);
  const floor = camera.screenY(1.0);
  if (!(floor > from)) {
    return;
  }
  const gradient = context.createLinearGradient(0, from, 0, floor);
  gradient.addColorStop(0.0, 'hsla(226,64%,4%,0)');
  gradient.addColorStop(1.0, 'hsla(226,64%,3%,0.42)');
  context.fillStyle = gradient;
  context.fillRect(0, from, camera.width, floor - from);
}

function render(context, world, camera, time) {
  camera.x = world.cameraX;
  context.save();
  drawWater(context, camera, world, time);
  drawSunlight(context, camera, time);
  drawSurface(context, camera, world.field);
  drawSurfaceLight(context, camera, world.field, time);
  drawWake(context, camera, world.field);
  drawPlankton(context, camera, world);
  drawCreature(context, camera, world.creature, time);
  drawBubbles(context, camera, world);
  drawDepthVignette(context, camera);
  drawCursor(context, camera, world.pointer, time);
  context.restore();
}

export { Camera, VIEW, creatureGeometry, render, hsl };
