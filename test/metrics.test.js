'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applicationName, bundleNameFromPath, normalizeName, pickPrimaryDisk
} = require('../src/main/metrics');

/* ---------- bundle resolution ---------- */

test('the outermost bundle wins, because helpers nest inside their parent', () => {
  // A helper carries its own .app inside the parent's; the inner one is not
  // the application the user is running.
  assert.equal(bundleNameFromPath(
    '/Applications/Wispr Flow.app/Contents/Resources/dist/Wispr Flow.app/Contents/MacOS'
  ), 'Wispr Flow');

  assert.equal(bundleNameFromPath(
    '/Users/x/Visual Studio Code.app/Contents/Frameworks/Code Helper (Renderer).app/Contents/MacOS'
  ), 'Visual Studio Code');
});

test('a bundle at the very end of a path is still found', () => {
  assert.equal(bundleNameFromPath('/Applications/Safari.app'), 'Safari');
});

test('paths with no bundle yield nothing rather than guessing', () => {
  assert.equal(bundleNameFromPath('/System/Library/PrivateFrameworks/SkyLight.framework/Resources'), '');
  assert.equal(bundleNameFromPath('/usr/bin'), '');
  assert.equal(bundleNameFromPath(''), '');
  assert.equal(bundleNameFromPath(undefined), '');
  assert.equal(bundleNameFromPath(null), '');
});

test('a helper is attributed to the app that ships it, not to its own name', () => {
  // ChatGPT ships helpers named "Codex". Grouping on the process name files
  // them under an application that is not installed.
  assert.equal(applicationName({
    name: 'Codex (Renderer)',
    path: '/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Versions/152/Helpers/Codex (Renderer).app/Contents/MacOS'
  }), 'ChatGPT');
});

test('the bundle name beats the terse binary name', () => {
  assert.equal(applicationName({
    name: 'Code',
    path: '/Users/x/Visual Studio Code.app/Contents/MacOS'
  }), 'Visual Studio Code');
});

test('two different apps built on the same runtime stay separate', () => {
  // The V1 bug: grouping by binary name merged every Electron app into one row.
  const slack = applicationName({ name: 'Electron', path: '/Applications/Slack.app/Contents/MacOS' });
  const pulse = applicationName({ name: 'Electron', path: '/Applications/Pulse.app/Contents/MacOS' });

  assert.equal(slack, 'Slack');
  assert.equal(pulse, 'Pulse');
  assert.notEqual(slack, pulse);
});

test('without a bundle, the cleaned-up process name is used', () => {
  assert.equal(applicationName({ name: 'WindowServer', path: '/System/Library/Frameworks' }), 'WindowServer');
  assert.equal(applicationName({ name: 'chrome.exe', path: 'C:\\Program Files\\Google\\chrome.exe' }), 'chrome.exe');
  assert.equal(applicationName({ name: 'Code Helper (Renderer)', path: '' }), 'Code');
});

/* ---------- process name grouping (fallback path) ---------- */

test('browser helper processes collapse onto the parent application', () => {
  assert.equal(normalizeName('Google Chrome Helper (GPU)'), 'Google Chrome');
  assert.equal(normalizeName('Google Chrome Helper (Renderer)'), 'Google Chrome');
  assert.equal(normalizeName('Microsoft Edge Helper (Plugin)'), 'Microsoft Edge');
  assert.equal(normalizeName('Code Helper (Renderer)'), 'Code');
});

test('an unresponsive app groups with its healthy self', () => {
  assert.equal(normalizeName('Safari (Not Responding)'), 'Safari');
});

test('ordinary names are left alone', () => {
  assert.equal(normalizeName('WindowServer'), 'WindowServer');
  assert.equal(normalizeName('node'), 'node');
});

test('empty and missing names are handled without throwing', () => {
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName(null), '');
});

/* ---------- volume selection ---------- */

const disk = (mount, size, use) => ({ mount, fs: `dev-${mount}`, size, used: size * use / 100, use });

test('macOS reads the data volume, not the sealed system volume', () => {
  // The bug this guards: "/" on macOS is a read-only 24 GB system volume that
  // reports ~50% full while the disk the user fills sits at 94%.
  const picked = pickPrimaryDisk([
    disk('/', 245107195904, 49.86),
    disk('/System/Volumes/Data', 245107195904, 93.87),
    disk('/System/Volumes/Preboot', 245107195904, 45.99)
  ]);

  assert.equal(picked.mount, '/System/Volumes/Data');
  assert.equal(picked.use, 93.87);
});

test('the data volume is still labelled "/" for the person reading it', () => {
  const picked = pickPrimaryDisk([
    disk('/', 1000, 50),
    disk('/System/Volumes/Data', 245107195904, 93.87)
  ]);
  assert.equal(picked.label, '/');
});

test('Linux uses the root volume', () => {
  const picked = pickPrimaryDisk([disk('/boot', 500, 20), disk('/', 100000, 60)]);
  assert.equal(picked.mount, '/');
  assert.equal(picked.label, '/');
});

test('Windows uses the system drive', () => {
  const picked = pickPrimaryDisk([disk('D:', 900000, 10), disk('C:', 100000, 60)]);
  assert.equal(picked.mount, 'C:');
});

test('with no recognisable root, the largest volume wins', () => {
  const picked = pickPrimaryDisk([disk('/mnt/small', 1000, 10), disk('/mnt/big', 999000, 10)]);
  assert.equal(picked.mount, '/mnt/big');
  assert.equal(picked.label, '/mnt/big');
});

test('no volumes at all returns null rather than throwing', () => {
  assert.equal(pickPrimaryDisk([]), null);
  assert.equal(pickPrimaryDisk(undefined), null);
});
