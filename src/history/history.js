'use strict';

/**
 * Keeps a rolling window of snapshots so the diagnostics engine can reason
 * about direction, not just position.
 *
 * A threshold can say "memory is at 82%". Only history can say "memory has
 * climbed 3 GB in twenty minutes and Code accounts for all of it", which is
 * the difference between a readout and a diagnosis.
 */

const DEFAULT_WINDOW_MS = 30 * 60 * 1000;

// Per-app series are capped so a machine churning through short-lived
// processes cannot grow the map without bound.
const MAX_TRACKED_APPS = 16;

// Evidence required before a slope is reported as a trend. Without these a
// two-sample blip reads as a runaway leak.
const TREND_MIN_SAMPLES = 20;
const TREND_MIN_SPAN_MS = 5 * 60 * 1000;
const TREND_MIN_FIT = 0.6;

class History {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs] how far back to remember
   */
  constructor({ windowMs = DEFAULT_WINDOW_MS } = {}) {
    this.windowMs = windowMs;
    this.samples = [];
    /** @type {Map<string, Array<{t:number, bytes:number}>>} */
    this.appMemory = new Map();
  }

  record(snapshot) {
    const t = snapshot.timestamp;

    this.samples.push({
      t,
      cpu: snapshot.cpu.usage,
      memoryPercent: snapshot.memory.percent,
      memoryUsedBytes: snapshot.memory.usedBytes,
      storagePercent: snapshot.storage ? snapshot.storage.percent : 0,
      latencyMs: snapshot.network ? snapshot.network.latencyMs : null
    });

    for (const proc of (snapshot.processes.byMemory || [])) {
      const series = this.appMemory.get(proc.name) || [];
      series.push({ t, bytes: proc.memoryBytes });
      this.appMemory.set(proc.name, series);
    }

    this._trim(t);
  }

  /** Total samples currently retained. */
  get size() {
    return this.samples.length;
  }

  /** Milliseconds between the oldest and newest retained sample. */
  get spanMs() {
    if (this.samples.length < 2) return 0;
    return this.samples[this.samples.length - 1].t - this.samples[0].t;
  }

  /** Direction of total memory use across the window. */
  memoryTrend() {
    return trendOf(this.samples, (s) => s.memoryUsedBytes);
  }

  /**
   * Applications whose memory is climbing steadily -- the leak suspects.
   * Sorted by how much they have grown, largest first.
   */
  growingApps({ minGrowthBytes = 400 * 1024 ** 2 } = {}) {
    const growing = [];

    for (const [name, series] of this.appMemory) {
      const trend = trendOf(series, (p) => p.bytes);
      if (!trend || !trend.confident) continue;
      if (trend.change < minGrowthBytes) continue;
      growing.push({ name, ...trend });
    }

    return growing.sort((a, b) => b.change - a.change);
  }

  /**
   * Fraction of the window spent at or above `threshold` percent CPU.
   * Catches a machine that is pinned but not quite pegged.
   */
  cpuLoadRatio(threshold) {
    if (!this.samples.length) return 0;
    const hot = this.samples.filter((s) => s.cpu >= threshold).length;
    return hot / this.samples.length;
  }

  /** Drops anything that has fallen out of the window. */
  _trim(now) {
    const cutoff = now - this.windowMs;

    while (this.samples.length && this.samples[0].t < cutoff) {
      this.samples.shift();
    }

    for (const [name, series] of this.appMemory) {
      while (series.length && series[0].t < cutoff) series.shift();
      if (!series.length) this.appMemory.delete(name);
    }

    // If more apps are still in the window than the cap allows, keep the ones
    // currently using the most memory -- those are the ones worth watching.
    if (this.appMemory.size > MAX_TRACKED_APPS) {
      const ranked = [...this.appMemory.entries()]
        .sort((a, b) => lastBytes(b[1]) - lastBytes(a[1]))
        .slice(MAX_TRACKED_APPS);
      for (const [name] of ranked) this.appMemory.delete(name);
    }
  }
}

/**
 * Least-squares fit over a series, returning the slope, how well the line
 * actually fits, and whether there is enough evidence to trust it.
 *
 * `fit` is R^2: 1.0 is a perfect straight line, near 0 is noise. A steep
 * slope with a poor fit is a spiky workload, not a leak, so both matter.
 */
function trendOf(points, getValue) {
  if (!points || points.length < 2) return null;

  const first = points[0].t;
  const xs = points.map((p) => p.t - first);
  const ys = points.map(getValue);

  const meanX = mean(xs);
  const meanY = mean(ys);

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  // Every sample shares a timestamp: no time axis, so no trend.
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  // A perfectly flat series fits a flat line exactly, but it is not a trend.
  const fit = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  const spanMs = xs[xs.length - 1];

  return {
    slope,
    slopePerHour: slope * 3600000,
    fit,
    spanMs,
    samples: points.length,
    change: ys[ys.length - 1] - ys[0],
    confident:
      points.length >= TREND_MIN_SAMPLES &&
      spanMs >= TREND_MIN_SPAN_MS &&
      fit >= TREND_MIN_FIT &&
      slope > 0
  };
}

function lastBytes(series) {
  return series.length ? series[series.length - 1].bytes : 0;
}

function mean(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

module.exports = {
  History,
  trendOf,
  DEFAULT_WINDOW_MS,
  MAX_TRACKED_APPS,
  TREND_MIN_SAMPLES,
  TREND_MIN_SPAN_MS,
  TREND_MIN_FIT
};
