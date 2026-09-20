'use strict';

/**
 * Headless check: takes two real samples and prints what the UI would show.
 * Useful for verifying the data layer without launching Electron.
 */

const { MetricsCollector } = require('../src/main/metrics');
const { analyze } = require('../src/diagnostics/diagnostics');

(async () => {
  const collector = new MetricsCollector();
  await collector.sample();
  await new Promise((r) => setTimeout(r, 1500));

  const snapshot = await collector.sample();
  const { health, findings, levels } = analyze(snapshot);

  console.log(`HEALTH: ${health.label} (${health.level})`);
  console.log(`CPU     ${snapshot.cpu.usage}%  avg ${snapshot.cpu.average}%  ${snapshot.cpu.cores} cores [${levels.cpu}]`);
  console.log(`MEMORY  ${gb(snapshot.memory.usedBytes)} / ${gb(snapshot.memory.totalBytes)}  ${snapshot.memory.percent}% [${levels.memory}]`);
  console.log(`STORAGE ${snapshot.storage.percent}%  ${gb(snapshot.storage.freeBytes)} free on ${snapshot.storage.mount} [${levels.storage}]`);
  console.log(`NETWORK ${snapshot.network.latencyMs} ms  ${snapshot.network.interface}  connected=${snapshot.network.connected} [${levels.network}]`);
  console.log(`HISTORY cpu samples: ${snapshot.cpu.history.length}`);

  console.log('\nTOP BY CPU');
  snapshot.processes.byCpu.slice(0, 5).forEach((p) =>
    console.log(`  ${p.name.padEnd(28)} ${String(p.cpu).padStart(6)}%  share ${String(p.cpuShare).padStart(5)}%  ${gb(p.memoryBytes).padStart(9)}  x${p.processCount}`));

  console.log('\nTOP BY MEMORY');
  snapshot.processes.byMemory.slice(0, 5).forEach((p) =>
    console.log(`  ${p.name.padEnd(28)} ${String(p.cpu).padStart(6)}%  ${gb(p.memoryBytes).padStart(9)}  ${p.memoryPercent}%  x${p.processCount}`));

  console.log('\nDIAGNOSTICS');
  findings.forEach((f) => console.log(`  [${f.level}] ${f.title} -- ${f.detail}`));
})();

function gb(bytes) {
  const v = bytes / 1024 ** 3;
  return v >= 1 ? `${v.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
