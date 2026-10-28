# Flux Pond

A procedurally generated buoyant creature in a shallow, stratified trench that you steer with cursor pressure — and a toy about one specific emergent thing: **a body floating at a waterline**. It also gets hungry, and has to dive into the plankton layer to eat, which is the difference between a balloon that bobs and an animal with somewhere to be — and below the plankton band something bigger is sitting in the dark, which is what turns somewhere to be into a decision.

It is a closed loop of point masses joined by springs, with real Archimedes buoyancy, drag, a floor, and a surface height field that the creature itself disturbs. Nothing about the motion is animated: swimming, breaching, skimming, bouncing off the floor and the wake you leave behind are all consequences of the same force law. Every creature is derived from a seed, so `?seed=...` reproduces one exactly.

## Run it

```bash
python3 serve.py
```

then open <http://127.0.0.1:8000/>.

ES modules are loaded over `http://`, so opening `index.html` with `file://` will not work — the browser refuses the imports. Any static server is fine (`python3 -m http.server 8000`); `serve.py` sets the MIME types that make a wrong one a blank page, and prints the URL. `PORT=8123 python3 serve.py` changes the port. Verified: `/` comes back `200 text/html`, `src/main.js` and `src/flux-pond.js` come back `200 text/javascript`, and a missing path 404s.

No build step, no dependencies, no network access at runtime: no fonts, libraries, samples or images are fetched.

## Controls

| Input | Effect |
| --- | --- |
| Move the cursor | Pushes the creature away from the cursor within the visible ring |
| Press / hold | Pushes harder: 0.55 hovering, 1.0 pressed. The field swells and subsides through a ramp either way, and the ring is painted from the same number, so what you see is what it is getting |
| **Shift**-drag or **right**-drag | **Pull** instead of push — this is how you make it dive |
| `R` | New specimen (a new seed is written to the URL) |
| `Space` | Pause / resume |
| `A` | Audio on / off |
| `H` | Hide the help panel |

Audio is off until you click, because browsers forbid starting it before a gesture. The drone is the specimen's own chord through a low-pass filter that follows depth, so diving muffles it; each time a mass breaks the surface it plays a note whose pitch comes from the impact speed, which is where the rhythm comes from. Underneath both, a sub-bass pulse follows how close the lurker is — silent at the surface, a slow throb that quickens as it closes, which is the one warning that works when you are not looking into the dark.

## What to try

- **Park the cursor just under the creature and hold.** Pushed from below it pins itself against the surface: `skimming`, then `skittering` along the underside of it. Press, and it comes out of the water — held there, one seed spent 31 of 40 s airborne and crossed the surface hundreds of times.
- **Shift-drag to the floor, then let go.** A body lighter than water and pressed against a floor rebounds, and `floor bounce` lights up (44 of them in 18 s of pulling). Hold the dive longer and the rebound on its own is fast enough to light `breach` — measured at 12 s down, 7 breaches from the release alone.
- **Stay still.** After ~2 s the creature swims by itself, with a travelling wave along its body, and leaves a wake you did not cause. Watch a little longer and it turns nose-down and commits to the plankton layer; each bite is a note, and it shoots back up to the surface when it has had enough.
- **Intercept a hunt.** Pull it off a feeding dive and let go — it picks the same mote back up. That is the whole loop of the thing: it has a goal you are interrupting, rather than a blob you are pushing.
- **Take it down past the plankton and hold it there.** Below a lair depth that varies by seed (0.40–0.62) something is sitting in the dark, and it comes toward anything that lingers in its band: a hard 14 s dive spends 10.2 s inside its threat radius across 8 seeds and turns into 8 flights. You will see the eye well before then — a big dark fish with a lit back, and its eye glows as it notices you; with audio on, a sub-bass pulse rises out of the mix as it closes (built and asserted against a stub — see *What the browser settled, and what it did not* — so nobody has heard it yet). It will not follow you up, so the way out is up, and a specimen frightened at depth breaches on its way.
- **Compare the standing waves.** Move at a steady speed and the wake locks into a fixed pattern relative to you; stop, and the trench keeps sloshing.
- **Roll a few seeds.** Specimens differ in silhouette, mass distribution, size, hue and musical key, which changes how they swim: a bulged forebody is heavy at the front and pitches nose-down when it slows.
- **Watch the tail.** The eye sits at the thickest part of the body and its pupil turns with the drift; the caudal fin is anchored to four real outline masses at the other end, so it swings with the travelling wave rather than being animated separately. Neither is skinned or keyframed — when the body folds, they fold with it.

## How it works

- `src/flux-pond.js` — the whole simulation, with no DOM, canvas or audio. A closed loop of 22 masses with perimeter, structural and bend springs, a radial area-preservation term, per-mass buoyancy/drag/meniscus forces, a pointer force, a `SurfaceField` height field, and the plankton layer the creature feeds on. Fixed 120 Hz substeps with velocity and step clamps.
- `src/render.js` — draws a `World` into an injected 2D context. Owns no state: the sunlight shafts, the bubble string and the plankton all have to be functions of the frame they are drawn from, which is also why a pinned frame is reproducible. `creatureGeometry()` is the single definition of where the eye, the body and the tail fin are, and both the canvas renderer and the offline preview draw from it.
- `src/audio.js` — Web Audio graph built from the specimen's chord; the injected-context design is what makes it testable without an audio device.
- `src/app.js` — fixed-timestep frame loop, input mapping, and the read-out panel. Holds no physics state.
- `src/main.js` — constructs the concrete collaborators, starts the loop, reports failures instead of dying silently.
- `tools/preview.mjs` — rasterises one frame to a PNG with no browser. It is a second painter over `creatureGeometry()`, so the creature's proportions in it are the ones the canvas draws. Dev aid only; no check depends on it.

Four ideas worth knowing about, because they are where the behaviour comes from:

**Buoyancy is derived, not tuned.** The lift term is computed as `gravity / floatTrim` where it is applied rather than stored as a second tunable, which puts the Archimedes equilibrium — where the wetted fraction of the body equals `floatTrim` — exactly at the intended riding depth. Measured over 110 s per seed, the mean wetted fraction lands on the designed value to within about one percent.

**The fluid is at rest.** An earlier revision had a background current, which acted as a permanent force: drag against it never vanished, so the creature could never settle and orbited forever in a limit cycle. Forward motion now comes only from the pointer pushing against stationary water, and the sense of speed comes from parallax in the strata.

**Ripples are caused by the creature.** A wave is injected only when a mass crosses the free surface, at an amplitude set by its crossing speed. There is no decorative wake.

**Hunger moves the steering target; it does not add a force.** The idle creature already had one body-wide steering acceleration aimed at the surface. A hungry creature aims the same controller at the nearest mote and blends its heading toward it. One exception was unavoidable: a fully submerged body is accelerated upward at `gravity / floatTrim - gravity` = 8.5, so diving needs a term that cancels that excess buoyancy — which is what fins are for. Without it a hungry creature just bobbed and starved, measured at 0–3 bites in 120 s; with `diveThrust` cancelling the excess it manages 11–13 (re-measured at 60 Hz and 120 Hz over seeds 42, 7, 145, 20261027).

**Fear uses the same controller as hunger, and the lurker adds no force at all.** The thing in the deep has no springs, no buoyancy, no mass, no appetite and no way to be hurt. It is a position that homes slowly toward anything lingering below its lair, published to the World every substep, and all it is allowed to change is the *target*: the depth controller that aims at the surface is aimed just past it, the heading blends away, and the drive goes to full even while a cursor is holding the body — an animal being dangled should still want to leave. Kinematic rather than simulated also means it costs the solver nothing, and a replay puts it in the same place.

**The plankton are generated, not stored.** The trench is endless, so each cell of world x hashes to up to three motes inside a seed-dependent band. Only two things are remembered — which motes have been grazed, and when they regrow — so swimming forever cannot grow the state, and any stretch of trench is reproducible from the seed alone.

`WORLD` and `FOOD` at the top of `src/flux-pond.js` are the tuning surface; `PHENOMENA` holds the detection thresholds and `LURKER` the lair depth, the threat radius and how far above the lair the threat still counts. The comments say which of those numbers were measured rather than tasted, and what the measurement was.

## Checks

```bash
tools/check.sh            # syntax + all automated tests (~40 s, the stability sweeps dominate)
tools/check.sh --browser  # additionally drive the real page in headless Chromium
```

`tools/check.sh` needs Node, found on `PATH` or in the Nix store (`tools/toolchain.sh`). It runs `node --check` over every source file and then four test files:

- `tests/sim.test.mjs` (40) — determinism, including a reset replay that has to match a first boot of the same seed to 1e-9, a 600-seed × 30 s stability sweep, hostile input, degenerate frame times, floating at the designed trim, floor impenetrability, area preservation, wake causality, surface-field advection and saturation, hysteresis of every phenomenon, audio helper maths. Plus: a new specimen starts **stress-free** (every spring's rest length equals the distance it was built at), the body still matches its built perimeter spacing after 12 s, the nose/tail are fixed material indices opposite each other, and the feeding layer — hunting deepens the creature compared with the same seed on an empty trench, hunger rises and a bite knocks it down, grazed motes stay gone until they regrow, the field is endless and identical across two runs of one seed, and the grazed-mote memory cannot grow without bound. Five more cover the lurker: that it is a place and the same seed puts it in the same place; that lingering in the dark is noticed, that fear can fire while a cursor still holds the body, and that one flight counts as one event; that fear only exists in its own depth band; that it never rises off its lair; and that an animal left alone almost never meets it and keeps feeding.
- `tests/render.test.mjs` (11) — renders through a recording 2D context across 120 seeds and degenerate viewport sizes, asserting no non-finite draw argument, no negative radius, balanced `save`/`restore`, and that the camera maps screen↔world space invertibly. Plus four on `creatureGeometry()`: finite at every viewport size, eye sized against the *projected* body, tail fin attached to real outline masses and pointing backwards, and the fin polygon free of self-intersections across 60 seeds.
- `tests/audio.test.mjs` (12) — against a stub `AudioContext`, including an impact west of the origin where the wave index is negative: nothing is touched before a gesture, one oscillator per chord tone plus the two presence voices and no more after 200 presence updates, voice budget respected under 500 impacts in an instant, filter cutoff stays audible across the depth range. The presence curve is asserted by shape rather than existence: exactly zero below its floor, monotonic as the lurker closes, capped below the chord it must not swallow, and a pulse that quickens without becoming a buzz. A `NaN` or `Infinity` nearness is asserted to produce silence rather than reach an `AudioParam`. Two more cover the bed's key: after a retune every chord voice is in the new specimen's chord and the impact notes are pitched off it (the audible half, which is the half nothing else could catch), and a specimen with an unusable chord is refused outright rather than half-applied, because the drone's chord is also where impact notes come from.
- `tests/app.test.mjs` (12) — boots `index.html` verbatim in jsdom, checks that pressing swells the pointer field where hovering does not, and checks the app/marker agreement in both directions (no id the app reads is missing, no id the page declares is dead), that frames populate the read-out, that pointer input moves the creature and generates wake, that shift selects pull, that pause freezes and resumes, that audio only starts on a gesture, that a reroll hands the audio layer the specimen that is now swimming rather than leaving the bed on the old key, and that every module `index.html` loads resolves on disk (jsdom does not fetch `src=` modules, so a renamed file is a blank page nothing else would catch).

These found every real bug listed under *Verified* below.

### In a browser

`tools/check.sh --browser` runs `tools/browser-check.mjs` through `tools/run-browser-check.sh`, which points Playwright at the Chromium in the Nix store and answers `https://fluxpond.test/**` from disk, so no socket is bound. Beyond the behavioural assertions it pins **four golden frames**, and logs the read-out of each so the image and the numbers can be checked against each other:

| frame | the state | what it is there to catch |
| --- | --- | --- |
| `idle-5s` | settled at the waterline, gliding | the default look, and every panel where it belongs |
| `hunt-40s` | 40 s later: hunger 72 %, working the plankton band | the feeding layer, the depth tint, the `photic` label |
| `tow-10s` | held for 10 s by a pull toward the floor | a submerged body, two badges lit at once, the cursor ring |
| `lurker-2s` | 2 s of held press at full strength: depth 0.40, the lurker at arm's length, `fleeing` lit, `flights` 1 | the lurker at close range, and the counter that only the lurker moves |

A frame is made deterministic by pausing the loop, resetting the world and advancing a fixed number of fixed steps, so an image depends on the seed and not on how long the machine took to paint, and the read-out is refreshed for the frame rather than left at whatever the last 500 ms window painted. Comparison tolerates 3 % of pixels moved and a mean channel delta of 1.5: a panel that moves or disappears is tens of thousands of pixels, a badge's 160 ms pop animation is half a per cent.

```bash
tools/recapture-golden.sh .tmp/review   # record frames somewhere for review
tools/recapture-golden.sh               # ... and into tests/golden
```

That script runs Chromium **twice** on purpose: the first session records, the second compares against what the first left. Frames that agree across two sessions — different wall clocks, different frame rates, different `requestAnimationFrame` timing — are pinned to the seed rather than to the machine's mood. On this host two sessions agree to within 0.023 % of pixels on all four frames — the residual is the fps and counter digits, and a third run moved 0.006 % of one: the fps digits, the only number on screen that describes the machine instead of the seed. The last real source of drift was in the renderer rather than the test — the cursor ring pulsed off `Date.now()`, which is why everything the painter draws now depends on simulated time alone — and the 3 % budget is left as tolerance for antialiasing on other machines.

## Verified

Observed, on Node v24.20 with the current patch: **75 automated checks pass** (`tools/check.sh`) — 40 simulation, 11 render, 12 audio, 12 app — plus `node --check` on all 12 source/test/tool JS files. **And 26 checks pass in headless Chromium** (`tools/check.sh --browser`), on the real page over `https://`, including the four golden frames.

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

12. **A negative wave index fed `NaN` to an `AudioParam` and stopped the page.** `playImpact` indexed `frequencies` with `event.waveIndex % len`, and that index is `Math.round(ripple.x * 3)` — negative half the time in a trench that runs west forever — so `frequencies[-2]` was `undefined`, `setValueAtTime(undefined)` produced `NaN`, and the browser threw. `main.js` deliberately stops the frame loop after a throw, so swimming left of the origin killed the toy. Fixed with a real modulo (`((i % n) + n) % n`).
13. **The audio tests could not fail.** The helper called the async test bodies without awaiting them, so every assertion after an `await` was discarded: that is how bug 12 lived inside a file that claimed to cover it. Awaiting the eight bodies surfaced three failures that had never once been seen — including bug 12, and a cutoff test reading a property the stub never recorded. A check that cannot fail is worse than no check, because it is also evidence.
14. **Two panels had no `position`, and only a browser could have noticed.** `#buttons` and `#phenomena` are deliberately not `.panel`s, so they inherited no positioning and fell into static layout at the top-left, underneath the read-out: hit-testing the New specimen button returned `#status`, so it could not be clicked, and the phenomenon badges were invisible. Twenty-two render and app assertions were entirely content with this. Playwright found it by clicking.
15. **`reset()` leaked the steering brain, so a new specimen inherited the last one's momentum.** It rebuilt the body, the field and the plankton, but not `idleSeconds`, `selfDrive`, `driveHeading`, `straightness` or `previousCentre` — nor `wanderPhases`, which are *derived from the seed*, so a rerolled creature swam with the previous specimen's wander. The `?seed=` promise of an exact replay was simply false. `World`'s constructor and `reset` now share one initialisation path, and a test compares a reset replay with a first boot to 1e-9.
16. **Pressing did nothing.** Both the hint and the comment above the code say pressing pushes harder; the pressure ramp keyed only on the cursor being in the window, so a hover was already at full strength and `pointerdown` set nothing the force used. Hover is now 0.55 and press 1.0 — which also stops every tow starting at maximum differential stretch (strain ~2.0 against ~2.8 over 10 s) — and a test asserts press > hover > released.

The browser check itself had five bugs and had never run to completion: it read `#name` where the element is `#species`, probed `d[4]` of an RGBA pixel, sampled `app.fps` a few frames after boot (it is a 500 ms average), asserted that a click enables audio after a canvas gesture already had, and measured *net* displacement after a deliberately closed-loop wiggle. Worth listing because a check nobody has ever run is a hypothesis, not a guarantee.

Two design corrections found by measurement rather than by a failing test: the background current described above, and pointer strength (a squared falloff left ~1.5 acceleration at one body-radius against 12.9 buoyancy, so the floor was unreachable and most phenomena could not be triggered; measured top speed went from 0.59 to ~2.4).

All six phenomena — `skimming`, `breach`, `skittering`, `gliding`, `sounding layer`, `floor bounce` — were observed to trigger across several seeds with a generic push/pull drive.

Numbers behind the feeding layer, measured by running seeds idle for 120–150 s. The `after` column was re-measured for this revision and came in at 11–13 (the same at 60 Hz and 120 Hz, and 12–13 across eight seeds); an earlier version of this table claimed 15–21, which nothing reproduces now, and a stale number in a README is a bug like any other.

| | before dive thrust | after |
| --- | --- | --- |
| bites per 120 s (seeds 42, 7, 145, 20261027) | 2, 0, 1, 3 | 11–13 |
| mean wetted fraction idle | 0.45–0.46 | 0.47–0.80 (deep-band seeds wetter by design) |

Two existing tests had to change, and both changes were the test encoding an old limitation rather than a regression:

- *floats at its designed trim* now runs `new World({ seed, food: false })`. Hunger is precisely a reason to leave the waterline, so measuring Archimedes on a creature that has somewhere to be measures two things at once. The empty-trench case is what that invariant is about, and it still lands on `floatTrim`.
- *idle creatures remain bounded across many seeds* asserted one instantaneous sample, `0 < immersion < 1`, which the working hunger dive failed on seed 2. It now samples the whole 45 s and asserts what was meant: finite, in the column, not dry for a quarter of the run, not settled on the floor, not permanently sunk.

## What the browser settled, and what it did not

Observed in headless Chromium (Playwright, `--use-gl=swiftshader`, 1024×640, `?seed=20261027`): the page loads over `https://` with no page or console errors for the whole session; the canvas is neither blank nor black (probed every 23×17 px, >10 distinct colours, mean luma above 4); the loop reports ~60 fps; cursor input moves the creature and raises wake events; the HUD follows; `Shift`-drag gets it below the surface; `R` rerolls the seed and rewrites the URL; a canvas gesture is what switches audio on, the audio button toggles state and label, and the graph builds (drone voices > 0) without an exception; the plankton layer is live; the four golden frames match. See bug 14 for the one thing every non-browser assertion was happy about.

Chromium needs escalated permission here: this container gives it no user namespace, so it runs `--no-sandbox`, and the browsers come out of the Nix store because nothing can be downloaded. The automated check answers requests through `page.route` from disk rather than binding a socket, so nothing in `tools/check.sh` goes through `serve.py` — it was verified separately, by binding it and requesting the page and its modules with `curl` (see *Run it*).

Still needs a person rather than a harness:

- **Whether it looks and feels good.** The goldens pin four instants. The motion, the colour balance, the `backdrop-filter` panels, and whether 60 fps survives real hardware (all of this was software-rasterised) are judgement calls, not assertions.
- **Whether it makes a sound.** Audio has been *constructed* in a real browser — nodes built, voices started and stopped, no exceptions — and validated against a stub elsewhere. Headless Chromium has no audio device, so nobody has heard any of it, including the presence pulse, whose levels and rates are known only from what the stub recorded. If the sub-bass is inaudible on laptop speakers or swamps the chord, `PRESENCE` in `src/audio.js` is the one place to change it.
- **Touch.** `touch-action: none` is set, everything routes through pointer events, and `pressing` comes from `pointerdown`, which fires for touch. All of that is an inference; no touch device has driven it.
- **Hours rather than seconds.** 60 s of simulation runs headless with nothing adrift; longer has not been observed.
- **Pixels outside those three frames.** `render.js` is asserted through a recording 2D context — jsdom has no canvas backend — so the goldens are the only moments the real rasterisation has been looked at, at one viewport and one seed.

## Limitations

- The plankton do not swim, swarm, or react to the wake — they bob in place and are eaten. Nothing eats the creature, and hunger has no consequence beyond steering: it cannot starve, and it cannot die.
- The water is deliberately at rest and the trench has no walls: there is no shoreline, and the camera scrolls forever.
- `SurfaceField` is a 1024-cell global height field with a fixed advection speed, so waves do not genuinely disperse; they translate and decay.
- The 22-mass loop is coarse: fast specimens visibly polygonalise, and the area constraint is radial-about-centroid, which is wrong for strongly concave shapes (it is stable, just not exact).
- No saving beyond the seed: phenomena history and metrics reset on reload.
- The lurker is not an animal. It has no body, no appetite, and no way to be hurt, and it ignores the wake, the plankton and any other lurker: one per trench, placed by the seed, homing at a constant speed. That is enough to make the deep feel inhabited; it is not a predator to outwit.
- Safety is absolute. It will not rise off its lair, so a specimen that reaches the light cannot be touched, which makes the risk a decision to abort rather than a threat to manage. The version where it can follow you in, or where it can be driven off, is not here.
- The influence field is anchored in world space, so holding the cursor still lets the ring slide off the creature as the camera follows it. Deliberate — a field that snapped along with the camera would be feedback nobody could read — but it means steering by where you leave the cursor, not by where you point at the animal.
- A press is a strong local gradient with no yield limit: hold one against the creature and the loop stretches, because the pointer force acts on each mass separately and the body resists area, not length (strain ~2.8 over 10 s at full press, against ~2.0 hovering).
- The counters — travel, ripples, fed, breaches — are session totals and survive `R` on purpose, so after a reroll they describe the séance rather than the specimen.
- The physics is tuned for `0 <= y <= 1` and one creature; nothing here generalises to several bodies, and they would not interact.

## Next iteration

**Make the cost a gradient, not a threshold.** The lurker made the deep somewhere you choose to go, but the cost is still binary: inside its band or out, and outside it the trench is free. The next step is a term that is always on — drive authority and bite relief falling off with depth, so the richest plankton is worth less and costs more even when nothing is watching. One more term in the same steering blend, and the strata become a risk/reward map readable with no animals in them at all.

The versions of that idea, cheapest first:

- **Condition, not just appetite.** Feeding accumulates into a body condition that shows as size and hue saturation, so a well-fed specimen is visibly fatter and rides higher — Archimedes doing the storytelling, since a bigger body changes the trim by itself.
- **One competitor.** Two creatures already share the trench's surface field, so a second specimen hunting the same grazed-out patch is mostly free; they would not collide, which is its own follow-up.
- **Finish the music idea.** A dive that ends with a bite inside a given stratum could land on the beat and complete a bar; the note and the layer are both already known to the audio layer.

Smaller options: pinch-to-scale influence radius on touch; a dorsal fin and gill flare, which need nothing new because `creatureGeometry()` is the only place a body part is defined; and adaptive substepping, so very fast specimens stay smooth without the clamps visibly squashing them.

An export-a-frame button is half-built: `tools/preview.mjs` already rasterises a deterministic frame to PNG from Node, so the browser version is a `canvas.toBlob()` away.
