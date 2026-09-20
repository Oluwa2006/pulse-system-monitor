'use strict';

/**
 * Turns a raw metrics snapshot into plain-language findings.
 *
 * The rule of this module: never state a number the dashboard already shows.
 * A finding must add something -- what is causing it, or what it means.
 */

const { TREND_MIN_SPAN_MS } = require('../history/history');

const THRESHOLDS = {
  cpu: { warn: 70, critical: 88 },
  memory: { warn: 78, critical: 90 },
  storage: { warn: 80, critical: 92 },
  latency: { warn: 150, critical: 400 },
  // A single app crossing these is worth calling out by name.
  processCpuShare: 40,
  processMemoryPercent: 25,
  // Trend rules: how much growth counts as climbing, and how much of the
  // window must be hot before load is called sustained rather than spiky.
  memoryClimbBytes: 1.5 * 1024 ** 3,
  sustainedCpuRatio: 0.7
};

const LEVELS = { ok: 0, warn: 1, critical: 2 };

/**
 * @param {object} snapshot a reading from the metrics collector
 * @param {object} [history] optional rolling window; enables the trend rules
 */
function analyze(snapshot, history) {
  const findings = dropRedundantOk([
    tag('cpu', checkCpu(snapshot, history)),
    tag('memory', checkMemory(snapshot)),
    tag('memory', checkMemoryClimb(snapshot, history)),
    tag('storage', checkStorage(snapshot)),
    tag('network', checkNetwork(snapshot)),
    ...checkProcessHogs(snapshot).map((f) => tag('process', f)),
    ...checkLeakSuspects(snapshot, history).map((f) => tag('process', f))
  ].filter(Boolean));

  return {
    health: overallHealth(findings),
    findings,
    // Lets the UI color each card straight from the engine's verdict instead
    // of keeping a second copy of the thresholds in the renderer.
    levels: resourceLevels(findings)
  };
}

function tag(resource, finding) {
  return finding ? { ...finding, resource } : null;
}

function resourceLevels(findings) {
  const levels = { cpu: 'ok', memory: 'ok', storage: 'ok', network: 'ok' };
  for (const f of findings) {
    if (!(f.resource in levels)) continue;
    if (LEVELS[f.level] > LEVELS[levels[f.resource]]) levels[f.resource] = f.level;
  }
  return levels;
}

function checkCpu({ cpu, processes }, history) {
  // Judged on the rolling average so a momentary spike is not an alarm.
  const value = cpu.average;
  const top = processes.byCpu[0];
  const blame = top && top.cpuShare >= 15
    ? ` ${top.name} is the largest consumer at ${top.cpuShare}% of total capacity.`
    : '';
  // History turns "busy right now" into "busy for the last eleven minutes",
  // which is the part that tells you whether to wait it out.
  const duration = sustainedContext(history);

  if (value >= THRESHOLDS.cpu.critical) {
    return finding('critical', 'CPU under heavy load',
      `Processor usage is very high.${blame}${duration} The machine may feel slow or unresponsive.`);
  }
  if (value >= THRESHOLDS.cpu.warn) {
    return finding('warn', 'CPU usage elevated',
      `The processor has been busy over the last few samples.${blame}${duration}`);
  }
  return finding('ok', 'CPU usage normal', `Averaging ${value}% across ${cpu.cores} cores.`);
}

/** Returns a sentence about how long load has persisted, or '' if unknown. */
function sustainedContext(history) {
  if (!history || history.spanMs < TREND_MIN_SPAN_MS) return '';
  const ratio = history.cpuLoadRatio(THRESHOLDS.cpu.warn);
  if (ratio < THRESHOLDS.sustainedCpuRatio) return '';
  return ` It has stayed above ${THRESHOLDS.cpu.warn}% for ${Math.round(ratio * 100)}%`
    + ` of the last ${formatDuration(history.spanMs)}, so this is steady work rather than a spike.`;
}

/** Total memory drifting upward over the window, regardless of the current level. */
function checkMemoryClimb(_snapshot, history) {
  if (!history) return null;

  const trend = history.memoryTrend();
  if (!trend || !trend.confident) return null;
  if (trend.change < THRESHOLDS.memoryClimbBytes) return null;

  return finding('warn', 'Memory use is climbing',
    `Up ${formatBytes(trend.change)} over the last ${formatDuration(trend.spanMs)}`
    + ` — roughly ${formatBytes(trend.slopePerHour)} an hour at this rate.`);
}

/**
 * Names an application whose memory only ever goes up. A steady climb with a
 * tight fit is the signature of a leak; a spiky one is just a busy app.
 */
function checkLeakSuspects(_snapshot, history) {
  if (!history) return [];

  const growing = history.growingApps();
  if (!growing.length) return [];

  const worst = growing[0];
  return [finding('warn', `${worst.name} keeps growing`,
    `It has gained ${formatBytes(worst.change)} over ${formatDuration(worst.spanMs)} without levelling off,`
    + ' which usually means a leak rather than normal use. Restarting it should reclaim the memory.')];
}

/**
 * Drops the reassuring "all good" line for any resource that also has a real
 * problem, so the panel never says a resource is healthy and failing at once.
 */
function dropRedundantOk(findings) {
  const troubled = new Set(
    findings.filter((f) => f.level !== 'ok').map((f) => f.resource)
  );
  return findings.filter((f) => f.level !== 'ok' || !troubled.has(f.resource));
}

function checkMemory({ memory, processes }) {
  const top = processes.byMemory[0];
  const blame = top
    ? ` ${top.name} is the largest consumer at ${formatBytes(top.memoryBytes)}.`
    : '';

  if (memory.percent >= THRESHOLDS.memory.critical) {
    return finding('critical', 'Memory nearly exhausted',
      `Only ${formatBytes(memory.freeBytes)} remains free.${blame} Expect swapping and stalls.`);
  }
  if (memory.percent >= THRESHOLDS.memory.warn) {
    return finding('warn', 'Memory usage is high',
      `${formatBytes(memory.freeBytes)} free.${blame}`);
  }
  return finding('ok', 'Memory healthy', `${formatBytes(memory.freeBytes)} still available.`);
}

function checkStorage({ storage }) {
  if (!storage || !storage.totalBytes) {
    return finding('warn', 'Storage unreadable', 'Could not read disk usage for the primary volume.');
  }
  if (storage.percent >= THRESHOLDS.storage.critical) {
    return finding('critical', 'Storage almost full',
      `Only ${formatBytes(storage.freeBytes)} left on ${storage.mount}. Updates and caches may start failing.`);
  }
  if (storage.percent >= THRESHOLDS.storage.warn) {
    return finding('warn', 'Storage filling up',
      `${formatBytes(storage.freeBytes)} free on ${storage.mount}.`);
  }
  return finding('ok', 'Storage healthy', `${formatBytes(storage.freeBytes)} free on ${storage.mount}.`);
}

function checkNetwork({ network }) {
  if (!network || !network.connected) {
    return finding('warn', 'Network unreachable',
      'No response from the internet. You may be offline or behind a captive portal.');
  }
  if (network.latencyMs >= THRESHOLDS.latency.critical) {
    return finding('critical', 'Network latency very high',
      `Round trips are taking ${network.latencyMs} ms on ${network.interface}. Calls and streaming will suffer.`);
  }
  if (network.latencyMs >= THRESHOLDS.latency.warn) {
    return finding('warn', 'Network is slow',
      `${network.latencyMs} ms round trip on ${network.interface}.`);
  }
  return finding('ok', 'Network connected', `${network.latencyMs} ms round trip on ${network.interface}.`);
}

/**
 * Flags a single application that is disproportionately responsible for load,
 * which is usually the actionable answer to "why is my computer slow?".
 */
function checkProcessHogs({ processes, cpu }) {
  const hogs = [];
  const topCpu = processes.byCpu[0];
  const topMemory = processes.byMemory[0];

  if (topCpu && topCpu.cpuShare >= THRESHOLDS.processCpuShare && cpu.average >= THRESHOLDS.cpu.warn) {
    const spread = topCpu.processCount > 1 ? ` across ${topCpu.processCount} processes` : '';
    hogs.push(finding('warn', `${topCpu.name} is dominating the CPU`,
      `It accounts for roughly ${topCpu.cpuShare}% of total processor capacity${spread}.`));
  }

  if (topMemory && topMemory.memoryPercent >= THRESHOLDS.processMemoryPercent) {
    const spread = topMemory.processCount > 1 ? ` across ${topMemory.processCount} processes` : '';
    hogs.push(finding('warn', `${topMemory.name} is using high memory`,
      `It holds ${formatBytes(topMemory.memoryBytes)} (${topMemory.memoryPercent}% of RAM)${spread}. Restarting it would free the most memory.`));
  }

  return hogs;
}

function overallHealth(findings) {
  const worst = findings.reduce((acc, f) => Math.max(acc, LEVELS[f.level]), 0);
  if (worst === LEVELS.critical) return { level: 'critical', label: 'NEEDS ATTENTION' };
  if (worst === LEVELS.warn) return { level: 'warn', label: 'MINOR ISSUES' };
  return { level: 'ok', label: 'GOOD' };
}

function finding(level, title, detail) {
  return { level, title, detail };
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours} hour${hours === 1 ? '' : 's'}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

module.exports = { analyze, THRESHOLDS, formatBytes, formatDuration };
