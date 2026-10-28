/*
 * Entry point: build the concrete collaborators, start the loop, surface
 * failures instead of dying silently.
 *
 * Split from `app.js` so the shell takes its audio object by injection and can
 * be booted in tests without an AudioContext.
 */

import { PondAudio } from './audio.js';
import { PondApp, seedFromSearch } from './app.js';

function audioContextFactory() {
  const ContextClass = window.AudioContext ?? window.webkitAudioContext;
  if (ContextClass === undefined) {
    throw new Error('Web Audio is not available in this browser.');
  }
  return new ContextClass();
}

function reportFatal(error) {
  const panel = document.querySelector('#fatal');
  if (panel !== null) {
    panel.textContent = `Flux Pond stopped: ${error instanceof Error ? error.message : String(error)}`;
    panel.classList.add('show');
  }
}

function boot() {
  const canvas = document.querySelector('#pond');
  if (canvas === null) {
    reportFatal(new Error('canvas #pond is missing from the page'));
    return;
  }

  const audio = new PondAudio(audioContextFactory);
  // A fresh specimen per visit unless a seed is requested, so the URL stays the
  // only source of reproducibility.
  const seed = seedFromSearch(window.location.search, Math.floor(Math.random() * 0x100000000));
  const app = new PondApp(document, canvas, { audio, seed });
  app.attach();

  document.querySelector('#pull').addEventListener('click', () => app.togglePull());
  document.querySelector('#reroll').addEventListener('click', () => app.newCreature());
  document.querySelector('#pause').addEventListener('click', () => app.togglePause());
  document.querySelector('#audio').addEventListener('click', () => void app.toggleAudio());
  document.querySelector('#full').addEventListener('click', () => void app.toggleFullscreen());

  // A thrown frame is reported once and the loop stops: continuing after a
  // render exception would spam the console and burn the GPU.
  let stopped = false;
  const tick = (now) => {
    if (stopped) {
      return;
    }
    try {
      app.frame(now);
    } catch (error) {
      stopped = true;
      reportFatal(error);
      throw error;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // Handle for console use and for the headless page check.
  window.fluxPond = { app, audio };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
