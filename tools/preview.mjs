/*
 * Render one simulation frame to a PNG without a browser.
 *
 * There is no raster backend here, so `render.js` can only be checked for
 * sensible 2D calls. This is a second painter over the same `World`, used to
 * eyeball things a call recorder cannot tell you: creature proportions, whether
 * it straddles the waterline, whether the wake is visible, whether the strata
 * read as depth.
 *
 * The creature's shape comes from `creatureGeometry()`, the same function
 * `render.js` draws, so proportions here are the ones the player sees. What is
 * approximated is the paint: flat fills instead of gradients, and no stroke
 * antialiasing. It is NOT a screenshot, and no check depends on it. If the two
 * ever disagree about colour, `render.js` is what the player sees.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOptional } from './optional-deps.mjs';

import FluxPond from '../src/flux-pond.js';
import { Camera, creatureGeometry } from '../src/render.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pngjs = loadOptional('pngjs');
if (pngjs === null) {
  console.error('pngjs is unavailable; cannot write a preview.');
  process.exit(1);
}
const { PNG } = pngjs;

const WIDTH = 960;
const HEIGHT = 600;

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const s = saturation / 100.0;
  const l = lightness / 100.0;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const segments = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [0, 0, c]
  ];
  const [r1, g1, b1] = segments[Math.min(4, Math.floor(h / 60))];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.png = new PNG({ width, height });
    this.data = this.png.data;
    for (let i = 3; i < this.data.length; i += 4) {
      this.data[i] = 255;
    }
  }

  blend(x, y, rgb, alpha) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return;
    }
    const offset = (y * this.width + x) * 4;
    for (let c = 0; c < 3; c += 1) {
      this.data[offset + c] = Math.round(this.data[offset + c] * (1 - alpha) + rgb[c] * alpha);
    }
  }

  fillRows(y0, y1, rgb, alpha) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y1)); y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        this.blend(x, y, rgb, alpha);
      }
    }
  }

  fillPolygon(points, rgb, alpha) {
    let minY = Infinity;
    let maxY = -Infinity;
    for (const point of points) {
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
    for (let y = Math.max(0, Math.floor(minY)); y < Math.min(this.height, Math.ceil(maxY)); y += 1) {
      const crossings = [];
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (a.y === b.y) {
          continue;
        }
        if (y >= Math.min(a.y, b.y) && y < Math.max(a.y, b.y)) {
          crossings.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
        }
      }
      crossings.sort((p, q) => p - q);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        for (let x = Math.max(0, Math.round(crossings[i])); x < Math.min(this.width, crossings[i + 1]); x += 1) {
          this.blend(x, y, rgb, alpha);
        }
      }
    }
  }

  strokePolyline(points, rgb, alpha, thickness = 1) {
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)) * 2);
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        const x = Math.round(a.x + (b.x - a.x) * t);
        const y = Math.round(a.y + (b.y - a.y) * t);
        for (let ox = 0; ox < thickness; ox += 1) {
          for (let oy = 0; oy < thickness; oy += 1) {
            this.blend(x + ox, y + oy, rgb, alpha);
          }
        }
      }
    }
  }

  fillDisc(cx, cy, radius, rgb, alpha) {
    for (let y = Math.floor(cy - radius); y <= cy + radius; y += 1) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x += 1) {
        if (Math.hypot(x - cx, y - cy) <= radius) {
          this.blend(x, y, rgb, alpha);
        }
      }
    }
  }
}

const seed = Number(process.argv[2] ?? 20261027);
const seconds = Number(process.argv[3] ?? 0);
const outPath = process.argv[4] ?? path.join(root, '.tmp', `preview-${seed}.png`);

const world = new FluxPond.World({ seed });
while (world.time < seconds) {
  world.step(1 / 60);
  world.followCamera(1 / 60);
}
world.followCamera(0);

const camera = new Camera(WIDTH, HEIGHT);
camera.x = world.cameraX;
const raster = new Raster(WIDTH, HEIGHT);
const creature = world.creature;

// Water column: one band per stratum, darkening with depth.
for (const stratum of world.strata) {
  const top = camera.screenY(stratum.top);
  const bottom = camera.screenY(stratum.bottom);
  raster.fillRows(top, bottom, hslToRgb(200 - 34 * stratum.tone, 66, 30 - 22 * stratum.tone), 1.0);
}

// Air above the rest surface, so a floating body is silhouetted.
raster.fillRows(0, camera.screenY(0), hslToRgb(214, 48, 74), 0.55);

// Free surface with the live wake, plus crest glow from the height field.
const surfacePoints = [];
for (let px = 0; px < WIDTH; px += 1) {
  const worldX = camera.worldX(px);
  surfacePoints.push({ x: px, y: camera.screenY(world.field.sample(worldX)) });
}
raster.strokePolyline(surfacePoints, [232, 248, 255], 0.85, 2);
for (let cell = 0; cell < world.field.cells; cell += 1) {
  const amplitude = world.field.amp[cell];
  if (Math.abs(amplitude) < 0.006) {
    continue;
  }
  const px = camera.screenX((cell + 0.5) * world.field.cellSize);
  if (px < 0 || px >= WIDTH) {
    continue;
  }
  const y = Math.round(camera.screenY(world.field.sample(camera.worldX(px))));
  const brightness = Math.min(1, Math.abs(amplitude) * 5);
  for (let offset = -14; offset <= 14; offset += 1) {
    raster.blend(px + offset, y - 3, [190, 240, 255], 0.5 * brightness * (1 - Math.abs(offset) / 15));
  }
}

// Creature. Every polygon below comes from the renderer's own geometry.
const geometry = creatureGeometry(creature, camera);
const hue = geometry.hue;
const lightness = 70 - 30 * geometry.depth;
raster.fillPolygon(geometry.fin, hslToRgb(hue + 8, 74, 66), 0.62);
raster.fillPolygon(geometry.outline, hslToRgb(hue, 78, lightness), 1.0);
raster.strokePolyline([...geometry.outline, geometry.outline[0]], hslToRgb(hue - 36, 70, 12), 0.6, 2);
raster.fillPolygon(geometry.core, hslToRgb(hue + 24, 84, 84), 0.16);
raster.fillDisc(geometry.eye.x, geometry.eye.y, geometry.eye.r, [245, 248, 252], 0.95);
raster.fillDisc(geometry.eye.pupil.x, geometry.eye.pupil.y, geometry.eye.pupil.r, [12, 18, 30], 0.95);

// `png.pack()` returns a stream and takes no callback.
const chunks = [];
const stream = raster.png.pack();
stream.on('data', (chunk) => chunks.push(chunk));
stream.on('error', (error) => {
  console.error('PNG encoding failed:', error.message);
  process.exit(1);
});
stream.on('end', () => {
  const buffer = Buffer.concat(chunks);
  writeFileSync(outPath, buffer);
  console.log(
    JSON.stringify({
      out: outPath,
      bytes: buffer.length,
      seed,
      time: Number(world.time.toFixed(2)),
      centreY: Number(creature.centroid().y.toFixed(4)),
      immersion: Number(creature.immersion().toFixed(3)),
      species: creature.name,
      area: Number(creature.area().toFixed(5)),
      wakeEvents: world.metrics.wakeEvents
    })
  );
});
