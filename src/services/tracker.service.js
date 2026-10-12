'use strict';
const { localTime, formatDuration, errorMessage } = require('../utils/format');

class TrackerService {
  constructor({ timer, screenshots, ocr, activity = null, screenshotIntervalSeconds, onTick = null }) {
    this.activity = activity;
    this.onTick = onTick;
    this.timer = timer;
    this.screenshots = screenshots;
    this.ocr = ocr;
    this.intervalMs = screenshotIntervalSeconds * 1000;
    this.status = 'idle';
    this.captureTimeout = null;
    this.tickPromise = null;
    this.stopping = false;
  }

  async start() {
    this.status = 'running';
    this.timer.start();
    this.activity?.start();
    this.scheduleCapture(0);
  }

  scheduleCapture(delay) {
    clearTimeout(this.captureTimeout);
    if (this.status !== 'running' || this.stopping) return;
    this.captureTimeout = setTimeout(() => { void this.tick(); }, delay);
  }

  async tick() {
    if (this.tickPromise || this.status !== 'running' || this.stopping) return;
    this.tickPromise = (async () => {
      const started = new Date();
      try {
        const activity = this.activity?.snapshot() || { activityPercentage: null };
        const stats = await this.screenshots.capture(() => this.status === 'running' && !this.stopping, activity);
        console.log(`[${localTime(started)}] screenshots=${stats.saved} unchanged=${stats.unchanged} pending=${this.screenshots.queue.items.length} errors=${stats.errors}`);
        if (this.onTick) {
          try { await this.onTick(stats); }
          catch (err) { console.warn(`[capture] UI update: ${errorMessage(err)}`); }
        }
      } catch (error) {
        console.warn(`[capture] Tick failed: ${errorMessage(error)}`);
      }
    })();
    try { await this.tickPromise; }
    finally {
      this.tickPromise = null;
      this.scheduleCapture(this.intervalMs); // sequential chain; no overlapping captures
    }
  }

  async pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    this.activity?.stop();
    clearTimeout(this.captureTimeout);
    await this.timer.pause();
    console.log(`Paused. Time today: ${formatDuration(this.timer.getTodaySeconds())}`);
  }

  async resume() {
    if (this.status !== 'paused') return;
    this.status = 'running';
    await this.timer.resume();
    this.activity?.start();
    this.scheduleCapture(0);
    console.log('Resumed tracking.');
  }

  async printStatus() {
    if (this.timer.running) {
      this.timer.recordHeartbeat(); // include elapsed time since the last scheduled heartbeat
      void this.timer.syncAll();
    }
    const taken = await this.screenshots.countToday();
    console.log(`Status: ${this.status} | Today: ${formatDuration(this.timer.getTodaySeconds())} | Last capture: ${this.screenshots.lastScreenshotAt?.toLocaleTimeString() || 'none this run'} | Screenshots today: ${taken}`);
  }

  async shutdown() {
    if (this.stopping) return;
    this.stopping = true;
    this.status = 'stopped';
    this.activity?.stop();
    clearTimeout(this.captureTimeout);
    // Close time tracking immediately; don't count a possibly long OCR shutdown.
    await this.timer.stop();
    if (this.tickPromise) await this.tickPromise.catch(() => {});
    await this.screenshots.queue.flush();
    await this.ocr.shutdown();
  }
}

module.exports = TrackerService;
