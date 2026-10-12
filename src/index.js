'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const inquirer = require('inquirer');
const { ensureConnected, disconnect } = require('./config/db');
const User = require('./models/User');
const DailySummary = require('./models/DailySummary');
const { LocalState, TimerService } = require('./services/timer.service');
const { ScreenshotService, PendingRecords } = require('./services/screenshot.service');
const OCRService = require('./services/ocr.service');
const TrackerService = require('./services/tracker.service');
const { positiveInt, localDateKey, formatDuration, errorMessage } = require('./utils/format');

const ROOT = path.resolve(__dirname, '..');
let tracker;
let closing = null;
let readlineReady = false;
let keypressHandler;
let exitCode = 0;

async function shutdown(reason = 'quit', code = 0) {
  exitCode = Math.max(exitCode, code);
  if (closing) return closing;
  closing = (async () => {
    if (keypressHandler) process.stdin.removeListener('keypress', keypressHandler);
    if (readlineReady && process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    console.log(`\nStopping (${reason})...`);
    try { if (tracker) await tracker.shutdown(); }
    catch (error) { exitCode = 1; console.error(`[exit] ${errorMessage(error)}`); }
    await disconnect();
    console.log('Tracking stopped. Local unsynced data, if any, remains safe on disk.');
    process.exitCode = exitCode;
  })();
  return closing;
}

function installProcessHandlers() {
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('uncaughtException', error => {
    console.error(`[fatal] ${error.stack || errorMessage(error)}`);
    void shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', error => {
    console.error(`[error] Unhandled rejection: ${errorMessage(error)}`);
    // Keep accounting alive. The affected operation is retried at next tick.
  });
}

function installKeyboard() {
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    readlineReady = true;
  }
  let busy = false;
  keypressHandler = async (character, key) => {
    if (closing) return;
    if (key?.ctrl && key.name === 'c') { void shutdown('Ctrl+C'); return; }
    const input = String(character || '').toLowerCase();
    if (input === 'q') { void shutdown('quit'); return; }
    if (!['p', 'r', 's'].includes(input) || busy) return;
    busy = true;
    try {
      if (input === 'p') await tracker.pause();
      if (input === 'r') await tracker.resume();
      if (input === 's') await tracker.printStatus();
    } catch (error) {
      console.error(`[keyboard] ${errorMessage(error)}`);
    } finally { busy = false; }
  };
  process.stdin.on('keypress', keypressHandler);
  process.stdin.resume();
}

async function main() {
  installProcessHandlers();
  if (process.platform !== 'win32') {
    console.error('This project only supports Windows (win32).');
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    throw new Error('Run npm start in an interactive Windows Terminal, PowerShell or cmd window.');
  }
  if (!process.env.MONGODB_URI) console.warn('[db] MONGODB_URI is unset; previously cached users can work offline.');

  const state = new LocalState(path.join(ROOT, 'state.json'));
  state.closeAbandonedSessions();
  const queue = new PendingRecords(path.join(ROOT, 'pending-records.json'));

  const connected = await ensureConnected(true);
  let users = [];
  if (connected) {
    try {
      users = await User.find().sort({ name: 1 }).lean();
      state.cacheUsers(users);
    } catch (error) {
      console.warn(`[users] Using cached users: ${errorMessage(error)}`);
    }
  }
  if (!users.length) users = state.data.users || [];
  if (!users.length) {
    throw new Error('No users available. Connect to MongoDB Atlas, run "npm run seed", then try again.');
  }
  const { selectedId } = await inquirer.prompt([{
    type: 'list', name: 'selectedId', message: 'Who is tracking time?',
    choices: users.map(user => ({ name: user.name, value: String(user._id) }))
  }]);
  const user = users.find(item => String(item._id) === selectedId);

  const dayKey = localDateKey();
  let remote = null;
  if (await ensureConnected()) {
    try { remote = await DailySummary.findOne({ user: user._id, date: dayKey }).lean(); }
    catch (error) { console.warn(`[time] Starting with offline total: ${errorMessage(error)}`); }
  }
  const heartbeatSeconds = positiveInt(process.env.HEARTBEAT_SECONDS, 30, 1, 3600);
  const timer = new TimerService({ state, user, heartbeatSeconds });
  if (remote) {
    const source = remote.syncSources?.[state.data.installationId];
    const previouslyApplied = source?.seconds || 0;
    timer.setServerSummary(dayKey, remote.totalSeconds, previouslyApplied);
  }
  // Bring old unsynced totals and orphan session closures up to date before
  // displaying welcome message. If offline, local checkpoint remains available.
  await timer.syncAll();
  const secondsToday = timer.getTodaySeconds();
  console.log(`\nWelcome back, ${user.name}. Time worked today: ${formatDuration(secondsToday)}`);

  const screenshotDir = process.env.SCREENSHOT_DIR || './screenshots';
  const resolvedDir = path.isAbsolute(screenshotDir) ? screenshotDir : path.join(ROOT, screenshotDir);
  fs.mkdirSync(resolvedDir, { recursive: true });
  const ocr = new OCRService({
    enabled: String(process.env.OCR_ENABLED || 'true').toLowerCase() !== 'false',
    language: process.env.OCR_LANGUAGE || 'eng',
    idleSeconds: positiveInt(process.env.OCR_IDLE_TERMINATE_SECONDS, 300, 1, 86400)
  });
  const screenshots = new ScreenshotService({
    user, screenshotDir: resolvedDir,
    imageMaxWidth: positiveInt(process.env.IMAGE_MAX_WIDTH, 1280, 256, 7680),
    imageQuality: positiveInt(process.env.IMAGE_QUALITY, 60, 1, 100),
    ocr, pendingRecords: queue
  });
  tracker = new TrackerService({
    timer, screenshots, ocr,
    screenshotIntervalSeconds: positiveInt(process.env.SCREENSHOT_INTERVAL_SECONDS, 120, 1, 86400)
  });

  console.log('[p] pause   [r] resume   [s] status   [q] quit');
  installKeyboard();
  await tracker.start();
  // Retry outstanding screenshot inserts even before the first screenshot.
  void queue.flush();
}

main().catch(async error => {
  console.error(`[startup] ${error.stack || errorMessage(error)}`);
  await shutdown('startup failure', 1);
});
