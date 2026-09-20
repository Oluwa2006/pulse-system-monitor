'use strict';

/**
 * Mounts the real index.html and renderer.js inside jsdom with a stubbed
 * preload bridge, so the renderer is tested as shipped rather than as a
 * refactored subset of itself.
 *
 * jsdom has no layout engine. Anything about size, overflow or how a
 * stretched viewBox distorts its own contents is invisible here and can only
 * be caught by looking at the running app.
 */

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { analyze } = require('../../src/diagnostics/diagnostics');
const { makeSnapshot } = require('./fixtures');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

function mountRenderer() {
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  // 'outside-only' stops jsdom running the <script src> itself, so the
  // bridge can be installed before renderer.js executes.
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  const calls = { ready: 0 };
  let onUpdate = null;
  let onError = null;

  window.pulse = {
    ready: () => { calls.ready += 1; return Promise.resolve({ refreshIntervalMs: 2000 }); },
    onUpdate: (callback) => { onUpdate = callback; },
    onError: (callback) => { onError = callback; }
  };

  // Throws if the renderer throws at load -- which is the point.
  window.eval(fs.readFileSync(path.join(RENDERER_DIR, 'renderer.js'), 'utf8'));

  const document = window.document;

  return {
    window,
    document,
    calls,
    push: (snapshot) => onUpdate(snapshot),
    fail: (error) => onError(error),
    $: (selector) => document.querySelector(selector),
    $$: (selector) => [...document.querySelectorAll(selector)],
    text: (selector) => (document.querySelector(selector) || {}).textContent,
    click: (selector) => document.querySelector(selector).dispatchEvent(
      new window.MouseEvent('click', { bubbles: true })
    )
  };
}

/** A snapshot shaped the way the main process actually sends it. */
function makeFrame(overrides = {}, { events = [], observedMs = 0 } = {}) {
  const snapshot = makeSnapshot(overrides);
  return { ...snapshot, diagnostics: analyze(snapshot), events, observedMs };
}

module.exports = { mountRenderer, makeFrame };
