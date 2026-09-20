'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EventLog, MIN_REPORTABLE_MS } = require('../src/history/events');
const { BASE_TIME } = require('./helpers/fixtures');

const result = (findings) => ({ findings });
const f = (resource, level, title = `${resource} ${level}`) =>
  ({ resource, level, title, detail: 'detail' });

test('a resource going unhealthy opens an ongoing episode', () => {
  const log = new EventLog();
  log.record(result([f('memory', 'warn')]), BASE_TIME);

  const [event] = log.recent({ now: BASE_TIME + 30000 });
  assert.equal(event.resource, 'memory');
  assert.equal(event.level, 'warn');
  assert.equal(event.ongoing, true);
  assert.equal(event.durationMs, 30000);
});

test('healthy findings never open an episode', () => {
  const log = new EventLog();
  log.record(result([f('cpu', 'ok'), f('memory', 'ok')]), BASE_TIME);
  assert.equal(log.recent().length, 0);
});

test('an episode keeps the worst level it ever reached', () => {
  const log = new EventLog();
  log.record(result([f('cpu', 'warn', 'CPU elevated')]), BASE_TIME);
  log.record(result([f('cpu', 'critical', 'CPU pegged')]), BASE_TIME + 2000);
  log.record(result([f('cpu', 'warn', 'CPU elevated')]), BASE_TIME + 4000);

  const [event] = log.recent({ now: BASE_TIME + 6000 });
  assert.equal(event.level, 'critical', 'worst level was overwritten by the calmer tail');
  assert.equal(event.title, 'CPU pegged');
});

test('recovery closes the episode and fixes its duration', () => {
  const log = new EventLog();
  log.record(result([f('memory', 'warn')]), BASE_TIME);
  log.record(result([f('memory', 'ok')]), BASE_TIME + 60000);

  const [event] = log.recent({ now: BASE_TIME + 120000 });
  assert.equal(event.ongoing, false);
  assert.equal(event.durationMs, 60000, 'duration kept growing after recovery');
});

test('a resource dropping out of the findings entirely counts as recovery', () => {
  const log = new EventLog();
  log.record(result([f('process', 'warn')]), BASE_TIME);
  log.record(result([]), BASE_TIME + 30000);

  const [event] = log.recent();
  assert.equal(event.ongoing, false);
});

test('blips shorter than the reporting floor are discarded', () => {
  const log = new EventLog();
  log.record(result([f('cpu', 'warn')]), BASE_TIME);
  log.record(result([f('cpu', 'ok')]), BASE_TIME + MIN_REPORTABLE_MS - 1);

  assert.equal(log.recent().length, 0, 'a momentary blip was recorded as an episode');
});

test('an episode exactly at the floor is kept', () => {
  const log = new EventLog();
  log.record(result([f('cpu', 'warn')]), BASE_TIME);
  log.record(result([f('cpu', 'ok')]), BASE_TIME + MIN_REPORTABLE_MS);

  assert.equal(log.recent().length, 1);
});

test('resources are tracked independently', () => {
  const log = new EventLog();
  log.record(result([f('cpu', 'warn'), f('storage', 'critical')]), BASE_TIME);
  log.record(result([f('storage', 'critical')]), BASE_TIME + 30000);

  const events = log.recent({ now: BASE_TIME + 30000 });
  const cpu = events.find((e) => e.resource === 'cpu');
  const storage = events.find((e) => e.resource === 'storage');

  assert.equal(cpu.ongoing, false);
  assert.equal(storage.ongoing, true);
});

test('a resource can have a second episode after recovering', () => {
  const log = new EventLog();
  log.record(result([f('cpu', 'warn')]), BASE_TIME);
  log.record(result([f('cpu', 'ok')]), BASE_TIME + 60000);
  log.record(result([f('cpu', 'warn')]), BASE_TIME + 120000);

  const events = log.recent({ now: BASE_TIME + 150000 });
  assert.equal(events.length, 2);
  assert.equal(events[0].ongoing, true, 'newest episode should be first and open');
});

test('only the worst finding for a resource drives its episode', () => {
  const log = new EventLog();
  log.record(result([
    f('memory', 'warn', 'memory high'),
    f('memory', 'critical', 'memory exhausted')
  ]), BASE_TIME);

  const [event] = log.recent();
  assert.equal(event.level, 'critical');
  assert.equal(event.title, 'memory exhausted');
});

test('episodes are returned newest first and capped by limit', () => {
  const log = new EventLog();
  for (let i = 0; i < 5; i += 1) {
    const start = BASE_TIME + i * 100000;
    log.record(result([f('cpu', 'warn')]), start);
    log.record(result([f('cpu', 'ok')]), start + 50000);
  }

  const events = log.recent({ limit: 3, now: BASE_TIME + 600000 });
  assert.equal(events.length, 3);
  assert.ok(events[0].startedAt > events[1].startedAt);
  assert.ok(events[1].startedAt > events[2].startedAt);
});

test('the closed log does not grow without bound', () => {
  const log = new EventLog({ maxEvents: 3 });
  for (let i = 0; i < 10; i += 1) {
    const start = BASE_TIME + i * 100000;
    log.record(result([f('cpu', 'warn')]), start);
    log.record(result([f('cpu', 'ok')]), start + 50000);
  }

  assert.equal(log.closed.length, 3);
});
