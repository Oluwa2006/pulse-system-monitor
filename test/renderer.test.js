'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountRenderer, makeFrame } = require('./helpers/renderer-harness');
const { makeProcess, GB, MB } = require('./helpers/fixtures');

/** First number of an SVG stroke-dasharray, which is the drawn arc length. */
const arcLength = (node) => Number(node.getAttribute('stroke-dasharray').split(' ')[0]);
const points = (node) => node.getAttribute('points').trim().split(/\s+/).filter(Boolean);

/* ── bootstrap ────────────────────────────────────────────────────── */

test('the renderer loads without throwing and asks for data', () => {
  // Regression: drawRadarWeb() once ran above the consts it depended on, so
  // the temporal dead zone threw here, ready() never fired, and every value
  // on the dashboard stayed a placeholder dash.
  const ui = mountRenderer();
  assert.equal(ui.calls.ready, 1, 'renderer never called ready()');
});

test('the static radar web is drawn at load, before any data arrives', () => {
  const ui = mountRenderer();
  assert.equal(ui.$$('#radar-web polygon').length, 3, 'expected three rings');
  assert.equal(ui.$$('#radar-web line').length, 3, 'expected three spokes');
  assert.deepEqual(ui.$$('#radar-labels text').map((n) => n.textContent),
    ['CPU', 'MEMORY', 'STORAGE']);
});

/* ── status bar ───────────────────────────────────────────────────── */

test('health is shown with its level and in the HUD underscore style', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ storage: { percent: 96, freeBytes: GB } }));

  assert.equal(ui.text('#health-value'), 'NEEDS_ATTENTION');
  assert.equal(ui.$('#health').dataset.level, 'critical');
});

test('a healthy machine reads GOOD', () => {
  const ui = mountRenderer();
  ui.push(makeFrame());
  assert.equal(ui.text('#health-value'), 'GOOD');
  assert.equal(ui.$('#health').dataset.level, 'ok');
});

test('system identity is populated from the snapshot', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ system: { hostname: 'test-host', coreCount: 8 } }));

  assert.equal(ui.text('#meta-host'), 'test-host');
  assert.equal(ui.text('#meta-cores'), '8');
  assert.match(ui.text('#meta-uptime'), /^\d+[hm]/);
});

/* ── readouts ─────────────────────────────────────────────────────── */

test('CPU shows its current figure and rolling average', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ cpu: { usage: 63.4, average: 58.2, cores: 10 } }));

  assert.equal(ui.text('#cpu-value'), '63%');
  assert.match(ui.text('#cpu-foot'), /58\.2%/);
  assert.match(ui.text('#cpu-foot'), /10/);
});

test('gauge arcs are drawn in proportion to the value', () => {
  const ui = mountRenderer();

  ui.push(makeFrame({ cpu: { usage: 0 } }));
  assert.equal(arcLength(ui.$('#cpu-gauge')), 0, 'empty gauge drew an arc');

  ui.push(makeFrame({ cpu: { usage: 100 } }));
  const full = arcLength(ui.$('#cpu-gauge'));

  ui.push(makeFrame({ cpu: { usage: 50 } }));
  const half = arcLength(ui.$('#cpu-gauge'));

  assert.ok(full > 0);
  assert.ok(Math.abs(half / full - 0.5) < 0.01, `half gauge was ${half / full} of full`);
});

test('a gauge cannot overshoot its track', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ cpu: { usage: 100 } }));
  const full = arcLength(ui.$('#cpu-gauge'));

  // Latency has no ceiling, so the network gauge is the one that could run over.
  ui.push(makeFrame({ network: { connected: true, latencyMs: 5000 } }));
  assert.ok(arcLength(ui.$('#network-gauge')) <= full + 0.01,
    'network gauge exceeded a full sweep');
});

test('memory is reported in bytes with the free remainder', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ memory: { usedBytes: 13.5 * GB, totalBytes: 16 * GB, freeBytes: 2.5 * GB, percent: 84 } }));

  assert.equal(ui.text('#memory-value'), '13.5GB');
  assert.match(ui.text('#memory-foot'), /84%/);
  assert.match(ui.text('#memory-foot'), /2\.5GB/);
});

test('the storage meter width tracks the percentage used', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ storage: { percent: 94, freeBytes: 11.6 * GB } }));
  assert.equal(ui.$('#storage-meter').style.width, '94%');
});

test('an unreachable network says so instead of printing a null latency', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ network: { connected: false, latencyMs: null } }));

  assert.equal(ui.text('#network-value'), 'OFFLINE');
  assert.doesNotMatch(ui.text('#network-value'), /null|NaN/);
  assert.equal(arcLength(ui.$('#network-gauge')), 0);
});

test('severity reaches the card, not just the feed', () => {
  const ui = mountRenderer();

  ui.push(makeFrame({ storage: { percent: 96, freeBytes: GB } }));
  assert.ok(ui.$('#card-storage').classList.contains('card-crit'));

  // And clears again on recovery rather than sticking.
  ui.push(makeFrame({ storage: { percent: 10, freeBytes: 400 * GB } }));
  assert.equal(ui.$('#card-storage').classList.contains('card-crit'), false);
  assert.equal(ui.$('#card-storage').classList.contains('card-alert'), false);
});

/* ── geometry ─────────────────────────────────────────────────────── */

test('a sparkline plots one point per sample, newest last', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ cpu: { history: [10, 20, 30, 40] } }));
  assert.equal(points(ui.$('#cpu-spark .spark-line')).length, 4);
});

test('sparkline extremes sit inside the box, with 100% above 0%', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ cpu: { history: [0, 100] } }));

  const [low, high] = points(ui.$('#cpu-spark .spark-line')).map((p) => Number(p.split(',')[1]));
  // Smaller y is higher on screen.
  assert.ok(high < low, '100% did not plot above 0%');
  assert.ok(high >= 0 && low <= 30, 'a point fell outside the viewBox');
});

test('a single sample draws no line rather than a broken one', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ cpu: { history: [42] } }));
  assert.equal(ui.$('#cpu-spark .spark-line').getAttribute('points'), '');
});

test('one sensor bar is drawn per core, sized by that core', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ cpu: { perCore: [100, 50, 0, 25] } }));

  const bars = ui.$$('.core-fill');
  assert.equal(bars.length, 4);
  assert.equal(bars[0].style.height, '100%');
  assert.equal(bars[1].style.height, '50%');
  // Idle cores keep a sliver so the bar reads as present but empty.
  assert.equal(bars[2].style.height, '2%');
  assert.deepEqual(ui.$$('.core-key').map((n) => n.textContent), ['00', '01', '02', '03']);
});

test('the radar plots one vertex per axis and scales with the readings', () => {
  const ui = mountRenderer();

  ui.push(makeFrame({ cpu: { usage: 100 }, memory: { percent: 100 }, storage: { percent: 100 } }));
  const outer = points(ui.$('#radar-now'));
  assert.equal(outer.length, 3);

  ui.push(makeFrame({ cpu: { usage: 10 }, memory: { percent: 10 }, storage: { percent: 10 } }));
  const inner = points(ui.$('#radar-now'));

  const spread = (pts) => Math.max(...pts.map((p) => Math.abs(Number(p.split(',')[0]) - 105)));
  assert.ok(spread(inner) < spread(outer), 'a quiet machine did not draw a smaller shape');
});

test('the radar keeps a trail of earlier samples', () => {
  const ui = mountRenderer();
  for (let i = 0; i < 4; i += 1) ui.push(makeFrame({ cpu: { usage: i * 10 } }));

  // Four samples in: three history shapes behind the current one.
  assert.equal(ui.$$('#radar-trail polygon').length, 3);
});

/* ── processes ────────────────────────────────────────────────────── */

const procFrame = () => makeFrame({
  processes: {
    total: 600, groups: 300,
    byCpu: Array.from({ length: 12 }, (_, i) =>
      makeProcess({ name: `Cpu${i}`, cpu: 90 - i, memoryBytes: 100 * MB })),
    byMemory: [makeProcess({ name: 'Hog', memoryBytes: 4 * GB, processCount: 28 })]
  }
});

test('the process table lists applications in the order given', () => {
  const ui = mountRenderer();
  ui.push(procFrame());

  const names = ui.$$('.ptable tbody .pname span').map((n) => n.textContent);
  assert.equal(names[0], 'Cpu0');
  assert.match(ui.text('#process-foot'), /600_PROCESSES/);
  assert.match(ui.text('#process-foot'), /300_APPS/);
});

test('the table is capped so a busy machine cannot overflow the panel', () => {
  const ui = mountRenderer();
  ui.push(procFrame());
  assert.equal(ui.$$('.ptable tbody tr').length, 7);
});

test('the multi-process badge appears only for grouped applications', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({
    processes: {
      byCpu: [
        makeProcess({ name: 'Grouped', processCount: 28 }),
        makeProcess({ name: 'Single', processCount: 1 })
      ]
    }
  }));

  const rows = ui.$$('.ptable tbody tr');
  assert.equal(rows[0].querySelector('.pcount').textContent, '×28');
  assert.equal(rows[1].querySelector('.pcount'), null);
});

test('the CPU/MEMORY toggle re-sorts without needing a new snapshot', () => {
  const ui = mountRenderer();
  ui.push(procFrame());
  assert.equal(ui.$$('.ptable tbody .pname span')[0].textContent, 'Cpu0');

  ui.click('[data-sort="memory"]');

  assert.equal(ui.$$('.ptable tbody .pname span')[0].textContent, 'Hog');
  assert.ok(ui.$('[data-sort="memory"]').classList.contains('is-active'));
  assert.equal(ui.$('[data-sort="cpu"]').classList.contains('is-active'), false);
});

test('an unreadable process list shows a message, not an empty table', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ processes: { byCpu: [], byMemory: [] } }));
  assert.match(ui.text('.ptable tbody .empty'), /No_processes/);
});

/* ── activity feed ────────────────────────────────────────────────── */

test('the feed opens on findings with problems above healthy checks', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({ storage: { percent: 96, freeBytes: GB } }));

  const levels = ui.$$('.feed-item').map((n) => n.dataset.level);
  assert.equal(levels[0], 'critical', 'a healthy check outranked a critical one');
  assert.ok(levels.length >= 4);
});

test('switching to events lists episodes with their duration', () => {
  const ui = mountRenderer();
  ui.push(makeFrame({}, {
    events: [{
      resource: 'storage', level: 'critical', title: 'Storage almost full',
      detail: 'detail', startedAt: 0, endedAt: null, ongoing: true, durationMs: 90000
    }],
    observedMs: 600000
  }));

  ui.click('[data-feed="events"]');

  assert.equal(ui.$$('.feed-item').length, 1);
  assert.match(ui.text('.feed-when'), /ONGOING/);
  assert.match(ui.text('.feed-when'), /1m/);
  assert.ok(ui.$('.feed-item').classList.contains('is-ongoing'));
  assert.match(ui.text('#observed'), /WATCHING/);
});

test('an empty event log explains itself instead of showing nothing', () => {
  const ui = mountRenderer();
  ui.push(makeFrame());
  ui.click('[data-feed="events"]');

  assert.equal(ui.$$('.feed-item').length, 0);
  assert.match(ui.text('.feed-empty'), /Nothing_to_report/);
});

test('a metrics failure surfaces in the interface rather than freezing it', () => {
  const ui = mountRenderer();
  ui.fail({ message: 'ps exited with code 1' });

  assert.equal(ui.text('#health-value'), 'READ_FAILED');
  assert.equal(ui.$('#health').dataset.level, 'critical');
  assert.match(ui.text('.feed-item .feed-detail'), /ps exited/);
});
