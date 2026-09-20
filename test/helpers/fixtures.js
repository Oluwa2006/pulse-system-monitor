'use strict';

/** Builders for synthetic snapshots, so tests can state only what they care about. */

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const BASE_TIME = 1700000000000;

function makeProcess(overrides = {}) {
  return {
    name: 'TestApp',
    cpu: 0,
    cpuShare: 0,
    memoryBytes: 100 * MB,
    memoryPercent: 1,
    processCount: 1,
    pid: 1234,
    ...overrides
  };
}

function makeSnapshot(overrides = {}) {
  return merge({
    timestamp: BASE_TIME,
    cpu: { usage: 20, average: 20, cores: 8, model: 'Test CPU', history: [20] },
    memory: { usedBytes: 8 * GB, totalBytes: 16 * GB, freeBytes: 8 * GB, percent: 50 },
    storage: {
      mount: '/', filesystem: 'test',
      totalBytes: 500 * GB, usedBytes: 250 * GB, freeBytes: 250 * GB, percent: 50
    },
    network: { interface: 'en0', connected: true, latencyMs: 20, rxPerSec: 0, txPerSec: 0 },
    processes: { total: 100, running: 50, byCpu: [], byMemory: [] },
    system: { platform: 'darwin', hostname: 'test-host', uptimeSeconds: 3600, coreCount: 8 }
  }, overrides);
}

/** Shallow-per-key deep merge; arrays replace rather than concatenate. */
function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key])
      ? merge(base[key], value)
      : value;
  }
  return out;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Finds a finding by the resource it was tagged with. */
function byResource(findings, resource) {
  return findings.filter((f) => f.resource === resource);
}

module.exports = { makeSnapshot, makeProcess, byResource, GB, MB, BASE_TIME };
