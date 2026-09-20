'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyze, THRESHOLDS } = require('../src/diagnostics/diagnostics');
const { History } = require('../src/history/history');
const { makeSnapshot, makeProcess, byResource, GB, MB, BASE_TIME } = require('./helpers/fixtures');

test('a healthy machine reports GOOD with one ok finding per resource', () => {
  const { health, findings, levels } = analyze(makeSnapshot());

  assert.equal(health.level, 'ok');
  assert.equal(health.label, 'GOOD');
  assert.deepEqual(levels, { cpu: 'ok', memory: 'ok', storage: 'ok', network: 'ok' });
  assert.ok(findings.every((f) => f.level === 'ok'));
  assert.equal(findings.length, 4);
});

test('every finding is tagged with the resource it concerns', () => {
  const { findings } = analyze(makeSnapshot());
  for (const f of findings) {
    assert.ok(f.resource, `finding "${f.title}" has no resource tag`);
  }
});

/* ---------- thresholds ---------- */

test('memory crossing the warn threshold warns and names the biggest consumer', () => {
  const { findings, levels } = analyze(makeSnapshot({
    memory: { percent: THRESHOLDS.memory.warn, freeBytes: 2 * GB },
    processes: { byMemory: [makeProcess({ name: 'Edge', memoryBytes: 2.1 * GB, memoryPercent: 13 })] }
  }));

  const memory = byResource(findings, 'memory');
  assert.equal(levels.memory, 'warn');
  assert.equal(memory[0].level, 'warn');
  assert.match(memory[0].detail, /Edge/);
  assert.match(memory[0].detail, /2\.1 GB/);
});

test('memory just below the threshold stays healthy (boundary is inclusive)', () => {
  const { levels } = analyze(makeSnapshot({ memory: { percent: THRESHOLDS.memory.warn - 0.1 } }));
  assert.equal(levels.memory, 'ok');
});

test('memory at the critical threshold escalates', () => {
  const { health, levels } = analyze(makeSnapshot({
    memory: { percent: THRESHOLDS.memory.critical, freeBytes: 500 * MB }
  }));
  assert.equal(levels.memory, 'critical');
  assert.equal(health.label, 'NEEDS ATTENTION');
});

test('a nearly full disk is critical and says how much is left', () => {
  const { findings, levels } = analyze(makeSnapshot({
    storage: { percent: 94, freeBytes: 11.7 * GB, mount: '/' }
  }));

  const storage = byResource(findings, 'storage')[0];
  assert.equal(levels.storage, 'critical');
  assert.match(storage.detail, /11\.7 GB/);
});

test('an unreachable network warns rather than reporting zero latency', () => {
  const { findings, levels } = analyze(makeSnapshot({
    network: { connected: false, latencyMs: null }
  }));

  assert.equal(levels.network, 'warn');
  assert.match(byResource(findings, 'network')[0].title, /unreachable/i);
});

test('high latency escalates to critical', () => {
  const { levels } = analyze(makeSnapshot({
    network: { latencyMs: THRESHOLDS.latency.critical }
  }));
  assert.equal(levels.network, 'critical');
});

test('unreadable storage warns instead of claiming 0% used', () => {
  const { findings, levels } = analyze(makeSnapshot({ storage: { totalBytes: 0 } }));
  assert.equal(levels.storage, 'warn');
  assert.match(byResource(findings, 'storage')[0].title, /unreadable/i);
});

/* ---------- blame ---------- */

test('CPU trouble names the dominant process only when its share is material', () => {
  const loud = analyze(makeSnapshot({
    cpu: { average: 92, usage: 92 },
    processes: { byCpu: [makeProcess({ name: 'Roblox', cpu: 320, cpuShare: 40 })] }
  }));
  assert.match(byResource(loud.findings, 'cpu')[0].detail, /Roblox/);

  const diffuse = analyze(makeSnapshot({
    cpu: { average: 92, usage: 92 },
    processes: { byCpu: [makeProcess({ name: 'kernel_task', cpu: 20, cpuShare: 2 })] }
  }));
  assert.doesNotMatch(byResource(diffuse.findings, 'cpu')[0].detail, /kernel_task/);
});

test('a memory hog is called out separately and told how to fix it', () => {
  const { findings } = analyze(makeSnapshot({
    processes: {
      byMemory: [makeProcess({
        name: 'Chrome', memoryBytes: 5 * GB,
        memoryPercent: THRESHOLDS.processMemoryPercent, processCount: 28
      })]
    }
  }));

  const hog = byResource(findings, 'process')[0];
  assert.match(hog.title, /Chrome/);
  assert.match(hog.detail, /28 processes/);
  assert.match(hog.detail, /Restarting/);
});

test('a CPU hog is only flagged when the machine is actually loaded', () => {
  const idle = analyze(makeSnapshot({
    cpu: { average: 10 },
    processes: { byCpu: [makeProcess({ name: 'Encoder', cpu: 400, cpuShare: 50 })] }
  }));
  // One app at 50% of a machine that is 10% busy is arithmetic noise, not a problem.
  assert.equal(byResource(idle.findings, 'process').length, 0);
});

/* ---------- redundancy ---------- */

test('a troubled resource never also reports itself healthy', () => {
  const { findings } = analyze(makeSnapshot({
    memory: { percent: 95, freeBytes: 500 * MB },
    processes: { byMemory: [makeProcess({ name: 'Edge', memoryBytes: 4 * GB })] }
  }));

  const memory = byResource(findings, 'memory');
  assert.ok(memory.length > 0);
  assert.ok(memory.every((f) => f.level !== 'ok'),
    'healthy line survived alongside a memory problem');
});

test('overall health reflects the single worst finding', () => {
  const { health } = analyze(makeSnapshot({
    storage: { percent: 95, freeBytes: 2 * GB },
    network: { latencyMs: 200 }
  }));
  assert.equal(health.level, 'critical');
});

/* ---------- trend rules ---------- */

/** Feeds `count` snapshots spaced `stepMs` apart, with memory shaped by `shape`. */
function feed(history, { count, stepMs = 2000, shape, apps = () => [] }) {
  for (let i = 0; i < count; i += 1) {
    const t = BASE_TIME + i * stepMs;
    history.record(makeSnapshot({
      timestamp: t,
      memory: { usedBytes: shape(i), percent: 50 },
      processes: { byMemory: apps(i) }
    }));
  }
}

test('steady memory growth is reported as climbing', () => {
  const history = new History();
  // 8 GB climbing to 11 GB over 20 minutes.
  feed(history, { count: 600, shape: (i) => 8 * GB + i * (3 * GB / 600) });

  const { findings } = analyze(makeSnapshot({ memory: { percent: 50 } }), history);
  const climb = findings.find((f) => /climbing/i.test(f.title));

  assert.ok(climb, 'expected a climbing-memory finding');
  assert.match(climb.detail, /minutes/);
});

test('flat memory is not reported as climbing', () => {
  const history = new History();
  feed(history, { count: 600, shape: () => 8 * GB });

  const { findings } = analyze(makeSnapshot(), history);
  assert.equal(findings.find((f) => /climbing/i.test(f.title)), undefined);
});

test('a brief burst of samples is not enough to call a trend', () => {
  const history = new History();
  // Only 5 samples over 10 seconds, but growing fast.
  feed(history, { count: 5, shape: (i) => 8 * GB + i * GB });

  const { findings } = analyze(makeSnapshot(), history);
  assert.equal(findings.find((f) => /climbing/i.test(f.title)), undefined);
});

test('an app that only grows is named as a leak suspect', () => {
  const history = new History();
  feed(history, {
    count: 600,
    shape: () => 8 * GB,
    apps: (i) => [
      makeProcess({ name: 'Leaky', memoryBytes: 500 * MB + i * (2 * GB / 600) }),
      makeProcess({ name: 'Steady', memoryBytes: 900 * MB })
    ]
  });

  const { findings } = analyze(makeSnapshot(), history);
  const leak = findings.find((f) => /keeps growing/i.test(f.title));

  assert.ok(leak, 'expected a leak-suspect finding');
  assert.match(leak.title, /Leaky/);
  assert.doesNotMatch(leak.title, /Steady/);
});

test('sustained load adds duration context that a single sample cannot', () => {
  const history = new History();
  for (let i = 0; i < 600; i += 1) {
    history.record(makeSnapshot({ timestamp: BASE_TIME + i * 2000, cpu: { usage: 95 } }));
  }

  const withHistory = analyze(makeSnapshot({ cpu: { average: 95, usage: 95 } }), history);
  const withoutHistory = analyze(makeSnapshot({ cpu: { average: 95, usage: 95 } }));

  assert.match(byResource(withHistory.findings, 'cpu')[0].detail, /steady work/);
  assert.doesNotMatch(byResource(withoutHistory.findings, 'cpu')[0].detail, /steady work/);
});

test('the engine works unchanged when no history is supplied', () => {
  const { health, findings } = analyze(makeSnapshot());
  assert.equal(health.level, 'ok');
  assert.equal(findings.length, 4);
});
