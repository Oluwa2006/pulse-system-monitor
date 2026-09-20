'use strict';

/**
 * Presentation only. Never touches Node or the filesystem -- it renders
 * whatever snapshot the main process hands over through the preload bridge.
 */

const ICONS = { ok: '△', warn: '△', critical: '▼' };

// Gauge arcs sweep 270 degrees, leaving the last quarter open at the bottom.
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 17;
const GAUGE_SWEEP = GAUGE_CIRCUMFERENCE * 0.75;

const RADAR_AXES = ['CPU', 'MEMORY', 'STORAGE'];
const RADAR_TRAIL = 8;

const SVG_NS = 'http://www.w3.org/2000/svg';

let sortMode = 'cpu';
let feedMode = 'findings';
let latest = null;
const radarHistory = [];

const el = (id) => document.getElementById(id);

const dom = {
  health: el('health'), healthValue: el('health-value'),
  metaHost: el('meta-host'), metaUptime: el('meta-uptime'),
  metaCores: el('meta-cores'), metaClock: el('meta-clock'),
  titleDate: el('title-date'),
  statProcesses: el('stat-processes'), statApps: el('stat-apps'),
  chartGrid: el('chart-grid'), lineCpu: el('line-cpu'), lineMem: el('line-mem'),
  chartAxis: el('chart-axis'),
  cpu: { card: el('card-cpu'), value: el('cpu-value'), sub: el('cpu-sub'), foot: el('cpu-foot'), gauge: el('cpu-gauge'), spark: el('cpu-spark') },
  memory: { card: el('card-memory'), value: el('memory-value'), sub: el('memory-sub'), foot: el('memory-foot'), gauge: el('memory-gauge'), spark: el('memory-spark') },
  storage: { card: el('card-storage'), value: el('storage-value'), sub: el('storage-sub'), foot: el('storage-foot'), gauge: el('storage-gauge'), meter: el('storage-meter') },
  network: { card: el('card-network'), value: el('network-value'), sub: el('network-sub'), foot: el('network-foot'), gauge: el('network-gauge'), throughput: el('network-throughput') },
  cores: el('cores'),
  processBody: el('process-body'), processFoot: el('process-foot'),
  radarWeb: el('radar-web'), radarTrail: el('radar-trail'),
  radarNow: el('radar-now'), radarLabels: el('radar-labels'),
  feed: el('feed'), observed: el('observed')
};

/* ── wiring ───────────────────────────────────────────────────────── */

bindToggle('[data-sort]', 'sort', (value) => {
  sortMode = value;
  if (latest) renderProcesses(latest.processes);
});

bindToggle('[data-feed]', 'feed', (value) => {
  feedMode = value;
  if (latest) renderFeed(latest);
});

function bindToggle(selector, key, onPick) {
  const buttons = [...document.querySelectorAll(selector)];
  for (const button of buttons) {
    button.addEventListener('click', () => {
      for (const other of buttons) other.classList.toggle('is-active', other === button);
      onPick(button.dataset[key]);
    });
  }
}

window.pulse.onUpdate((snapshot) => { latest = snapshot; render(snapshot); });

window.pulse.onError((error) => {
  dom.health.dataset.level = 'critical';
  dom.healthValue.textContent = 'READ_FAILED';
  dom.feed.replaceChildren(feedRow('critical', 'Could not read system metrics', error.message));
});

/* ── render ───────────────────────────────────────────────────────── */

function render(snapshot) {
  const levels = snapshot.diagnostics.levels;

  renderStatusBar(snapshot);
  renderCpu(snapshot.cpu, levels.cpu);
  renderMemory(snapshot.memory, levels.memory);
  renderStorage(snapshot.storage, levels.storage);
  renderNetwork(snapshot.network, levels.network);
  renderBigChart(snapshot);
  renderCores(snapshot.cpu);
  renderProcesses(snapshot.processes);
  renderRadar(snapshot);
  renderFeed(snapshot);
}

function renderStatusBar({ system, timestamp, diagnostics, processes }) {
  const health = diagnostics.health;
  dom.health.dataset.level = health.level;
  dom.healthValue.textContent = health.label.replace(/ /g, '_');

  dom.metaHost.textContent = system.hostname;
  dom.metaUptime.textContent = formatUptime(system.uptimeSeconds);
  dom.metaCores.textContent = String(system.coreCount);
  dom.metaClock.textContent = new Date(timestamp).toLocaleTimeString([], { hour12: false });

  dom.titleDate.textContent = `// ${formatStamp(timestamp)}`;
  dom.statProcesses.textContent = String(processes.total);
  dom.statApps.textContent = String(processes.groups);
}

function renderCpu(cpu, level) {
  applyLevel(dom.cpu.card, level);
  dom.cpu.value.textContent = `${Math.round(cpu.usage)}%`;
  dom.cpu.sub.textContent = cpu.model;
  dom.cpu.foot.textContent = `AVG // ${cpu.average}%   CORES // ${cpu.cores}`;
  setGauge(dom.cpu.gauge, cpu.usage);
  drawSparkline(dom.cpu.spark, cpu.history);
}

function renderMemory(memory, level) {
  applyLevel(dom.memory.card, level);
  dom.memory.value.textContent = formatBytes(memory.usedBytes);
  dom.memory.sub.textContent = `OF ${formatBytes(memory.totalBytes)}`;
  dom.memory.foot.textContent = `USED // ${Math.round(memory.percent)}%   FREE // ${formatBytes(memory.freeBytes)}`;
  setGauge(dom.memory.gauge, memory.percent);
  drawSparkline(dom.memory.spark, memory.history);
}

function renderStorage(storage, level) {
  applyLevel(dom.storage.card, level);
  dom.storage.value.textContent = `${Math.round(storage.percent)}%`;
  dom.storage.sub.textContent = storage.mount;
  dom.storage.foot.textContent = `FREE // ${formatBytes(storage.freeBytes)} OF ${formatBytes(storage.totalBytes)}`;
  setGauge(dom.storage.gauge, storage.percent);
  dom.storage.meter.style.width = `${Math.min(storage.percent, 100)}%`;
}

function renderNetwork(network, level) {
  applyLevel(dom.network.card, level);
  dom.network.value.textContent = network.connected ? `${network.latencyMs}ms` : 'OFFLINE';
  dom.network.sub.textContent = network.interface;
  dom.network.foot.textContent = network.connected ? 'STATUS // Connected' : 'STATUS // No_response';
  // Latency has no ceiling, so the gauge shows it against a 200 ms budget.
  setGauge(dom.network.gauge, network.connected ? Math.min(network.latencyMs / 2, 100) : 0);
  dom.network.throughput.textContent =
    `RX // ${formatRate(network.rxPerSec)}    TX // ${formatRate(network.txPerSec)}`;
}

function applyLevel(card, level) {
  card.classList.toggle('card-alert', level === 'warn');
  card.classList.toggle('card-crit', level === 'critical');
}

function setGauge(circle, percent) {
  const filled = GAUGE_SWEEP * (Math.min(Math.max(percent, 0), 100) / 100);
  circle.setAttribute('stroke-dasharray', `${filled} ${GAUGE_CIRCUMFERENCE}`);
  circle.parentNode.querySelector('.gauge-track')
    .setAttribute('stroke-dasharray', `${GAUGE_SWEEP} ${GAUGE_CIRCUMFERENCE}`);
}

/* ── charts ───────────────────────────────────────────────────────── */

function renderBigChart({ cpu, memory }) {
  if (!dom.chartGrid.childElementCount) {
    for (const percent of [0, 25, 50, 75, 100]) {
      const rule = document.createElement('div');
      rule.className = 'chart-rule';
      rule.style.bottom = `${percent}%`;
      rule.append(span(`${percent}%`));
      dom.chartGrid.append(rule);
    }
  }

  plot(dom.lineCpu, cpu.history);
  plot(dom.lineMem, memory.history);

  const seconds = Math.max(cpu.history.length - 1, 0) * 2;
  dom.chartAxis.replaceChildren(
    span(`-${seconds}s`), span(`-${Math.round(seconds / 2)}s`), span('NOW')
  );
}

/** Percentages map straight onto the 100x100 viewBox, which is then stretched. */
function plot(line, history) {
  if (!history || history.length < 2) return line.setAttribute('points', '');
  const step = 100 / (history.length - 1);
  line.setAttribute('points', history
    .map((v, i) => `${(i * step).toFixed(2)},${(100 - Math.min(v, 100)).toFixed(2)}`)
    .join(' '));
}

function drawSparkline(svgEl, history) {
  const line = svgEl.querySelector('.spark-line');
  if (!history || history.length < 2) return line.setAttribute('points', '');
  const step = 100 / (history.length - 1);
  line.setAttribute('points', history
    // 2px of headroom so the stroke is not clipped at 0% or 100%.
    .map((v, i) => `${(i * step).toFixed(2)},${(28 - (Math.min(v, 100) / 100) * 26).toFixed(2)}`)
    .join(' '));
}

function renderCores({ perCore }) {
  dom.cores.replaceChildren();
  if (!perCore || !perCore.length) return;

  perCore.forEach((load, index) => {
    const bar = document.createElement('div');
    bar.className = 'core-bar';

    const fill = document.createElement('span');
    fill.className = load >= 80 ? 'core-fill is-hot' : 'core-fill';
    fill.style.height = `${Math.max(Math.min(load, 100), 2)}%`;
    bar.append(fill);

    const key = document.createElement('span');
    key.className = 'core-key';
    key.textContent = String(index).padStart(2, '0');

    const core = document.createElement('div');
    core.className = 'core';
    core.append(bar, key);
    dom.cores.append(core);
  });
}

/* ── radar ────────────────────────────────────────────────────────── */

// The box is wider than it is tall to leave room for the axis labels, which
// sit outside the outer ring rather than on it.
const RADAR = { cx: 105, cy: 75, radius: 45, labelRadius: 62 };

/** A point at an arbitrary distance along axis `index`. */
function radarVertex(index, distance) {
  const angle = (-90 + index * (360 / RADAR_AXES.length)) * (Math.PI / 180);
  return [RADAR.cx + distance * Math.cos(angle), RADAR.cy + distance * Math.sin(angle)];
}

/** Position of `value` percent along axis `index`. */
function radarPoint(index, value) {
  return radarVertex(index, RADAR.radius * (Math.min(Math.max(value, 0), 100) / 100));
}

// Declared as a function, not a const: drawRadarWeb() runs at load time,
// before a const defined here would be initialised.
function radarPolygon(values) {
  return values.map((v, i) => radarPoint(i, v).map((n) => n.toFixed(1)).join(',')).join(' ');
}

function drawRadarWeb() {
  for (const ring of [33, 66, 100]) {
    dom.radarWeb.append(svg('polygon', { points: radarPolygon(RADAR_AXES.map(() => ring)) }));
  }
  RADAR_AXES.forEach((axis, index) => {
    const [x, y] = radarPoint(index, 100);
    dom.radarWeb.append(svg('line', { x1: RADAR.cx, y1: RADAR.cy, x2: x, y2: y }));

    const [lx, ly] = radarVertex(index, RADAR.labelRadius);
    dom.radarLabels.append(svg('text', {
      x: lx, y: ly, 'text-anchor': anchorFor(lx), 'dominant-baseline': 'middle'
    }, axis));
  });
}

function anchorFor(x) {
  if (x > RADAR.cx + 5) return 'start';
  if (x < RADAR.cx - 5) return 'end';
  return 'middle';
}

function renderRadar({ cpu, memory, storage }) {
  const current = [cpu.usage, memory.percent, storage.percent];

  radarHistory.push(current);
  while (radarHistory.length > RADAR_TRAIL) radarHistory.shift();

  // Older samples stay on screen faintly, so drift is visible as a spread.
  dom.radarTrail.replaceChildren(
    ...radarHistory.slice(0, -1).map((values) => svg('polygon', { points: radarPolygon(values) }))
  );
  dom.radarNow.setAttribute('points', radarPolygon(current));
}

/* ── tables and feed ──────────────────────────────────────────────── */

function renderProcesses(processes) {
  const rows = sortMode === 'cpu' ? processes.byCpu : processes.byMemory;
  dom.processBody.replaceChildren();

  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 3;
    td.textContent = 'No_processes_readable';
    tr.append(td);
    dom.processBody.append(tr);
    return;
  }

  for (const proc of rows.slice(0, 7)) {
    const tr = document.createElement('tr');

    const wrapper = document.createElement('div');
    wrapper.className = 'pname';
    const label = document.createElement('span');
    label.textContent = proc.name;
    wrapper.append(label);
    if (proc.processCount > 1) {
      const badge = document.createElement('span');
      badge.className = 'pcount';
      badge.textContent = `×${proc.processCount}`;
      wrapper.append(badge);
    }

    const nameCell = document.createElement('td');
    nameCell.append(wrapper);

    const cpuCell = document.createElement('td');
    cpuCell.className = proc.cpuShare >= 25 ? 'num is-hot' : 'num';
    cpuCell.textContent = `${proc.cpu.toFixed(1)}%`;

    const memCell = document.createElement('td');
    memCell.className = proc.memoryPercent >= 15 ? 'num is-hot' : 'num';
    memCell.textContent = formatBytes(proc.memoryBytes);

    tr.append(nameCell, cpuCell, memCell);
    dom.processBody.append(tr);
  }

  dom.processFoot.textContent =
    `${processes.total}_PROCESSES // ${processes.groups}_APPS // CPU_PER_CORE`;
}

function renderFeed(snapshot) {
  const observed = snapshot.observedMs || 0;
  dom.observed.textContent = observed >= 60000 ? `WATCHING // ${formatSpan(observed)}` : '';
  dom.feed.replaceChildren();

  const rows = feedMode === 'findings'
    ? findingRows(snapshot.diagnostics.findings)
    : eventRows(snapshot.events || []);

  if (!rows.length) {
    const empty = document.createElement('li');
    empty.className = 'feed-empty';
    empty.textContent = feedMode === 'findings'
      ? 'No_findings.'
      : 'Nothing_to_report since Pulse started.';
    dom.feed.append(empty);
    return;
  }

  dom.feed.append(...rows);
}

function findingRows(findings) {
  const order = { critical: 0, warn: 1, ok: 2 };
  return [...findings]
    .sort((a, b) => order[a.level] - order[b.level])
    .map((f) => feedRow(f.level, f.title, f.detail));
}

function eventRows(events) {
  return events.map((event) => {
    const when = event.ongoing
      ? `ONGOING // ${formatSpan(event.durationMs)}`
      : `${formatSpan(event.durationMs)} // ENDED_${clockAt(event.endedAt)}`;
    return feedRow(event.level, event.title, event.detail, when, event.ongoing);
  });
}

function feedRow(level, title, detail, when, ongoing) {
  const li = document.createElement('li');
  li.className = ongoing ? 'feed-item is-ongoing' : 'feed-item';
  li.dataset.level = level;

  const icon = document.createElement('span');
  icon.className = 'feed-icon';
  icon.textContent = ICONS[level];

  const body = document.createElement('div');
  const heading = document.createElement('p');
  heading.className = 'feed-title';
  heading.textContent = title;
  body.append(heading);

  if (detail) {
    const p = document.createElement('p');
    p.className = 'feed-detail';
    p.textContent = detail;
    body.append(p);
  }

  if (when) {
    const p = document.createElement('p');
    p.className = 'feed-when';
    p.textContent = when;
    body.append(p);
  }

  li.append(icon, body);
  return li;
}

/* ── helpers ──────────────────────────────────────────────────────── */

function svg(tag, attributes, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text != null) node.textContent = text;
  return node;
}

function span(text) {
  const node = document.createElement('span');
  node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0MB';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1024 ** 2)}MB`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0KB/s';
  const mb = bytesPerSecond / 1024 ** 2;
  return mb >= 1 ? `${mb.toFixed(1)}MB/s` : `${Math.round(bytesPerSecond / 1024)}KB/s`;
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d_${hours}h`;
  if (hours) return `${hours}h_${minutes}m`;
  return `${minutes}m`;
}

function formatSpan(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h_${minutes % 60}m`;
}

function clockAt(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false, timeStyle: 'short' });
}

/** "Friday-September_19", matching the reference header. */
function formatStamp(timestamp) {
  const date = new Date(timestamp);
  const weekday = date.toLocaleDateString([], { weekday: 'long' });
  const month = date.toLocaleDateString([], { month: 'long' });
  return `${weekday}-${month}_${date.getDate()}`;
}

/* ── bootstrap ────────────────────────────────────────────────────── */

// Runs last on purpose: everything above must be initialised before the
// static radar web is drawn or the first snapshot arrives.
drawRadarWeb();
window.pulse.ready();
