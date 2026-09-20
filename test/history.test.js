'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  History, trendOf, MAX_TRACKED_APPS, TREND_MIN_SAMPLES
} = require('../src/history/history');
const { makeSnapshot, makeProcess, GB, MB, BASE_TIME } = require('./helpers/fixtures');

/* ---------- ring buffer ---------- */

test('samples accumulate and report their span', () => {
  const history = new History();
  for (let i = 0; i < 10; i += 1) {
    history.record(makeSnapshot({ timestamp: BASE_TIME + i * 2000 }));
  }

  assert.equal(history.size, 10);
  assert.equal(history.spanMs, 18000);
});

test('samples older than the window are evicted', () => {
  const history = new History({ windowMs: 10000 });
  for (let i = 0; i < 20; i += 1) {
    history.record(makeSnapshot({ timestamp: BASE_TIME + i * 2000 }));
  }

  assert.ok(history.size <= 6, `kept ${history.size} samples in a 10s window`);
  assert.ok(history.spanMs <= 10000);
});

test('span is zero until there are two samples', () => {
  const history = new History();
  assert.equal(history.spanMs, 0);
  history.record(makeSnapshot());
  assert.equal(history.spanMs, 0);
});

test('per-app series are dropped once the app stops appearing', () => {
  const history = new History({ windowMs: 10000 });

  history.record(makeSnapshot({
    timestamp: BASE_TIME,
    processes: { byMemory: [makeProcess({ name: 'Gone' })] }
  }));
  assert.ok(history.appMemory.has('Gone'));

  // Advance well past the window with a different app present.
  for (let i = 1; i < 12; i += 1) {
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      processes: { byMemory: [makeProcess({ name: 'Present' })] }
    }));
  }

  assert.equal(history.appMemory.has('Gone'), false);
  assert.ok(history.appMemory.has('Present'));
});

test('the number of tracked apps stays bounded', () => {
  const history = new History();
  for (let i = 0; i < 5; i += 1) {
    const apps = Array.from({ length: 40 }, (_, n) =>
      makeProcess({ name: `App${n}`, memoryBytes: n * MB }));
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      processes: { byMemory: apps }
    }));
  }

  assert.ok(history.appMemory.size <= MAX_TRACKED_APPS,
    `tracking ${history.appMemory.size} apps, cap is ${MAX_TRACKED_APPS}`);
});

test('the cap keeps the heaviest apps, not arbitrary ones', () => {
  const history = new History();
  for (let i = 0; i < 3; i += 1) {
    const apps = Array.from({ length: 40 }, (_, n) =>
      makeProcess({ name: `App${n}`, memoryBytes: n * MB }));
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      processes: { byMemory: apps }
    }));
  }

  assert.ok(history.appMemory.has('App39'), 'dropped the largest consumer');
  assert.equal(history.appMemory.has('App0'), false, 'kept the smallest consumer');
});

/* ---------- regression ---------- */

function series(values, stepMs = 2000) {
  return values.map((bytes, i) => ({ t: BASE_TIME + i * stepMs, bytes }));
}

test('a perfect line is measured exactly and fits perfectly', () => {
  // +1 MB every 2 seconds.
  const points = series(Array.from({ length: 200 }, (_, i) => i * MB));
  const trend = trendOf(points, (p) => p.bytes);

  assert.ok(Math.abs(trend.fit - 1) < 1e-9, `fit was ${trend.fit}`);
  assert.ok(Math.abs(trend.slope - MB / 2000) < 1e-6);
  assert.equal(trend.change, 199 * MB);
  assert.equal(trend.confident, true);
});

test('a flat line is not a trend even though it fits a line', () => {
  const trend = trendOf(series(Array(200).fill(4 * GB)), (p) => p.bytes);
  assert.equal(trend.fit, 0);
  assert.equal(trend.confident, false);
});

test('noise with no direction is not confident', () => {
  const values = Array.from({ length: 200 }, (_, i) => 4 * GB + (i % 2 ? 300 : -300) * MB);
  const trend = trendOf(values.map((bytes, i) => ({ t: BASE_TIME + i * 2000, bytes })), (p) => p.bytes);
  assert.ok(trend.fit < 0.6, `noisy series fit ${trend.fit}`);
  assert.equal(trend.confident, false);
});

test('a falling series is never confident, however clean the line', () => {
  const points = series(Array.from({ length: 200 }, (_, i) => (200 - i) * MB));
  const trend = trendOf(points, (p) => p.bytes);

  assert.ok(trend.slope < 0);
  assert.ok(trend.fit > 0.99);
  assert.equal(trend.confident, false, 'freeing memory reported as a trend');
});

test('too few samples is not confident however steep the climb', () => {
  const points = series(Array.from({ length: TREND_MIN_SAMPLES - 1 }, (_, i) => i * GB));
  assert.equal(trendOf(points, (p) => p.bytes).confident, false);
});

test('enough samples over too short a span is not confident', () => {
  // 200 samples, but crammed into 20 seconds.
  const points = series(Array.from({ length: 200 }, (_, i) => i * MB), 100);
  assert.equal(trendOf(points, (p) => p.bytes).confident, false);
});

test('degenerate inputs return null rather than dividing by zero', () => {
  assert.equal(trendOf([], (p) => p.bytes), null);
  assert.equal(trendOf([{ t: 1, bytes: 1 }], (p) => p.bytes), null);
  // Every sample at the same instant: no time axis to fit against.
  const sameInstant = [1, 2, 3, 4].map((bytes) => ({ t: BASE_TIME, bytes }));
  assert.equal(trendOf(sameInstant, (p) => p.bytes), null);
});

test('slope is also reported per hour for readable output', () => {
  const points = series(Array.from({ length: 200 }, (_, i) => i * MB));
  const trend = trendOf(points, (p) => p.bytes);
  // 1 MB per 2s is 1800 MB/hour.
  assert.ok(Math.abs(trend.slopePerHour / MB - 1800) < 1);
});

/* ---------- queries ---------- */

test('growingApps names climbers and ignores steady apps', () => {
  const history = new History();
  for (let i = 0; i < 400; i += 1) {
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      processes: {
        byMemory: [
          makeProcess({ name: 'Leaky', memoryBytes: 500 * MB + i * (2 * GB / 400) }),
          makeProcess({ name: 'Steady', memoryBytes: 3 * GB })
        ]
      }
    }));
  }

  const growing = history.growingApps();
  assert.equal(growing.length, 1);
  assert.equal(growing[0].name, 'Leaky');
});

test('growingApps ignores growth too small to matter', () => {
  const history = new History();
  for (let i = 0; i < 400; i += 1) {
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      processes: { byMemory: [makeProcess({ name: 'Creeper', memoryBytes: 500 * MB + i * MB / 10 })] }
    }));
  }
  assert.equal(history.growingApps().length, 0);
});

test('growingApps ranks the biggest climber first', () => {
  const history = new History();
  for (let i = 0; i < 400; i += 1) {
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      processes: {
        byMemory: [
          makeProcess({ name: 'Small', memoryBytes: 100 * MB + i * (600 * MB / 400) }),
          makeProcess({ name: 'Big', memoryBytes: 100 * MB + i * (4 * GB / 400) })
        ]
      }
    }));
  }

  assert.deepEqual(history.growingApps().map((a) => a.name), ['Big', 'Small']);
});

test('cpuLoadRatio measures how much of the window was hot', () => {
  const history = new History();
  for (let i = 0; i < 100; i += 1) {
    history.record(makeSnapshot({
      timestamp: BASE_TIME + i * 2000,
      cpu: { usage: i < 30 ? 95 : 10 }
    }));
  }

  assert.ok(Math.abs(history.cpuLoadRatio(70) - 0.3) < 0.01);
  assert.equal(history.cpuLoadRatio(99), 0);
  assert.equal(history.cpuLoadRatio(0), 1);
});

test('cpuLoadRatio on an empty history is zero, not NaN', () => {
  assert.equal(new History().cpuLoadRatio(70), 0);
});

test('snapshots missing storage or network do not throw', () => {
  const history = new History();
  const partial = makeSnapshot();
  delete partial.storage;
  delete partial.network;

  assert.doesNotThrow(() => history.record(partial));
  assert.equal(history.size, 1);
});
