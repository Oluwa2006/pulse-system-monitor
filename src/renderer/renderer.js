'use strict';

/**
 * Presentation only. This file never touches Node or the filesystem -- it just
 * renders whatever snapshot the main process hands it through the preload bridge.
 */

const ICONS = { ok: '✓', warn: '⚠', critical: '✕' };

let sortMode = 'cpu';
let latest = null;

const el = (id) => document.getElementById(id);

const dom = {
  health: el('health'),
  healthValue: el('health-value'),
  meta: el('meta'),
  cpu: { card: el('card-cpu'), value: el('cpu-value'), note: el('cpu-note'), model: el('cpu-model'), spark: el('cpu-spark') },
  memory: { card: el('card-memory'), value: el('memory-value'), note: el('memory-note'), total: el('memory-total'), spark: el('memory-spark') },
  storage: { card: el('card-storage'), value: el('storage-value'), note: el('storage-note'), mount: el('storage-mount'), meter: el('storage-meter') },
  network: { card: el('card-network'), value: el('network-value'), note: el('network-note'), iface: el('network-interface'), throughput: el('network-throughput') },
  processBody: el('process-body'),
  processFoot: el('process-foot'),
  findings: el('findings'),
  events: el('events'),
  observed: el('observed')
};

/* ---------- wiring ---------- */

document.querySelectorAll('.toggle-btn').forEach((button) => {
  button.addEventListener('click', () => {
    sortMode = button.dataset.sort;
    document.querySelectorAll('.toggle-btn').forEach((b) => b.classList.toggle('is-active', b === button));
    if (latest) renderProcesses(latest.processes);
  });
});

window.pulse.onUpdate((snapshot) => {
  latest = snapshot;
  render(snapshot);
});

window.pulse.onError((error) => {
  dom.healthValue.textContent = 'READ FAILED';
  dom.health.dataset.level = 'critical';
  renderFindings([{ level: 'critical', title: 'Could not read system metrics', detail: error.message }]);
});

window.pulse.ready();

/* ---------- render ---------- */

function render(snapshot) {
  const levels = snapshot.diagnostics.levels;

  renderHealth(snapshot.diagnostics.health);
  renderMeta(snapshot);
  renderCpu(snapshot.cpu, levels.cpu);
  renderMemory(snapshot.memory, levels.memory);
  renderStorage(snapshot.storage, levels.storage);
  renderNetwork(snapshot.network, levels.network);
  renderProcesses(snapshot.processes);
  renderFindings(snapshot.diagnostics.findings);
  renderEvents(snapshot.events || [], snapshot.observedMs || 0);
}

function renderHealth(health) {
  dom.health.dataset.level = health.level;
  dom.healthValue.textContent = `${health.label} ${ICONS[health.level]}`;
}

function renderMeta({ system, timestamp }) {
  const clock = new Date(timestamp).toLocaleTimeString([], { hour12: false });
  dom.meta.textContent = `${system.hostname} · up ${formatUptime(system.uptimeSeconds)} · ${clock}`;
}

function renderCpu(cpu, level) {
  dom.cpu.card.dataset.level = level;
  dom.cpu.value.textContent = `${Math.round(cpu.usage)}%`;
  dom.cpu.model.textContent = `${cpu.cores} cores`;
  dom.cpu.note.textContent = `${cpu.average}% avg · ${cpu.model}`;
  drawSparkline(dom.cpu.spark, cpu.history);
}

function renderMemory(memory, level) {
  dom.memory.card.dataset.level = level;
  dom.memory.value.textContent = formatBytes(memory.usedBytes);
  dom.memory.total.textContent = `of ${formatBytes(memory.totalBytes)}`;
  dom.memory.note.textContent = `${Math.round(memory.percent)}% used · ${formatBytes(memory.freeBytes)} free`;
  drawSparkline(dom.memory.spark, memory.history);
}

function renderStorage(storage, level) {
  dom.storage.card.dataset.level = level;
  dom.storage.value.textContent = `${Math.round(storage.percent)}%`;
  dom.storage.mount.textContent = storage.mount;
  dom.storage.note.textContent =
    `${formatBytes(storage.freeBytes)} free of ${formatBytes(storage.totalBytes)}`;
  dom.storage.meter.style.width = `${Math.min(storage.percent, 100)}%`;
}

function renderNetwork(network, level) {
  dom.network.card.dataset.level = level;
  dom.network.value.textContent = network.connected ? `${network.latencyMs} ms` : 'OFFLINE';
  dom.network.iface.textContent = network.interface;
  dom.network.note.textContent = network.connected ? 'Connected' : 'No internet response';
  dom.network.throughput.textContent =
    `↓ ${formatRate(network.rxPerSec)}    ↑ ${formatRate(network.txPerSec)}`;
}

function renderProcesses(processes) {
  const rows = sortMode === 'cpu' ? processes.byCpu : processes.byMemory;
  dom.processBody.replaceChildren();

  if (!rows.length) {
    dom.processBody.append(emptyRow('No processes readable'));
    return;
  }

  for (const proc of rows) {
    const tr = document.createElement('tr');

    const nameCell = document.createElement('td');
    const wrapper = document.createElement('div');
    wrapper.className = 'process-name';
    const label = document.createElement('span');
    label.textContent = proc.name;
    wrapper.append(label);
    if (proc.processCount > 1) {
      const badge = document.createElement('span');
      badge.className = 'process-count';
      badge.textContent = `×${proc.processCount}`;
      wrapper.append(badge);
    }
    nameCell.append(wrapper);

    const cpuCell = document.createElement('td');
    cpuCell.className = 'num';
    cpuCell.textContent = `${proc.cpu.toFixed(1)}%`;
    if (proc.cpuShare >= 25) cpuCell.classList.add('is-hot');

    const memCell = document.createElement('td');
    memCell.className = 'num';
    memCell.textContent = formatBytes(proc.memoryBytes);
    if (proc.memoryPercent >= 15) memCell.classList.add('is-hot');

    tr.append(nameCell, cpuCell, memCell);
    dom.processBody.append(tr);
  }

  dom.processFoot.textContent =
    `${processes.total} processes running · grouped by application · CPU shown per core`;
}

function renderFindings(findings) {
  dom.findings.replaceChildren();

  // Problems first, healthy confirmations last.
  const order = { critical: 0, warn: 1, ok: 2 };
  const sorted = [...findings].sort((a, b) => order[a.level] - order[b.level]);

  for (const item of sorted) {
    const li = document.createElement('li');
    li.className = 'finding';
    li.dataset.level = item.level;

    const icon = document.createElement('span');
    icon.className = 'finding-icon';
    icon.textContent = ICONS[item.level];

    const body = document.createElement('div');
    const title = document.createElement('p');
    title.className = 'finding-title';
    title.textContent = item.title;
    body.append(title);

    if (item.detail) {
      const detail = document.createElement('p');
      detail.className = 'finding-detail';
      detail.textContent = item.detail;
      body.append(detail);
    }

    li.append(icon, body);
    dom.findings.append(li);
  }
}

/**
 * The log of what already happened. Without this the panel can only ever
 * describe this instant, and a spike that ended two minutes ago never existed.
 */
function renderEvents(events, observedMs) {
  dom.observed.textContent = observedMs >= 60000
    ? `WATCHING ${formatSpan(observedMs)}`
    : '';

  dom.events.replaceChildren();

  if (!events.length) {
    const empty = document.createElement('li');
    empty.className = 'event-empty';
    empty.textContent = 'Nothing to report since Pulse started.';
    dom.events.append(empty);
    return;
  }

  for (const event of events) {
    const li = document.createElement('li');
    li.className = event.ongoing ? 'event is-ongoing' : 'event';
    li.dataset.level = event.level;

    const icon = document.createElement('span');
    icon.className = 'event-icon';
    icon.textContent = ICONS[event.level];

    const title = document.createElement('span');
    title.className = 'event-title';
    title.textContent = event.title;

    const when = document.createElement('span');
    when.className = 'event-when';
    when.textContent = event.ongoing
      ? `ongoing · ${formatSpan(event.durationMs)}`
      : `${formatSpan(event.durationMs)} · ended ${clockAt(event.endedAt)}`;

    li.append(icon, title, when);
    dom.events.append(li);
  }
}

/* ---------- helpers ---------- */

/** Maps a percentage history into the polyline of a 100x32 viewBox. */
function drawSparkline(svg, history) {
  const line = svg.querySelector('.spark-line');
  const area = svg.querySelector('.spark-area');

  if (!history || history.length < 2) {
    line.setAttribute('points', '');
    area.setAttribute('points', '');
    return;
  }

  const step = 100 / (history.length - 1);
  const points = history.map((value, index) => {
    const x = (index * step).toFixed(2);
    // Keeps 3px of headroom top and bottom so the stroke is never clipped
    // when usage sits at exactly 0% or 100%.
    const y = (29 - (Math.min(value, 100) / 100) * 26).toFixed(2);
    return `${x},${y}`;
  });

  line.setAttribute('points', points.join(' '));
  // Close the same path down to the baseline to get the tinted fill.
  area.setAttribute('points', `0,32 ${points.join(' ')} 100,32`);
}

function emptyRow(message) {
  const tr = document.createElement('tr');
  tr.className = 'empty';
  const td = document.createElement('td');
  td.colSpan = 3;
  td.textContent = message;
  tr.append(td);
  return tr;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 KB/s';
  const mb = bytesPerSecond / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSecond / 1024)} KB/s`;
}

/** Compact duration for the event log: 45s, 4m, 1h 12m. */
function formatSpan(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clockAt(timestamp) {
  return new Date(timestamp).toLocaleTimeString([], { hour12: false, timeStyle: 'short' });
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
