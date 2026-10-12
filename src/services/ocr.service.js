'use strict';
const sharp = require('sharp');
const { createWorker } = require('tesseract.js');

class OCRService {
  constructor(options) {
    this.enabled = options.enabled;
    this.language = options.language;
    this.cachePath = options.cachePath;
    this.idleMs = options.idleSeconds * 1000;
    this.worker = null;
    this.creating = null;
    this.terminating = null;
    this.idleTimer = null;
    this.busy = false;
    this.stopping = false;
  }

  async getWorker() {
    if (this.stopping) throw new Error('OCR service is stopping');
    clearTimeout(this.idleTimer);
    if (this.terminating) await this.terminating;
    if (this.worker) return this.worker;
    if (!this.creating) {
      this.creating = createWorker(this.language, 1, this.cachePath ? { cachePath: this.cachePath } : {}).then(worker => {
        this.worker = worker;
        return worker;
      }).finally(() => { this.creating = null; });
    }
    return this.creating;
  }

  async recognize(filePath) {
    if (!this.enabled || this.stopping) return '';
    if (this.busy) return ''; // hard bound of one OCR job, no unbounded queue
    this.busy = true;
    try {
      const worker = await this.getWorker();
      // OCR receives a *downscaled grayscale* image, never full-resolution PNG.
      const grayscale = await sharp(filePath).grayscale().png().toBuffer();
      const result = await worker.recognize(grayscale);
      return (result.data?.text || '').trim();
    } finally {
      this.busy = false;
      if (!this.stopping && this.worker) this.scheduleIdleTermination();
    }
  }

  scheduleIdleTermination() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.busy && !this.creating) this.terminateWorker().catch(() => {});
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  async terminateWorker() {
    clearTimeout(this.idleTimer);
    if (this.terminating) return this.terminating;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      this.terminating = worker.terminate().finally(() => { this.terminating = null; });
      return this.terminating;
    }
  }

  async shutdown() {
    this.stopping = true;
    clearTimeout(this.idleTimer);
    if (this.creating) {
      try { await this.creating; } catch (_) { /* no initialized worker */ }
    }
    await this.terminateWorker();
  }
}
module.exports = OCRService;
