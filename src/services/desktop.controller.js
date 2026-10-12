'use strict';

// Electron-independent application controller. The renderer never receives
// mongoose, a file-system primitive, or unvalidated IPC arguments.
const fs = require('fs');
const dotenv = require('dotenv');
const path = require('path');
const { EventEmitter } = require('events');
const { loadMongoUri, saveMongoUri } = require('./connection-settings');
const { mongoose, ensureConnected, isConnected, disconnect } = require('../config/db');
const User = require('../models/User');
const DailySummary = require('../models/DailySummary');
const { LocalState, TimerService, atomicJsonWrite } = require('./timer.service');
const { ScreenshotService, PendingRecords } = require('./screenshot.service');
const OCRService = require('./ocr.service');
const TrackerService = require('./tracker.service');
const { positiveInt, localDateKey, errorMessage } = require('../utils/format');

const DEFAULT_PREFS = Object.freeze({
  screenshotIntervalSeconds: 120, heartbeatSeconds: 30,
  imageMaxWidth: 1280, imageQuality: 60,
  ocrEnabled: true, ocrLanguage: 'eng', ocrIdleTerminateSeconds: 300
});

function safePrefs(raw = {}) {
  return {
    screenshotIntervalSeconds: positiveInt(raw.screenshotIntervalSeconds, 120, 15, 86400),
    heartbeatSeconds: positiveInt(raw.heartbeatSeconds, 30, 5, 3600),
    imageMaxWidth: positiveInt(raw.imageMaxWidth, 1280, 256, 3840),
    imageQuality: positiveInt(raw.imageQuality, 60, 10, 95),
    ocrEnabled: raw.ocrEnabled !== false,
    ocrLanguage: 'eng',
    ocrIdleTerminateSeconds: positiveInt(raw.ocrIdleTerminateSeconds, 300, 30, 86400)
  };
}

class DesktopController extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.envPath = path.join(dataDir, '.env');
    this.prefsPath = path.join(dataDir, 'preferences.json');
    this.selectionPath = path.join(dataDir, 'selection.json');
    this.screenshotDir = path.join(dataDir, 'screenshots');
    this.state = null;
    this.queue = null;
    this.users = [];
    this.user = null;
    this.timer = null;
    this.tracker = null;
    this.screenshots = null;
    this.ocr = null;
    this.lastCaptureAt = null;
    this.screenshotCount = 0;
    this.lastTick = null;
    this.lastError = null;
    this.closed = false;
    this.commandChain = Promise.resolve();
    this.prefs = { ...DEFAULT_PREFS };
    this.started = false;
    this.lastSelectedUserId = null;
    this.retryTimer = null;
    this.retryInFlight = false;
    this.onDisconnect = () => this.scheduleReconnect();
  }

  runExclusive(fn) {
    const task = this.commandChain.then(() => {
      if (this.closed) throw new Error('The application is closing.');
      return fn();
    });
    this.commandChain = task.catch(() => {});
    return task;
  }

  async initialize() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const savedUri = loadMongoUri(this.envPath);
    if (savedUri) process.env.MONGODB_URI = savedUri;
    
      // Read capture settings from .env instead of preferences.json
const captureEnvPath = [
  // Development: project root .env
  path.resolve(__dirname, '..', '..', '.env'),

  // Packaged Windows EXE: .env beside executable
  path.join(path.dirname(process.execPath), '.env')
].find(file => fs.existsSync(file));

const env = captureEnvPath
  ? dotenv.parse(fs.readFileSync(captureEnvPath))
  : {};

this.prefs = safePrefs({
  screenshotIntervalSeconds: env.SCREENSHOT_INTERVAL_SECONDS,
  heartbeatSeconds: env.HEARTBEAT_SECONDS,
  imageMaxWidth: env.IMAGE_MAX_WIDTH,
  imageQuality: env.IMAGE_QUALITY,
  ocrEnabled: String(env.OCR_ENABLED ?? 'true').toLowerCase() !== 'false',
  ocrIdleTerminateSeconds: env.OCR_IDLE_TERMINATE_SECONDS
});

console.log(
  `[Daymark] Screenshot interval: ${this.prefs.screenshotIntervalSeconds} seconds`
);
    
    if (fs.existsSync(this.selectionPath)) {
      const selected = JSON.parse(fs.readFileSync(this.selectionPath, 'utf8'));
      if (/^[a-f\d]{24}$/i.test(String(selected.userId || ''))) {
        this.lastSelectedUserId = String(selected.userId);
      }
    }
    this.state = new LocalState(path.join(this.dataDir, 'state.json'));
    this.state.closeAbandonedSessions();
    this.queue = new PendingRecords(path.join(this.dataDir, 'pending-records.json'));
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'ocr-cache'), { recursive: true });
    mongoose.connection.on('disconnected', this.onDisconnect);
    await this.reloadUsers();
    await this.restoreSelectedUser();
    void this.queue.flush().catch(err => this.logError(err));
    this.scheduleReconnect();
  }

  logError(err) {
    this.lastError = errorMessage(err);
    console.warn(`[desktop] ${this.lastError}`);
    this.emit('update', this.getStatus());
  }

  async reloadUsers() {
    let fresh = [];
    if (await ensureConnected(true)) {
      try {
        fresh = await User.find().sort({ name: 1 }).lean();
        this.state.cacheUsers(fresh);
      } catch (err) { this.logError(err); }
    }
    this.users = (fresh.length ? fresh : this.state.data.users || [])
      .map(u => ({ _id: String(u._id), name: String(u.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    this.emit('update', this.getStatus());
    return this.users;
  }

  async restoreSelectedUser() {
    if (!this.user && this.lastSelectedUserId &&
        this.users.some(u => u._id === this.lastSelectedUserId)) {
      try { await this.selectUser(this.lastSelectedUserId); }
      catch (err) { this.logError(err); }
    }
  }

  // Retry only while Atlas is disconnected. A single delayed attempt avoids
  // a busy loop; tracking remains entirely local during network outages.
  scheduleReconnect() {
    if (this.closed || this.retryTimer || this.retryInFlight ||
        !process.env.MONGODB_URI || isConnected()) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.retryConnection();
    }, 30000);
  }

  async retryConnection() {
    if (this.closed || this.retryInFlight || !process.env.MONGODB_URI) return;
    this.retryInFlight = true;
    try {
      if (await ensureConnected(true)) {
        await this.reloadUsers();
        await this.restoreSelectedUser();
        if (this.timer) await this.timer.syncAll();
        await this.queue?.flush();
        this.emit('update', this.getStatus());
      }
    } catch (err) { this.logError(err); }
    finally {
      this.retryInFlight = false;
      this.scheduleReconnect();
    }
  }

  async seedUsers() {
    return this.runExclusive(async () => {
      if (!(await ensureConnected(true))) throw new Error('Connect MongoDB Atlas before adding users.');
      for (const name of ['Saifullah', 'Hizbullah']) {
        await User.updateOne({ name }, { $setOnInsert: { name } }, { upsert: true });
      }
      await this.reloadUsers();
      return this.users;
    });
  }

  async selectUser(id) {
    return this.runExclusive(async () => {
      if (this.tracker && ['running', 'paused'].includes(this.tracker.status)) {
        throw new Error('Stop tracking before switching users.');
      }
      if (!/^[a-fA-F0-9]{24}$/.test(String(id))) throw new Error('Invalid user selection.');
      const user = this.users.find(u => u._id === id);
      if (!user) throw new Error('Selected user is not available.');
      this.user = user;
      this.lastSelectedUserId = id;
      atomicJsonWrite(this.selectionPath, { userId: id });
      this.timer = new TimerService({ state: this.state, user,
        heartbeatSeconds: this.prefs.heartbeatSeconds });
      const day = localDateKey();
      if (await ensureConnected()) {
        try {
          const summary = await DailySummary.findOne({ user: id, date: day }).lean();
          if (summary) {
            const applied = summary.syncSources?.[this.state.data.installationId]?.seconds || 0;
            this.timer.setServerSummary(day, summary.totalSeconds, applied);
          }
        } catch (err) { this.logError(err); }
      }
      await this.timer.syncAll();
      this.screenshotCount = this.queue.countPending(id, day);
      if (isConnected()) {
        try {
          const ScreenshotData = require('../models/ScreenshotData');
          this.screenshotCount += await ScreenshotData.countDocuments({ user: id, date: day });
        } catch (err) { this.logError(err); }
      }
      this.lastCaptureAt = null;
      this.lastTick = null;
      this.emit('update', this.getStatus());
      return this.getStatus();
    });
  }

  async start() {
    return this.runExclusive(async () => {
      if (!this.user || !this.timer) throw new Error('Select a user first.');
      if (this.tracker?.status === 'running') return this.getStatus();
      if (this.tracker?.status === 'paused') {
        await this.tracker.resume();
      } else {
        this.ocr = new OCRService({ enabled: this.prefs.ocrEnabled,
          language: this.prefs.ocrLanguage,
          cachePath: path.join(this.dataDir, 'ocr-cache'),
          idleSeconds: this.prefs.ocrIdleTerminateSeconds });
        this.screenshots = new ScreenshotService({ user: this.user,
          screenshotDir: this.screenshotDir,
          imageMaxWidth: this.prefs.imageMaxWidth,
          imageQuality: this.prefs.imageQuality,
          ocr: this.ocr, pendingRecords: this.queue });
        this.tracker = new TrackerService({ timer: this.timer,
          screenshots: this.screenshots, ocr: this.ocr,
          screenshotIntervalSeconds: this.prefs.screenshotIntervalSeconds,
          onTick: async stats => {
            this.lastTick = stats;
            this.lastCaptureAt = this.screenshots.lastScreenshotAt?.toISOString() || this.lastCaptureAt;
            if (stats.saved > 0) {
  this.emit('screenshot-captured', {
    count: stats.saved
  });
}
            try { this.screenshotCount = await this.screenshots.countToday(); }
            catch (err) { this.logError(err); }
            this.emit('update', this.getStatus());
          }
        });
        await this.tracker.start();
      }
      this.started = true;
      this.emit('update', this.getStatus());
      return this.getStatus();
    });
  }

  async pause() {
    return this.runExclusive(async () => {
      if (this.tracker?.status === 'running') await this.tracker.pause();
      this.emit('update', this.getStatus());
      return this.getStatus();
    });
  }

  async stop() {
    return this.runExclusive(async () => {
      if (this.tracker) await this.tracker.shutdown();
      this.tracker = null;
      this.emit('update', this.getStatus());
      return this.getStatus();
    });
  }

  async saveConnection(uri) {
    return this.runExclusive(async () => {
      if (this.tracker) throw new Error('Stop tracking before changing the connection.');
      // Stored atomically in the user's app data directory, never sent back to the UI.
      const normalized = saveMongoUri(this.envPath, uri);
      process.env.MONGODB_URI = normalized;
      await disconnect();
      const online = await ensureConnected(true);
      await this.reloadUsers();
      await this.restoreSelectedUser();
      if (!online) this.scheduleReconnect();
      this.emit('update', this.getStatus());
      return { connected: online };
    });
  }

  async savePreferences(raw) {
    return this.runExclusive(async () => {
      if (this.tracker) throw new Error('Stop tracking before editing settings.');
      const prefs = safePrefs(raw);
      atomicJsonWrite(this.prefsPath, prefs);
      this.prefs = prefs;
      if (this.user) this.timer.heartbeatSeconds = prefs.heartbeatSeconds;
      this.emit('update', this.getStatus());
      return this.getStatus();
    });
  }

  async getMonthHistory(month) {
  if (
    typeof month !== 'string' ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  ) {
    throw new Error('Invalid month. Use YYYY-MM.');
  }

  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));

  if (year < 1970 || year > 2100) {
    throw new Error('Year out of range.');
  }

  if (!this.user || !this.state) {
    throw new Error('Select a user on Overview first.');
  }

  const userId = String(this.user._id);
  const userName = this.user.name;
  const installationId = this.state.data.installationId;

  const remoteDays = new Map();
  let connected = false;

  // Read all saved days for this user and month.
  if (await ensureConnected()) {
    try {
      const records = await DailySummary.find({
        user: userId,
        date: {
          $gte: `${month}-01`,
          $lte: `${month}-31`
        }
      })
        .select('date totalSeconds syncSources')
        .lean();

      for (const record of records) {
        remoteDays.set(record.date, record);
      }

      connected = true;
    } catch (error) {
      this.logError(error);
    }
  }

  const days = [];
  const daysInMonth = new Date(
    year, monthNumber, 0
  ).getDate();

  let totalSeconds = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;

    const local = this.state.getDay(
      userId, date, userName, false
    );

    const remote = remoteDays.get(date);
    let seconds = 0;

    if (remote) {
      const source = remote.syncSources instanceof Map
        ? remote.syncSources.get(installationId)
        : remote.syncSources?.[installationId];

      const alreadySynced = Number(source?.seconds || 0);

      seconds =
        Number(remote.totalSeconds || 0) +
        Math.max(
          0,
          Number(local?.sourceSeconds || 0) - alreadySynced
        );
    } else if (local) {
      // Use the last cached Atlas total when offline.
      seconds =
        Number(local.serverTotal || 0) +
        Math.max(
          0,
          Number(local.sourceSeconds || 0) -
          Number(local.acknowledgedSeconds || 0)
        );
    }

    seconds = Math.max(0, Math.floor(seconds));

    days.push({ date, seconds });
    totalSeconds += seconds;
  }

  return {
    month,
    userName,
    connected,
    totalSeconds,
    days
  };
}

  getStatus() {
    const running = this.tracker?.status === 'running';
    let uncommitted = 0;
    if (running && this.timer?.lastTickNs !== null) {
      const ns = process.hrtime.bigint() - this.timer.lastTickNs;
      uncommitted = Math.floor(Math.max(0, Math.min(Number(ns) / 1e9, this.prefs.heartbeatSeconds * 2)));
    }
    const day = this.timer?.getDay();
    const secondsToday = (this.timer?.getTodaySeconds() || 0) + uncommitted;
    const unsynced = this.state ? Object.values(this.state.data.days)
      .reduce((sum, item) => sum + Math.max(0, item.sourceSeconds - (item.acknowledgedSeconds || 0)), 0) : 0;
    return {
      users: this.users, selectedUserId: this.user?._id || null,
      selectedUserName: this.user?.name || null,
      state: this.tracker?.status || 'stopped',
      secondsToday, currentDate: localDateKey(),
      dbConnected: isConnected(), hasMongoUri: Boolean(process.env.MONGODB_URI),
      screenshotCount: this.screenshotCount,
      lastCaptureAt: this.lastCaptureAt,
      pendingRecords: this.queue?.items.length || 0,
      unsyncedSeconds: unsynced,
      lastWindowTitle: this.screenshots?.lastCapture?.activeWindow?.title || '',
      lastAppName: this.screenshots?.lastCapture?.activeWindow?.appName || '',
      lastScreen: this.screenshots?.lastCapture?.screen || null,
      lastUnchanged: this.screenshots?.lastCapture?.unchanged || false,
      lastTick: this.lastTick,
      lastError: this.lastError,
      settings: { ...this.prefs },
      dataDir: this.dataDir,
      sessionCount: day?.sessions.length || 0,
      previewAvailable: Boolean(this.screenshots?.lastScreenshotPath)
    };
  }

  async getPreview() {
    const file = this.screenshots?.lastScreenshotPath;
    if (!file) return null;
    // Never read a path provided by renderer. Avoid loading arbitrarily large files.
    try {
      const stat = await fs.promises.stat(file);
      if (stat.size > 5 * 1024 * 1024) return null;
      const bytes = await fs.promises.readFile(file);
      return `data:image/jpeg;base64,${bytes.toString('base64')}`;
    } catch (_) { return null; }
  }

  checkpointForShutdown() {
    // Windows shutdown may not wait for promises. Persist immediately to disk.
    if (this.timer?.running) {
      try { this.timer.recordHeartbeat(); }
      catch (err) { console.warn(`[checkpoint] ${errorMessage(err)}`); }
    }
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    mongoose.connection.removeListener('disconnected', this.onDisconnect);
    await this.commandChain;
    if (this.tracker) await this.tracker.shutdown();
    await this.queue?.flush();
    await disconnect();
    this.tracker = null;
  }
}

module.exports = { DesktopController, safePrefs, DEFAULT_PREFS };
