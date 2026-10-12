'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const screenshot = require('screenshot-desktop');
const sharp = require('sharp');
const ScreenshotData = require('../models/ScreenshotData');
const db = require('../config/db');
const { localDateKey, localTime, fileTime, errorMessage } = require('../utils/format');
const { atomicJsonWrite } = require('./timer.service');
const { getActiveWindow } = require('./window.service');
const { meanPixelDifference } = require('../utils/image');

function machineInfo() {
  return { hostname: os.hostname(), platform: process.platform, username: os.userInfo().username };
}

class PendingRecords {
  constructor(file) {
    this.file = file;
    if (fs.existsSync(file)) {
      try {
        const contents = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!Array.isArray(contents)) throw new Error('Expected a JSON array');
        this.items = contents;
      } catch (error) {
        throw new Error(`Cannot load pending-records.json; refusing to overwrite: ${errorMessage(error)}`);
      }
    } else {
      this.items = [];
    }
    this.flushing = null;
    this.reportedFailure = false;
  }

  enqueue(record) {
    this.items.push(record);
    atomicJsonWrite(this.file, this.items);
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this._flush().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  async _flush() {
    if (this.items.length === 0 || !await db.ensureConnected()) return;
    while (this.items.length) {
      const item = this.items[0];
      try {
        await ScreenshotData.updateOne(
          { captureId: item.captureId }, { $setOnInsert: item }, { upsert: true }
        );
        this.items.shift();
        atomicJsonWrite(this.file, this.items);
        this.reportedFailure = false;
      } catch (error) {
        if (!this.reportedFailure) console.warn(`[capture] DB insert queued locally: ${errorMessage(error)}`);
        this.reportedFailure = true;
        break;
      }
    }
  }

  countPending(userId, date) {
    return this.items.filter(item => String(item.user) === String(userId) && item.date === date).length;
  }
}

// The raw screenshot buffer is scoped inside this call and becomes eligible
// for garbage collection before window lookup, hashing, OCR or DB insertion.
async function saveScaledScreenshot(displayId, directory, filename, maxWidth, quality) {
  const raw = await screenshot({ screen: displayId, format: 'jpg' });
  const absolute = path.join(directory, filename);
  await sharp(raw).rotate().resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: false }).toFile(absolute);
  return absolute;
}

class ScreenshotService {
  constructor({ user, screenshotDir, imageMaxWidth, imageQuality, ocr, pendingRecords }) {
    this.user = user;
    this.dir = screenshotDir;
    this.maxWidth = imageMaxWidth;
    this.quality = imageQuality;
    this.ocr = ocr;
    this.queue = pendingRecords;
    this.previous = new Map(); // 256 bytes per monitor, plus last OCR text
    this.lastScreenshotAt = null;
    this.lastScreenshotPath = null;
    this.lastCapture = null;
    this.machine = machineInfo();
    this.startedAt = new Date();
    this.takenThisRun = new Map();
  }

  async capture(isRunning = () => true, activity = { activityPercentage: null }) {
    if (!isRunning()) return { saved: 0, unchanged: 0, errors: 0 };
    let screens;
    try {
      screens = await screenshot.listDisplays();
      if (!screens.length) screens = [{ id: undefined }];
    } catch (_) { screens = [{ id: undefined }]; }

    const window = await getActiveWindow();
    const stats = { saved: 0, unchanged: 0, errors: 0 };
    for (const [index, display] of screens.entries()) {
      if (!isRunning()) break;
      try {
        const now = new Date();
        const date = localDateKey(now);
        const folder = path.resolve(this.dir, date);
        await fs.promises.mkdir(folder, { recursive: true });
        const filename = `${fileTime(now)}-screen${index + 1}.jpg`;
        const filePath = await saveScaledScreenshot(display.id, folder, filename, this.maxWidth, this.quality);
        if (!isRunning()) {
          await fs.promises.unlink(filePath).catch(() => {});
          break;
        }

        const thumb = await sharp(filePath).resize(16, 16, { fit: 'fill' })
          .grayscale().raw().toBuffer();
        const displayKey = String(display.id ?? index);
        const previous = this.previous.get(displayKey);
        const unchanged = !!previous && previous.title === window.title &&
          meanPixelDifference(previous.hash, thumb) <= 2.5;
        let extractedText = previous?.text || '';
        if (!unchanged) {
          try { extractedText = await this.ocr.recognize(filePath); }
          catch (error) {
            console.warn(`[ocr] ${errorMessage(error)}`);
            extractedText = '';
            stats.errors++;
          }
        }
        if (!isRunning()) {
          await fs.promises.unlink(filePath).catch(() => {});
          break;
        }
        this.previous.set(displayKey, { title: window.title, hash: thumb, text: extractedText });
        // Local queue is written to disk before attempting MongoDB I/O.
        const record = {
          captureId: randomUUID(), user: String(this.user._id), userName: this.user.name,
          date, time: localTime(now), timestamp: now.toISOString(),
          machine: this.machine, screenshotPath: filePath, screen: index + 1,
          activeWindow: window, extractedText, unchanged, ...activity, createdAt: new Date().toISOString()
        };
        this.queue.enqueue(record);
        stats.saved++;
        if (unchanged) stats.unchanged++;
        this.lastScreenshotAt = now;
        this.lastScreenshotPath = filePath;
        this.lastCapture = { activeWindow: window, screen: index + 1, unchanged, ...activity };
        this.takenThisRun.set(date, (this.takenThisRun.get(date) || 0) + 1);
      } catch (error) {
        stats.errors++;
        console.warn(`[capture] Screen ${index + 1}: ${errorMessage(error)}`);
      }
    }
    await this.queue.flush();
    return stats;
  }

  async countToday() {
    const date = localDateKey();
    const pending = this.queue.countPending(this.user._id, date);
    if (await db.ensureConnected()) {
      try {
        const server = await ScreenshotData.countDocuments({ user: this.user._id, date });
        return server + pending;
      } catch (_) { /* offline fallback below */ }
    }
    const olderPending = this.queue.items.filter(item => String(item.user) === String(this.user._id)
      && item.date === date && new Date(item.timestamp) < this.startedAt).length;
    return olderPending + (this.takenThisRun.get(date) || 0);
  }
}

module.exports = { ScreenshotService, PendingRecords, meanPixelDifference };
