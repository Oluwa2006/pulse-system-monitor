'use strict';

/**
 * Records each stretch of time a resource spent unhealthy.
 *
 * The dashboard only ever shows now. Without this, a machine that was pegged
 * for six minutes while you were at lunch looks identical to one that has
 * been idle all day.
 */

const LEVELS = { ok: 0, warn: 1, critical: 2 };
const DEFAULT_MAX_EVENTS = 40;

// Anything shorter than this was a blip, not an episode worth reporting.
const MIN_REPORTABLE_MS = 6000;

class EventLog {
  constructor({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    this.maxEvents = maxEvents;
    /** @type {Map<string, object>} resource -> the episode currently open */
    this.open = new Map();
    /** @type {Array<object>} closed episodes, newest last */
    this.closed = [];
  }

  /**
   * Folds one diagnostics result into the log, opening, escalating and
   * closing episodes as levels change.
   */
  record(diagnostics, timestamp) {
    const worstByResource = new Map();

    for (const f of diagnostics.findings) {
      if (f.level === 'ok') continue;
      const current = worstByResource.get(f.resource);
      if (!current || LEVELS[f.level] > LEVELS[current.level]) {
        worstByResource.set(f.resource, f);
      }
    }

    // Open or escalate.
    for (const [resource, finding] of worstByResource) {
      const episode = this.open.get(resource);

      if (!episode) {
        this.open.set(resource, {
          resource,
          level: finding.level,
          title: finding.title,
          detail: finding.detail,
          startedAt: timestamp,
          endedAt: null
        });
        continue;
      }

      // Keep the worst level and the description that went with it, so a
      // brief spike to critical is not overwritten by the calmer tail.
      if (LEVELS[finding.level] > LEVELS[episode.level]) {
        episode.level = finding.level;
        episode.title = finding.title;
        episode.detail = finding.detail;
      }
    }

    // Close anything that recovered.
    for (const [resource, episode] of [...this.open]) {
      if (worstByResource.has(resource)) continue;
      episode.endedAt = timestamp;
      this.open.delete(resource);

      if (episode.endedAt - episode.startedAt >= MIN_REPORTABLE_MS) {
        this.closed.push(episode);
        while (this.closed.length > this.maxEvents) this.closed.shift();
      }
    }
  }

  /**
   * Episodes newest first, open ones included and marked ongoing.
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {number} [options.now] used to age open episodes
   */
  recent({ limit = 6, now = Date.now() } = {}) {
    const ongoing = [...this.open.values()].map((e) => ({
      ...e,
      ongoing: true,
      durationMs: Math.max(now - e.startedAt, 0)
    }));

    const finished = this.closed.map((e) => ({
      ...e,
      ongoing: false,
      durationMs: Math.max(e.endedAt - e.startedAt, 0)
    }));

    return [...ongoing, ...finished]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  }
}

module.exports = { EventLog, MIN_REPORTABLE_MS };
