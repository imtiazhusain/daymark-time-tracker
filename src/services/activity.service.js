'use strict';

// One native idle-time query per second; no input hooks or event history.
class ActivityService {
  constructor({ getIdleSeconds, now = () => performance.now() }) {
    this.getIdleSeconds = getIdleSeconds;
    this.now = now;
    this.interval = null;
    this.totalMs = 0;
    this.activeMs = 0;
    this.failed = false;
  }

  start() {
    this.stop();
    this.totalMs = this.activeMs = 0;
    this.failed = false;
    this.lastSample = this.now();
    this.interval = setInterval(() => this.sample(), 1000);
    this.interval.unref?.();
  }

  sample() {
    if (!this.interval) return;
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastSample);
    this.lastSample = now;
    this.totalMs += elapsed;
    try {
      const idle = this.getIdleSeconds();
      if (!Number.isFinite(idle) || idle < 0) throw new Error('Invalid idle time');
      // Never assign a long sleep/event-loop gap entirely to recent input.
      if (idle < 1) this.activeMs += Math.min(elapsed, 1000);
    } catch (_) { this.failed = true; }
  }

  snapshot() {
    this.sample();
    const result = {
      activityPercentage: !this.failed && this.totalMs >= 1000
        ? Math.round(this.activeMs / this.totalMs * 100) : null,
      activityWindowSeconds: Math.round(this.totalMs / 1000),
      activityActiveSeconds: Math.round(this.activeMs / 1000)
    };
    this.totalMs = this.activeMs = 0;
    this.failed = false;
    return result;
  }

  stop() {
    clearInterval(this.interval);
    this.interval = null;
  }
}

module.exports = ActivityService;
