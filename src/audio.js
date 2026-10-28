/*
 * Procedural soundtrack for Flux Pond.
 *
 * Everything is synthesised: no samples, no network. Three ideas carry it.
 *
 *  - The creature's own chord (from its seed) plays through a low-pass filter
 *    whose cutoff follows depth, so diving audibly darkens the timbre and
 *    surfacing brightens it -- the player hears the water column.
 *  - Wetting events drive a percussive voice whose pitch comes from the impact
 *    speed. Because the physics decides when a mass crosses the surface, the
 *    rhythm is emergent: paddle and you get a pattern; rest and you get the
 *    drone alone.
 *  - A sub-bass presence voice, pulsed by an LFO, follows the lurker's nearness.
 *    It is the only channel that can warn you about something you are not looking
 *    at, and at a distance its level is exactly zero rather than faint.
 *
 * The AudioContext is injected, so this module can be unit-tested with a stub
 * (see `tools/test-audio.mjs`) and never constructs audio hardware on import --
 * browsers require a user gesture before audio may start anyway.
 */

const VOICE_LIMIT = 8;

/*
 * The presence voice: how loud, and how fast it throbs, at the two ends of the
 * lurker's nearness. `floor` is why a specimen at the surface hears nothing at
 * all rather than a permanent hum -- below it the level is exactly zero.
 */
const PRESENCE = {
  peak: 0.18,
  idlePulse: 0.35,
  huntPulse: 3.1,
  floor: 0.06
};

class PondAudio {
  constructor(contextFactory) {
    this.contextFactory = contextFactory;
    this.context = null;
    this.master = null;
    this.drone = null;
    this.enabled = false;
    this.voiceBudget = VOICE_LIMIT;
    this.lastNoteTime = -1;
    this.specimen = null;
  }

  /*
   * Called from a click/keypress: the only legal moment to create a context.
   *
   * The context is built once and reused. Browsers cap live AudioContexts (on
   * the order of six per page) and creating one per toggle would exhaust the
   * cap and break audio permanently, so mute/unmute only ramps the master gain.
   */
  async enable() {
    if (this.enabled) {
      return true;
    }
    if (this.context === null) {
      const context = this.contextFactory();
      const master = context.createGain();
      master.gain.value = 0.0;
      master.connect(context.destination);
      this.context = context;
      this.master = master;
    }
    const context = this.context;
    this.enabled = true;
    if (context.state === 'suspended') {
      await context.resume();
    }
    this.master.gain.cancelScheduledValues(context.currentTime);
    this.master.gain.linearRampToValueAtTime(0.35, context.currentTime + 1.2);
    return true;
  }

  disable() {
    if (!this.enabled) {
      return false;
    }
    const context = this.context;
    const master = this.master;
    // Mute by ramping the master gain, and leave the drone running behind it.
    // Stopping the oscillators would need a teardown timer, and because
    // `startDrone` refuses to build a second bed, a stopped drone could never
    // be heard again after a second toggle. Silent-but-alive is both simpler
    // and idempotent.
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.linearRampToValueAtTime(0.0, context.currentTime + 0.3);
    this.enabled = false;
    return true;
  }

  /*
   * Start the sustained bed: one oscillator per chord tone, detuned slightly so
   * they beat against each other, all through a shared low-pass that tracks
   * depth. Voices are cheap sawtooth-into-filter, which is where the "underwater"
   * colour comes from.
   */
  startDrone(specimen) {
    if (!this.enabled || this.drone !== null) {
      return false;
    }
    const context = this.context;
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 3.0;
    const bed = context.createGain();
    bed.gain.value = 0.16;
    filter.connect(bed);
    bed.connect(this.master);

    const oscillators = [];
    for (let index = 0; index < specimen.chords.length; index += 1) {
      const oscillator = context.createOscillator();
      oscillator.type = index % 2 === 0 ? 'sawtooth' : 'triangle';
      oscillator.frequency.value = specimen.frequencies[index];
      // Small detune per voice: beating keeps a static chord from sounding flat.
      oscillator.detune.value = (index % 2 === 0 ? 1.0 : -1.0) * (4.0 + index * 3.0);
      const voice = context.createGain();
      voice.gain.value = 0.9 / specimen.chords.length;
      oscillator.connect(voice);
      voice.connect(filter);
      oscillator.start();
      oscillators.push(oscillator);
    }
    /*
     * The lurker, heard before it is seen: one sub-bass voice in the specimen's
     * own key, pulsed by a slow LFO that speeds up and swells as it closes. This
     * is the only warning that arrives when you are not looking into the dark --
     * and you are usually not.
     *
     * Built with the bed rather than on demand, for the reason the bed is never
     * stopped: `startDrone` refuses to build a second one, so a voice torn down
     * could never be heard again. What moves is the level, and at zero nearness
     * the voice is silent rather than absent.
     */
    const presence = context.createGain();
    presence.gain.value = 0.0;
    presence.connect(this.master);
    const sub = context.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = specimen.root / 2.0;
    sub.connect(presence);
    sub.start();
    // Amplitude modulation rather than a filter sweep: an oscillator wired into
    // a gain node's `gain` param sums with that node's own value, so half the
    // level as the intrinsic value and half as the modulation depth swings the
    // voice 0 -> peak -> 0 without the gain ever going negative.
    const pulse = context.createOscillator();
    pulse.type = 'sine';
    pulse.frequency.value = PRESENCE.idlePulse;
    const pulseDepth = context.createGain();
    pulseDepth.gain.value = 0.0;
    pulse.connect(pulseDepth);
    pulseDepth.connect(presence.gain);
    pulse.start();

    this.drone = { filter, bed, oscillators, specimen, presence, sub, pulse, pulseDepth };
    return true;
  }

  /*
   * Put the bed in the key of the specimen that is now swimming: build it if
   * there is none, glide the existing voices if there is.
   *
   * Glide rather than rebuild because an oscillator cannot be restarted, and a
   * specimen that arrives by sliding into its own key is the right sound anyway.
   * The cost of never tearing voices down is that the voicing count stays
   * whatever the first specimen asked for, with the new chord cycled over it --
   * specimens have four or five tones, so a bed of five playing a chord of four
   * doubles one tone. `startDrone` alone left every specimen after the first
   * swimming in the previous one's key, and every impact note with it.
   */
  retune(specimen) {
    if (this.drone === null) {
      return this.startDrone(specimen);
    }
    const frequencies = specimen.frequencies;
    // All of it or none of it: a specimen whose chord is unusable must leave the
    // bed where it is, because the drone's chord is also what the impact notes
    // are drawn from, and half a retune is a NaN on an AudioParam.
    if (!Array.isArray(frequencies) || frequencies.length === 0) {
      return false;
    }
    for (const frequency of frequencies) {
      if (!Number.isFinite(frequency) || frequency <= 0.0) {
        return false;
      }
    }
    const context = this.context;
    for (let index = 0; index < this.drone.oscillators.length; index += 1) {
      this.drone.oscillators[index].frequency.setTargetAtTime(
        frequencies[index % frequencies.length],
        context.currentTime,
        0.15
      );
    }
    if (Number.isFinite(specimen.root) && specimen.root > 0.0) {
      this.drone.sub.frequency.setTargetAtTime(specimen.root / 2.0, context.currentTime, 0.15);
    }
    // Impact and phenomenon voices read the chord off the drone, so this is what
    // stops a reroll from playing the old specimen's notes.
    this.drone.specimen = specimen;
    return true;
  }

  /*
   * How close the thing in the deep is, on the World's 0-1 nearness. A level
   * curve steeper than linear (1.6), so it stays below hearing until it is
   * genuinely close and then arrives quickly, and a pulse rate that rises with
   * it: distance is loud, proximity is a throb.
   */
  updatePresence(nearness) {
    if (!this.enabled || this.drone === null) {
      return false;
    }
    // Non-finite in, silence out. The one time this module let a NaN through to
    // an AudioParam it took the animation loop down with it, and a lurker that
    // cannot be located is not a reason to stop the water moving.
    const near = Number.isFinite(nearness) ? Math.min(1.0, Math.max(0.0, nearness)) : 0.0;
    const level = near < PRESENCE.floor ? 0.0 : PRESENCE.peak * Math.pow(near, 1.6);
    const context = this.context;
    this.drone.presence.gain.setTargetAtTime(level * 0.5, context.currentTime, 0.25);
    this.drone.pulseDepth.gain.setTargetAtTime(level * 0.5, context.currentTime, 0.25);
    this.drone.pulse.frequency.setTargetAtTime(
      PRESENCE.idlePulse + (PRESENCE.huntPulse - PRESENCE.idlePulse) * near,
      context.currentTime,
      0.4
    );
    return true;
  }

  /*
   * Depth drives the filter cutoff on a perceptual (log) scale: shallow is
   * bright, deep is muffled, matching how a real water column absorbs highs.
   */
  updateDepth(immersion, speed) {
    if (!this.enabled || this.drone === null) {
      return;
    }
    const context = this.context;
    const depth = Math.min(1.0, Math.max(0.0, 1.0 - immersion));
    const cutoff = 180.0 * Math.pow(2.0, 4.0 * (1.0 - depth));
    const motion = 1.0 + Math.min(1.5, speed) * 0.6;
    this.drone.filter.frequency.setTargetAtTime(
      Math.min(9000.0, cutoff * motion),
      context.currentTime,
      0.08
    );
    this.drone.bed.gain.setTargetAtTime(0.10 + 0.12 * Math.min(1.0, speed), context.currentTime, 0.2);
  }

  /*
   * One percussive voice per wetting event. Pitch rises with impact speed, so a
   * gentle paddle ticks and a breach thuds; `waveIndex` picks a chord tone so
   * repeated hits stay consonant no matter how the player spams the pointer.
   */
  playImpact(event) {
    if (!this.enabled || this.drone === null) {
      return false;
    }
    const context = this.context;
    if (this.voiceBudget <= 0) {
      return false;
    }
    this.voiceBudget -= 1;
    const now = context.currentTime;
    if (now - this.lastNoteTime < 0.028) {
      this.voiceBudget += 1;
      return false;
    }
    this.lastNoteTime = now;

    const spec = this.drone.specimen;
    /*
     * `waveIndex` is derived from the creature's world x, and the trench is
     * endless, so it is negative about half the time. JS `%` keeps the sign of
     * the dividend, so -7 selected `frequencies[-2]` -- undefined -- and NaN
     * reached setValueAtTime, which a real browser throws on, killing the loop.
     * Mapping an arbitrary index onto the chord is audio's business, so it is
     * normalised here rather than at every call site.
     */
    const degrees = spec.frequencies.length;
    const degree = ((event.waveIndex % degrees) + degrees) % degrees;
    const octaveShift = event.strength > 1.2 ? -1 : 0;
    const frequency = spec.frequencies[degree] * Math.pow(2.0, octaveShift);

    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency * 2.0, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(30.0, frequency), now + 0.09);

    const gain = context.createGain();
    const peak = Math.min(0.5, 0.08 + event.strength * 0.16);
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(peak, now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.42);

    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.45);
    const pool = this;
    oscillator.onended = () => {
      pool.voiceBudget = Math.min(VOICE_LIMIT, pool.voiceBudget + 1);
    };
    return true;
  }

  /*
   * A brief rising blip when a phenomenon latches, so the on-screen badge is
   * accompanied by sound rather than being purely visual.
   */
  playPhenomenon(kind) {
    if (!this.enabled || this.drone === null) {
      return false;
    }
    const context = this.context;
    const now = context.currentTime;
    const base = this.drone.specimen.frequencies[0] * 4.0;
    const oscillator = context.createOscillator();
    oscillator.type = 'triangle';
    const ratio = kind === 'breach' ? 1.5 : kind === 'dive' ? 0.6 : kind === 'feed' ? 2.0 : 1.0;
    oscillator.frequency.setValueAtTime(base * ratio, now);
    oscillator.frequency.exponentialRampToValueAtTime(base * ratio * 1.34, now + 0.18);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0005, now + 0.5);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.52);
    return true;
  }
}

/*
 * Attach chord frequencies to a specimen. Kept here rather than in the physics
 * core so the simulation stays free of audio concerns.
 */
function withFrequencies(specimen, noteFrequency) {
  const root = 110.0 * Math.pow(2.0, (specimen.hue % 3) / 3.0);
  const frequencies = specimen.chords.map((degree) =>
    noteFrequency(root, specimen.scaleName, degree)
  );
  return { ...specimen, root, frequencies };
}

export { PondAudio, withFrequencies, VOICE_LIMIT, PRESENCE };
