'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const DailySummary = require('../models/DailySummary');
const db = require('../config/db');
const { localDateKey, midnight, errorMessage } = require('../utils/format');

function atomicJsonWrite(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
    fs.fsyncSync(fd); // best-effort durable local checkpoint before any DB I/O
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read ${file}; not overwriting potentially recoverable tracking data: ${errorMessage(error)}`); }
}

class LocalState {
  constructor(file) {
    this.file = file;
    this.data = readJson(file, { version: 1, installationId: randomUUID().replace(/-/g, ''), users: [], days: {} });
    if (this.data.version !== 1 || !this.data.installationId || !this.data.days) {
      throw new Error('Unsupported/corrupt state.json; keep it for recovery instead of deleting it.');
    }
    this.persist();
  }

  persist() { atomicJsonWrite(this.file, this.data); }
  key(userId, date) { return `${userId}|${date}`; }

  getDay(userId, date, userName, create = true) {
    const key = this.key(userId, date);
    if (!this.data.days[key] && create) {
      this.data.days[key] = {
        userId: String(userId), userName, date, sourceSeconds: 0, fractionalSeconds: 0,
        lastActiveAt: null, sessions: [], serverTotal: 0, acknowledgedSeconds: 0,
        revision: 0, dirty: true
      };
      this.persist();
    }
    return this.data.days[key];
  }

  cacheUsers(users) {
    this.data.users = users.map(u => ({ _id: String(u._id), name: u.name }));
    this.persist();
  }

  // A power loss leaves endedAt=null. Close at last *credited* heartbeat,
  // not process restart time: avoids silently counting the machine's off time.
  closeAbandonedSessions() {
    let changed = false;
    for (const day of Object.values(this.data.days)) {
      for (const session of day.sessions) {
        if (session.endedAt === null) {
          session.endedAt = (day.lastActiveAt && day.lastActiveAt >= session.startedAt)
            ? day.lastActiveAt : session.startedAt;
          day.dirty = true;
          day.revision = (day.revision || 0) + 1;
          changed = true;
        }
      }
    }
    if (changed) this.persist();
  }
}

// Atomic MongoDB aggregation-pipeline update: totalSeconds += MAX(0, local
// cumulative seconds - previously applied cumulative seconds for this PC).
// Retried requests can never double-count already-applied seconds, even if
// the database committed before the CLI received an acknowledgement.
function dailyUpsertPipeline(snapshot, installationId) {
  const sourcePath = `$syncSources.${installationId}.seconds`;
  const previous = { $ifNull: [sourcePath, 0] };
  const delta = { $max: [0, { $subtract: [snapshot.sourceSeconds, previous] }] };
  const incoming = snapshot.sessions.map(s => ({
    sessionId: s.sessionId,
    startedAt: new Date(s.startedAt),
    endedAt: s.endedAt ? new Date(s.endedAt) : null,
    activeSeconds: s.activeSeconds
  }));
  const incomingIds = incoming.map(s => s.sessionId);
  const first = incoming.length ? new Date(incoming[0].startedAt) : null;
  const stage = {
    // Pipeline updates are *not* schema-cast by Mongoose: use an ObjectId.
    user: { $literal: new mongoose.Types.ObjectId(snapshot.userId) },
    userName: { $literal: snapshot.userName },
    date: { $literal: snapshot.date },
    totalSeconds: { $add: [{ $ifNull: ['$totalSeconds', 0] }, delta] },
    [`syncSources.${installationId}.seconds`]: { $max: [previous, snapshot.sourceSeconds] },
    sessions: {
      $concatArrays: [
        { $filter: {
          input: { $ifNull: ['$sessions', []] }, as: 's',
          cond: { $not: [{ $in: ['$$s.sessionId', { $literal: incomingIds }] }] }
        } },
        { $literal: incoming }
      ]
    },
    updatedAt: { $literal: new Date() }
  };
  if (first) {
    stage.firstStartAt = { $min: [{ $ifNull: ['$firstStartAt', first] }, first] };
  }
  if (snapshot.lastActiveAt) {
    const last = new Date(snapshot.lastActiveAt);
    stage.lastActiveAt = { $max: [{ $ifNull: ['$lastActiveAt', last] }, last] };
  }
  return [{ $set: stage }];
}

class TimerService {
  constructor({ state, user, heartbeatSeconds }) {
    this.state = state;
    this.userId = String(user._id);
    this.userName = user.name;
    this.heartbeatSeconds = heartbeatSeconds;
    this.running = false;
    this.currentDay = null;
    this.sessionId = null;
    this.lastTickNs = null;
    this.heartbeatTimeout = null;
    this.syncPromise = null;
    this.lastSyncError = false;
  }

  getDay(date = localDateKey(), create = false) {
    return this.state.getDay(this.userId, date, this.userName, create);
  }

  setServerSummary(date, totalSeconds, sourceSeconds) {
    const day = this.getDay(date, true);
    day.serverTotal = totalSeconds || 0;
    day.acknowledgedSeconds = sourceSeconds || 0;
    this.state.persist();
  }

  getTodaySeconds() {
    const day = this.getDay();
    if (!day) return 0;
    return Math.max(0, (day.serverTotal || 0) + Math.max(0, day.sourceSeconds - (day.acknowledgedSeconds || 0)));
  }

  openSession(at) {
    const date = localDateKey(at);
    const day = this.getDay(date, true);
    const sessionId = randomUUID();
    day.sessions.push({ sessionId, startedAt: at.toISOString(), endedAt: null, activeSeconds: 0 });
    day.revision++;
    day.dirty = true;
    this.currentDay = date;
    this.sessionId = sessionId;
    this.state.persist();
  }

  closeSession(at) {
    if (!this.sessionId) return;
    const day = this.getDay(this.currentDay);
    const session = day?.sessions.find(s => s.sessionId === this.sessionId);
    if (session && session.endedAt === null) {
      session.endedAt = at.toISOString();
      day.revision++;
      day.dirty = true;
      this.state.persist();
    }
    this.sessionId = null;
    this.currentDay = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTickNs = process.hrtime.bigint();
    this.openSession(new Date());
    this.scheduleHeartbeat();
    void this.syncAll();
  }

  scheduleHeartbeat() {
    clearTimeout(this.heartbeatTimeout);
    if (!this.running) return;
    this.heartbeatTimeout = setTimeout(() => {
      this.recordHeartbeat(); // synchronous durable checkpoint before async work
      void this.syncAll();
      this.scheduleHeartbeat();
    }, this.heartbeatSeconds * 1000);
  }

  recordHeartbeat(now = new Date(), currentNs = process.hrtime.bigint()) {
    if (!this.running || this.lastTickNs === null) return 0;
    const elapsed = Math.max(0, Number(currentNs - this.lastTickNs) / 1e9);
    this.lastTickNs = currentNs;

    const date = localDateKey(now);
    if (date !== this.currentDay) {
      const startOfDay = midnight(now);
      this.closeSession(startOfDay);
      this.openSession(startOfDay);
    }

    const day = this.getDay(date, true);
    // Preserve subsecond carry. Long sleeps/hangs cannot be charged in full.
    const credited = Math.min(elapsed, this.heartbeatSeconds * 2) + (day.fractionalSeconds || 0);
    const increment = Math.floor(credited);
    day.fractionalSeconds = credited - increment;
    if (increment > 0) {
      day.sourceSeconds += increment;
      day.lastActiveAt = now.toISOString();
      const session = day.sessions.find(s => s.sessionId === this.sessionId);
      if (session) session.activeSeconds += increment;
      day.revision++;
      day.dirty = true;
    }
    this.state.persist();
    return increment;
  }

  async pause() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.heartbeatTimeout);
    this.recordFinalAndClose();
    await this.syncAll();
  }

  recordFinalAndClose() {
    // Temporarily allow the normal accounting path to credit the last period.
    this.running = true;
    const endedAt = new Date();
    this.recordHeartbeat(endedAt);
    this.running = false;
    this.closeSession(endedAt);
  }

  async resume() {
    if (this.running) return;
    this.start();
  }

  async stop() {
    clearTimeout(this.heartbeatTimeout);
    if (this.running) {
      this.running = false;
      this.recordFinalAndClose();
    }
    await this.syncAll();
  }

  async syncAll() {
    // A heartbeat may update state while an old checkpoint is syncing.
    // Set a resync flag so the in-flight call processes the latest revision.
    if (this.syncPromise) {
      this.resyncRequested = true;
      return this.syncPromise;
    }
    this.syncPromise = (async () => {
      do {
        this.resyncRequested = false;
        const completed = await this._syncAll();
        if (!completed) break; // avoid busy retry when DB is unavailable
      } while (this.resyncRequested);
    })().finally(() => { this.syncPromise = null; });
    return this.syncPromise;
  }

  async _syncAll() {
    if (!await db.ensureConnected()) return false;
    // Only dirty days: O(1) heartbeat work, independent of tracker age.
    for (const day of Object.values(this.state.data.days)) {
      if (!day.dirty) continue;
      const snapshot = {
        userId: day.userId, userName: day.userName, date: day.date,
        sourceSeconds: day.sourceSeconds, lastActiveAt: day.lastActiveAt,
        sessions: day.sessions.map(s => ({ ...s }))
      };
      const revision = day.revision;
      try {
        const summary = await DailySummary.findOneAndUpdate(
          { user: day.userId, date: day.date },
          dailyUpsertPipeline(snapshot, this.state.data.installationId),
          { upsert: true, new: true, setDefaultsOnInsert: false }
        ).lean();
        day.serverTotal = summary.totalSeconds;
        day.acknowledgedSeconds = snapshot.sourceSeconds;
        if (day.revision === revision) day.dirty = false;
        this.state.persist();
        this.lastSyncError = false;
      } catch (error) {
        if (!this.lastSyncError) console.warn(`[time] Sync delayed; safely saved to state.json: ${errorMessage(error)}`);
        this.lastSyncError = true;
        return false;
      }
    }
    return true;
  }
}

module.exports = { LocalState, TimerService, atomicJsonWrite, dailyUpsertPipeline };
