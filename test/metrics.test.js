'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeName, pickPrimaryDisk } = require('../src/main/metrics');

/* ---------- process name grouping ---------- */

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
