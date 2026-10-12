'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
// Stub only external DB modules: the heartbeat/local-state code runs as-is,
// even before npm dependencies have been installed on this test machine.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename?.endsWith('/src/services/timer.service.js')) {
    if (request === 'mongoose') return { Types: { ObjectId: class ObjectId { constructor(id) { this.id = id; } } } };
    if (request === '../models/DailySummary') return {};
    if (request === '../config/db') return { ensureConnected: async () => false };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { LocalState, TimerService, dailyUpsertPipeline } = require('../src/services/timer.service');
Module._load = originalLoad;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'time-tracker-'));
  const state = new LocalState(path.join(dir, 'state.json'));
  const user = { _id: '507f1f77bcf86cd799439011', name: 'Test User' };
  const timer = new TimerService({ state, user, heartbeatSeconds: 30 });
  timer.syncAll = async () => {}; // deterministic unit test without DB
  return { dir, state, user, timer };
}

test('heartbeat increments only while running and caps at 2x interval', async () => {
  const { dir, timer } = fixture();
  try {
    timer.start();
    const startNs = timer.lastTickNs;
    const credited = timer.recordHeartbeat(new Date(), startNs + 120000000000n);
    assert.equal(credited, 60);
    assert.equal(timer.getTodaySeconds(), 60);
    await timer.pause();
    assert.equal(timer.getTodaySeconds(), 60);
    assert.equal(timer.recordHeartbeat(), 0);
    assert.ok(timer.getDay().sessions[0].endedAt);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('same-day resume creates a new session and preserves time', async () => {
  const { dir, timer } = fixture();
  try {
    timer.start();
    const now = timer.lastTickNs;
    timer.recordHeartbeat(new Date(), now + 10000000000n);
    await timer.pause();
    await timer.resume();
    assert.equal(timer.getDay().sessions.length, 2);
    assert.ok(timer.getTodaySeconds() >= 10);
    await timer.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('crash recovery closes an unfinished session at last credited timestamp', () => {
  const { dir, state, timer } = fixture();
  try {
    timer.start();
    const at = new Date();
    timer.recordHeartbeat(at, timer.lastTickNs + 12000000000n);
    state.closeAbandonedSessions();
    const session = timer.getDay().sessions[0];
    assert.equal(session.endedAt, at.toISOString());
  } finally {
    clearTimeout(timer.heartbeatTimeout);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('upsert delta is conditional on previous per-PC cumulative seconds', () => {
  const snapshot = {
    userId: '507f1f77bcf86cd799439011', userName: 'Test', date: '2026-10-10',
    sourceSeconds: 60, lastActiveAt: '2026-10-10T10:00:00Z', sessions: [{
      sessionId: 'stable', startedAt: '2026-10-10T09:00:00Z', endedAt: null, activeSeconds: 60
    }]
  };
  const pipeline = dailyUpsertPipeline(snapshot, 'machineone');
  const update = pipeline[0].$set;
  assert.equal(update.totalSeconds.$add[1].$max[0], 0);
  assert.equal(update.totalSeconds.$add[1].$max[1].$subtract[0], 60);
  assert.equal(update.totalSeconds.$add[1].$max[1].$subtract[1].$ifNull[0], '$syncSources.machineone.seconds');
});


test('a heartbeat crossing midnight credits the new local day only', async () => {
  const { dir, timer } = fixture();
  try {
    timer.start();
    const original = timer.currentDay;
    const previousStarted = timer.getDay(original).sessions[0].startedAt;
    const nextDay = new Date();
    nextDay.setDate(nextDay.getDate() + 1);
    nextDay.setHours(0, 0, 10, 0);
    const newNs = timer.lastTickNs + 10000000000n;
    const credited = timer.recordHeartbeat(nextDay, newNs);
    assert.equal(credited, 10);
    assert.equal(timer.getDay(original).sourceSeconds, 0);
    assert.equal(timer.getDay(timer.currentDay).sourceSeconds, 10);
    assert.equal(timer.getDay(original).sessions[0].endedAt,
      new Date(nextDay.getFullYear(), nextDay.getMonth(), nextDay.getDate()).toISOString());
    assert.ok(previousStarted);
    await timer.stop();
  } finally {
    clearTimeout(timer.heartbeatTimeout);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
