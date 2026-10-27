# Flux Pond

A procedurally generated buoyant creature in a shallow, stratified trench that you steer with cursor pressure — and a toy about one specific emergent thing: **a body floating at a waterline**.

It is a closed loop of point masses joined by springs, with real Archimedes buoyancy, drag, a floor, and a surface height field that the creature itself disturbs. Nothing about the motion is animated: swimming, breaching, skimming, bouncing off the floor and the wake you leave behind are all consequences of the same force law. Every creature is derived from a seed, so `?seed=...` reproduces one exactly.

## Run it

```bash
python3 serve.py
```

then open <http://127.0.0.1:8000/>.

ES modules are loaded over `http://`, so opening `index.html` with `file://` will not work — the browser refuses the imports. Any static server is fine (`python3 -m http.server 8000`); `serve.py` just sets the right MIME types and prints the URL. `PORT=8123 python3 serve.py` changes the port.

No build step, no dependencies, no network access at runtime: no fonts, libraries, samples or images are fetched.

## Controls

| Input | Effect |
| --- | --- |
| Move the cursor | Pushes the creature away from the cursor within the visible ring |
| Press / hold | Pushes harder (the field swells rather than snapping on) |
| **Shift**-drag or **right**-drag | **Pull** instead of push — this is how you make it dive |
| `R` | New specimen (a new seed is written to the URL) |
| `Space` | Pause / resume |
| `A` | Audio on / off |
| `H` | Hide the help panel |

Audio is off until you click, because browsers forbid starting it before a gesture. The drone is the specimen's own chord through a low-pass filter that follows depth, so diving muffles it; each time a mass breaks the surface it plays a note whose pitch comes from the impact speed, which is where the rhythm comes from.

## What to try

- **Park the cursor just above the waterline and hold.** The creature surfaces, skims, and starts skipping.
- **Shift-drag to the floor, then let go.** A body that is lighter than water and pressed against a floor rebounds, and `floor bounce` lights up.
- **Stay still.** After ~2 s the creature swims by itself, with a travelling wave along its body, and leaves a wake you did not cause.
- **Compare the standing waves.** Move at a steady speed and the wake locks into a fixed pattern relative to you; stop, and the trench keeps sloshing.
- **Roll a few seeds.** Specimens differ in silhouette, mass distribution, size, hue and musical key, which changes how they swim: a bulged forebody is heavy at the front and pitches nose-down when it slows.
- **Watch the tail.** The eye sits at the thickest part of the body and its pupil turns with the drift; the caudal fin is anchored to four real outline masses at the other end, so it swings with the travelling wave rather than being animated separately. Neither is skinned or keyframed — when the body folds, they fold with it.

## How it works

- `src/flux-pond.js` — the whole simulation, with no DOM, canvas or audio. A closed loop of 22 masses with perimeter, structural and bend springs, a radial area-preservation term, per-mass buoyancy/drag/meniscus forces, a pointer force, and a `SurfaceField` height field. Fixed 120 Hz substeps with velocity and step clamps.
- `src/render.js` — draws a `World` into an injected 2D context. Owns no state. `creatureGeometry()` is the single definition of where the eye, the body and the tail fin are, and both the canvas renderer and the offline preview draw from it.
- `src/audio.js` — Web Audio graph built from the specimen's chord; the injected-context design is what makes it testable without an audio device.
- `src/app.js` — fixed-timestep frame loop, input mapping, and the read-out panel. Holds no physics state.
- `src/main.js` — constructs the concrete collaborators, starts the loop, reports failures instead of dying silently.
- `tools/preview.mjs` — rasterises one frame to a PNG with no browser. It is a second painter over `creatureGeometry()`, so the creature's proportions in it are the ones the canvas draws. Dev aid only; no check depends on it.

Three ideas worth knowing about, because they are where the behaviour comes from:

**Buoyancy is derived, not tuned.** The lift term is computed as `gravity / floatTrim` where it is applied rather than stored as a second tunable, which puts the Archimedes equilibrium — where the wetted fraction of the body equals `floatTrim` — exactly at the intended riding depth. Measured over 110 s per seed, the mean wetted fraction lands on the designed value to within about one percent.

**The fluid is at rest.** An earlier revision had a background current, which acted as a permanent force: drag against it never vanished, so the creature could never settle and orbited forever in a limit cycle. Forward motion now comes only from the pointer pushing against stationary water, and the sense of speed comes from parallax in the strata.

**Ripples are caused by the creature.** A wave is injected only when a mass crosses the free surface, at an amplitude set by its crossing speed. There is no decorative wake.

`WORLD` at the top of `src/flux-pond.js` is the tuning surface; `PHENOMENA` below it holds the detection thresholds, and the comments say which of these numbers were measured rather than guessed.

## Checks

```bash
tools/check.sh            # syntax + all automated tests (~40 s, the stability sweeps dominate)
tools/check.sh --browser  # additionally drive the real page in headless Chromium
```

`tools/check.sh` needs Node, found on `PATH` or in the Nix store (`tools/toolchain.sh`). It runs `node --check` over every source file and then four test files:

- `tests/sim.test.mjs` (28) — determinism, a 600-seed × 30 s stability sweep, hostile input, degenerate frame times, floating at the designed trim, floor impenetrability, area preservation, wake causality, surface-field advection and saturation, hysteresis of every phenomenon, audio helper maths. Plus: a new specimen starts **stress-free** (every spring's rest length equals the distance it was built at), the body still matches its built perimeter spacing after 12 s, and the nose/tail are fixed material indices opposite each other.
- `tests/render.test.mjs` (11) — renders through a recording 2D context across 120 seeds and degenerate viewport sizes, asserting no non-finite draw argument, no negative radius, balanced `save`/`restore`, and that the camera maps screen↔world space invertibly. Plus four on `creatureGeometry()`: finite at every viewport size, eye sized against the *projected* body, tail fin attached to real outline masses and pointing backwards, and the fin polygon free of self-intersections across 60 seeds.
- `tests/audio.test.mjs` (7) — against a stub `AudioContext`: nothing is touched before a gesture, one oscillator per chord tone, voice budget respected under 500 impacts in an instant, filter cutoff stays audible across the depth range.
- `tests/app.test.mjs` (10) — boots `index.html` verbatim in jsdom and checks the app/marker agreement in both directions (no id the app reads is missing, no id the page declares is dead), that frames populate the read-out, that pointer input moves the creature and generates wake, that shift selects pull, that pause freezes and resumes, that audio only starts on a gesture, and that every module `index.html` loads resolves on disk (jsdom does not fetch `src=` modules, so a renamed file is a blank page nothing else would catch).

These found every real bug listed under *Verified* below.

## Verified

Observed, on Node v24.20 with the current patch: **56 automated checks pass** (`tools/check.sh`) — 28 simulation, 11 render, 7 audio, 10 app — plus `node --check` on all 12 source/test/tool JS files.

Bugs found by those tests and fixed, each with a reproducing seed or input:

1. **A body-based "surface tension" term could only push up.** It sat inside the submerged branch, where penetration is always positive, so `Math.sign(penetration)` was a constant `+1`: a second, surface-local buoyancy that stranded creatures bone dry on the waterline (seed 23, 45 s idle). Replaced with velocity-based meniscus drag.
2. **Area preservation failed on concave bodies.** Pushing along outline normals flips sign wherever the loop goes concave — exactly when squeezed against the floor — so the correction oscillated and the creature stayed collapsed at 23% of its rest area (seed 145). Now a single radial correction about the centroid, which inflates monotonically; area stays within 0.85–1.09 across seeds.
3. **Straightness was sampled from a near-zero velocity vector,** whose angle is solver noise; feeding that into a turn rate pinned the `gliding` detector at zero for the rest of any run. Now derived from the ratio of displacement to path length.
4. **`settle()` lost its first frame** (a `state[key] || {...}` object was mutated without being stored) and its decay timer was unbounded, drifting to −24, so no phenomenon could ever latch.
5. **`bounce` tested the centroid against the floor** and the body has finite radius, so the predicate was unsatisfiable; now uses the lowest mass.
6. **Pull and push were inverted:** with `dx` pointing from a mass to the cursor, a negative coefficient was labelled "attract", so "pull" pushed and diving was impossible.
7. **A collapsed canvas poisoned the pointer.** A zero-size `getBoundingClientRect()` made the mapped position `Infinity`, which reached the gradient builders — a real browser throws there, killing the render loop. Degenerate rects are now rejected.

Numbers do not catch everything: 8–11 were found by rasterising a frame to PNG (`node tools/preview.mjs 20261027 12 .tmp/preview.png`) and *looking at it*.

8. **Rest lengths were analytic and disagreed with the geometry they were built on.** The spawn code placed the loop at one spacing and the springs wanted 4.08× that (2.04× for the chords), so every specimen began inside a huge internal fight and settled into whatever that mismatch favoured: creatures rendered as taut braced squares. Rest lengths are now measured from the built positions, and a test asserts the first frame is stress-free across 40 seeds.
9. **The eye was sized in world units.** `creature.radius()` is a radius in the normalised 0–1 depth strip, so `radius() * 12` produced a 2.6 px dot on a ~95 px body: the creature read as a blob with two specks on it. Eyes are now sized from the projected radius (`creatureGeometry`).
10. **The tail fin was a self-intersecting polygon.** Its lobes were emitted on the wrong sides of the base chord, so the two outer edges crossed and the even-odd fill left two thin needles instead of a fan. The fin is now walked in outline order, and a test asserts simplicity across 60 seeds.
11. **The head was derived from velocity.** An earlier `heading()` took the argmax of `(position − centroid) · velocity`, which is solver noise when the creature is at rest — so the eye and tail fin jumped between random masses from frame to frame. The nose is now a material index (the thickest mass, which is also the heaviest) fixed when the specimen is generated.

Two design corrections found by measurement rather than by a failing test: the background current described above, and pointer strength (a squared falloff left ~1.5 acceleration at one body-radius against 12.9 buoyancy, so the floor was unreachable and most phenomena could not be triggered; measured top speed went from 0.59 to ~2.4).

All six phenomena — `skimming`, `breach`, `skittering`, `gliding`, `sounding layer`, `floor bounce` — were observed to trigger across several seeds with a generic push/pull drive.

## Not verified

- **No browser has ever run it.** No browser could be launched: this environment has no display, no browser on `PATH`, no network to fetch one, and Chromium in the Nix store cannot start because it calls `setsockopt` (EPERM) and escalation is denied by policy. `tools/browser-check.mjs` is written and ready; run `tools/check.sh --browser` where Chromium can start, and it asserts the page boots, the canvas is not blank, pointer input moves the creature, shift dives it, reroll changes the seed, and no errors occur.
- **Geometry has been looked at; paint has not.** `tools/preview.mjs` shares `creatureGeometry()` with the renderer, so creature proportions, size against the trench, waterline straddling, silhouette and wake *have* been seen (that is how bugs 8–11 were found). What that cannot show: the gradients, stroke antialiasing, colour balance and contrast, the `backdrop-filter` panels, and whether 60 fps holds on real hardware.
- **Audio has never been audible.** It is verified against a stub `AudioContext` only, so node graph correctness is checked and actual sound is not.
- **`render.js` draws are asserted, not rasterised** (jsdom has no canvas backend), so call correctness and argument sanity are checked and pixel output is not.
- Untested expectations: that `swiftshader`/GPU rendering matches this geometry at large viewports, long-session numerical drift beyond 60 s, and mobile/touch behaviour (`touch-action` is set, but no touch device was available).

## Limitations

- The water is deliberately at rest and the trench has no walls: there is no shoreline, and the camera scrolls forever.
- `SurfaceField` is a 1024-cell global height field with a fixed advection speed, so waves do not genuinely disperse; they translate and decay.
- The 22-mass loop is coarse: fast specimens visibly polygonalise, and the area constraint is radial-about-centroid, which is wrong for strongly concave shapes (it is stable, just not exact).
- No saving beyond the seed: phenomena history and metrics reset on reload.
- The physics is tuned for `0 <= y <= 1` and one creature; nothing here generalises to several bodies, and they would not interact.

## Next iteration

**Make the trench a place, with something to chase.** The single strongest missing thing is a food layer: drifting plankton at a seed-dependent depth, which the creature is nudged toward by a weak gradient in its self-drive. That converts the current lovely-but-purposeless idling into *motivated* motion — the creature surfaces to breathe, dives to feed, and the player interrupts a goal instead of pushing a blob. It would also make the depth strata meaningful rather than decorative, and give the audio something to structure: a feeding dive that lands in the `sounding` layer could complete a bar of music. Cheap version: ~150 lines, particles plus a one-term bias in `updateSelfDrive`, plus a "time in layer" metric.

Smaller options, in the order I would take them: pinch-to-scale influence radius on touch; two creatures that share a wake and can be made to interact (the physics core takes a `World` per creature already, but they would not collide); a dorsal fin and gill flare, which need nothing new — `creatureGeometry()` is the only place a body part is defined now; and adaptive substepping so very fast specimens stay smooth without the clamps visibly squashing them.

An export-a-frame button was on this list and is now half-built: `tools/preview.mjs` already rasterises a deterministic frame to PNG from Node, so the browser version is a `canvas.toBlob()` away.
