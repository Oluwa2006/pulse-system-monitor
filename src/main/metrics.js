'use strict';

const os = require('os');
const si = require('systeminformation');

// How many samples to keep for the sparklines.
const HISTORY_LENGTH = 48;

// Storage and latency change slowly and are comparatively expensive to read,
// so they run on their own, slower cadence instead of every tick.
const STORAGE_INTERVAL_MS = 15000;
const LATENCY_INTERVAL_MS = 5000;

const TOP_PROCESS_COUNT = 8;

/**
 * Collects real system metrics. Everything here comes from the machine via
 * `systeminformation` and Node's `os` module -- there are no synthetic values.
 */
class MetricsCollector {
  constructor() {
    this.cpuHistory = [];
    this.memoryHistory = [];
    this.coreCount = os.cpus().length || 1;
    this.cpuModel = (os.cpus()[0] || {}).model || 'Unknown CPU';

    // Cached slow-moving readings, refreshed on their own schedule.
    this.storage = null;
    this.storageCheckedAt = 0;
    this.network = null;
    this.networkCheckedAt = 0;
  }

  /** Builds one complete snapshot of the machine's current state. */
  async sample() {
    const now = Date.now();

    const [load, mem, processes] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.processes()
    ]);

    const cpu = this._readCpu(load);
    const memory = this._readMemory(mem);
    const storage = await this._readStorage(now);
    const network = await this._readNetwork(now);

    push(this.cpuHistory, cpu.usage);
    push(this.memoryHistory, memory.percent);

    return {
      timestamp: now,
      cpu: { ...cpu, history: [...this.cpuHistory] },
      memory: { ...memory, history: [...this.memoryHistory] },
      storage,
      network,
      processes: this._readProcesses(processes, memory.totalBytes),
      system: {
        platform: process.platform,
        hostname: os.hostname(),
        uptimeSeconds: os.uptime(),
        coreCount: this.coreCount
      }
    };
  }

  _readCpu(load) {
    const usage = clampPercent(load.currentLoad);
    return {
      usage,
      // Rolling average smooths out single-tick spikes so diagnostics do not
      // flap between "fine" and "critical" on every refresh.
      average: average(this.cpuHistory.slice(-5).concat(usage)),
      cores: this.coreCount,
      model: this.cpuModel
    };
  }

  _readMemory(mem) {
    // `used` counts filesystem cache and sits near 100% on macOS, which is
    // technically true but useless to a human. `active` is the real pressure.
    const usedBytes = mem.active || mem.used || 0;
    const totalBytes = mem.total || os.totalmem();
    return {
      usedBytes,
      totalBytes,
      freeBytes: Math.max(totalBytes - usedBytes, 0),
      percent: clampPercent((usedBytes / totalBytes) * 100)
    };
  }

  async _readStorage(now) {
    if (this.storage && now - this.storageCheckedAt < STORAGE_INTERVAL_MS) {
      return this.storage;
    }

    try {
      const disks = await si.fsSize();
      const primary = pickPrimaryDisk(disks);
      if (!primary) return this.storage || emptyStorage();

      this.storage = {
        mount: primary.label || primary.mount,
        filesystem: primary.fs,
        totalBytes: primary.size,
        usedBytes: primary.used,
        freeBytes: primary.available != null
          ? primary.available
          : Math.max(primary.size - primary.used, 0),
        percent: clampPercent(primary.use)
      };
      this.storageCheckedAt = now;
    } catch (err) {
      // Keep the last good reading rather than blanking the card.
      if (!this.storage) this.storage = { ...emptyStorage(), error: err.message };
    }

    return this.storage;
  }

  async _readNetwork(now) {
    if (this.network && now - this.networkCheckedAt < LATENCY_INTERVAL_MS) {
      return this.network;
    }

    try {
      const iface = await si.networkInterfaceDefault();
      const [stats, latency] = await Promise.all([
        si.networkStats(iface).catch(() => []),
        // Sends a single ICMP ping to measure round-trip time. This is the
        // only outbound traffic Pulse generates; see README.
        si.inetLatency().catch(() => null)
      ]);

      const primary = stats[0] || {};
      this.network = {
        interface: iface || 'unknown',
        connected: latency != null && latency >= 0,
        latencyMs: latency != null && latency >= 0 ? Math.round(latency) : null,
        rxPerSec: Math.max(primary.rx_sec || 0, 0),
        txPerSec: Math.max(primary.tx_sec || 0, 0)
      };
      this.networkCheckedAt = now;
    } catch (err) {
      this.network = {
        interface: 'unknown',
        connected: false,
        latencyMs: null,
        rxPerSec: 0,
        txPerSec: 0,
        error: err.message
      };
    }

    return this.network;
  }

  /**
   * Groups raw OS processes by application name. A browser with 40 helper
   * processes should read as one row using 3 GB, not 40 rows using 75 MB.
   */
  _readProcesses(processes, totalMemoryBytes) {
    const groups = new Map();

    for (const proc of processes.list || []) {
      const name = applicationName(proc);
      if (!name) continue;

      const existing = groups.get(name) || {
        name,
        cpu: 0,
        memoryBytes: 0,
        processCount: 0,
        pid: proc.pid
      };

      existing.cpu += proc.cpu || 0;
      // memRss is reported in kilobytes.
      existing.memoryBytes += (proc.memRss || 0) * 1024;
      existing.processCount += 1;
      groups.set(name, existing);
    }

    const list = [...groups.values()].map((group) => ({
      ...group,
      cpu: round(group.cpu, 1),
      // `cpu` is a per-core figure (as reported by ps/top), so a 4-core machine
      // can total 400%. Normalizing gives the share of the whole machine.
      cpuShare: round(group.cpu / this.coreCount, 1),
      memoryPercent: round((group.memoryBytes / totalMemoryBytes) * 100, 1)
    }));

    const byCpu = [...list].sort((a, b) => b.cpu - a.cpu).slice(0, TOP_PROCESS_COUNT);
    const byMemory = [...list].sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, TOP_PROCESS_COUNT);

    return {
      total: (processes.list || []).length,
      running: processes.running || 0,
      byCpu,
      byMemory
    };
  }
}

/**
 * Resolves the application a process belongs to.
 *
 * The bundle path is authoritative where there is one: process names lie.
 * ChatGPT's helpers are named "Codex", and VS Code's binary is just "Code",
 * so grouping on the name alone invents an app that is not installed and
 * misses the one that is. Only when there is no bundle do we fall back to
 * cleaning up the name.
 */
function applicationName(proc) {
  return bundleNameFromPath(proc.path) || normalizeName(proc.name);
}

/**
 * Returns the outermost `.app` in a path, which is the real application.
 *
 * Helpers nest their own bundles inside their parent's --
 * `Wispr Flow.app/Contents/Resources/.../Wispr Flow.app/...` -- so the first
 * match scanning left to right is the one that belongs in the table.
 */
function bundleNameFromPath(path) {
  if (!path || typeof path !== 'string') return '';
  const match = /\/([^/]+)\.app\//.exec(`${path}/`);
  return match ? match[1] : '';
}

/** Fallback for platforms without bundles: strip helper and renderer suffixes. */
function normalizeName(rawName) {
  if (!rawName) return '';
  return rawName
    .replace(/\s*\((Renderer|GPU|Plugin|Helper|Not Responding)\)\s*/gi, '')
    .replace(/\s+Helper$/i, '')
    .replace(/\s+\(.*\)$/, '')
    .trim();
}

/**
 * Picks the volume the user actually fills up.
 *
 * macOS seals the system volume at "/" and mounts everything writable on
 * /System/Volumes/Data. Reading "/" reports a nearly empty 24 GB volume and
 * would hide a genuinely full disk, so the data volume wins when it exists --
 * but it is still labelled "/" because that is what the user thinks of it as.
 */
function pickPrimaryDisk(disks) {
  if (!disks || !disks.length) return null;

  const macData = disks.find((d) => d.mount === '/System/Volumes/Data');
  if (macData) return { ...macData, label: '/' };

  const root = disks.find((d) => d.mount === '/' || d.mount === 'C:');
  if (root) return { ...root, label: root.mount };

  const largest = disks.slice().sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  return { ...largest, label: largest.mount };
}

function emptyStorage() {
  return { mount: '-', filesystem: '-', totalBytes: 0, usedBytes: 0, freeBytes: 0, percent: 0 };
}

function push(history, value) {
  history.push(round(value, 1));
  while (history.length > HISTORY_LENGTH) history.shift();
}

function average(values) {
  if (!values.length) return 0;
  return round(values.reduce((sum, v) => sum + v, 0) / values.length, 1);
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return round(Math.min(Math.max(value, 0), 100), 1);
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// normalizeName and pickPrimaryDisk are exported for tests: both encode
// platform quirks that are easy to regress and awkward to catch by eye.
module.exports = {
  MetricsCollector,
  HISTORY_LENGTH,
  applicationName,
  bundleNameFromPath,
  normalizeName,
  pickPrimaryDisk
};
