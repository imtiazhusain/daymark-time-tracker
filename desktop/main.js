'use strict';
const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  powerMonitor,
  Notification
} = require('electron');
const { DesktopController } = require('../src/services/desktop.controller');

// Packaged apps are Windows-only. Use ALLOW_NON_WINDOWS_UI=1 for Linux CI smoke tests.
if (process.platform !== 'win32' && process.env.ALLOW_NON_WINDOWS_UI !== '1') {
  console.error('Windows Time Tracker runs only on Windows.');
  app.exit(1);
}

// Stable data directory for both development and packaged builds.
const persistentData = path.join(app.getPath('appData'), 'DaymarkTimeTracker');
fs.mkdirSync(persistentData, { recursive: true });
app.setPath('userData', persistentData);
// Load notification settings from .env
require('dotenv').config({
  path: path.join(__dirname, '..', '.env')
});

// For installed EXE versions, load external settings.
require('dotenv').config({
  path: path.join(persistentData, 'notifications.env'),
  override: true
});

function settingEnabled(name) {
  return !['false', '0', 'off', 'no'].includes(
    String(process.env[name] ?? 'true').trim().toLowerCase()
  );
}

const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window = null;
let controller = null;
let closePromise = null;
let allowClose = false;

app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

function requestShutdown() {
  if (closePromise) return closePromise;
  if (controller) controller.checkpointForShutdown();
  closePromise = Promise.resolve(controller?.shutdown()).catch(error => {
    console.error('[shutdown]', error);
  }).finally(() => {
    allowClose = true;
    if (window && !window.isDestroyed()) window.close();
    app.quit();
  });
  return closePromise;
}

function createWindow() {
  window = new BrowserWindow({
    title: 'Daymark • Time Tracker',
    width: 1120, height: 780, minWidth: 850, minHeight: 630,
    backgroundColor: '#0d111b',
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'resources', 'tracker.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.once('ready-to-show', () => window?.show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!allowClose) {
      event.preventDefault();
      void requestShutdown();
    }
  });
  // This event can be triggered by Windows logout / restart. A synchronous
  // local checkpoint is written even if Windows does not await our async flush.
  window.on('query-session-end', () => controller?.checkpointForShutdown());
  window.on('session-end', () => controller?.checkpointForShutdown());
}

function registerIpc() {
  ipcMain.handle('tracker:status', () => controller.getStatus());
  ipcMain.handle('tracker:month-history', (_event, month) => {
  return controller.getMonthHistory(month);
});
  ipcMain.handle('tracker:select', (_event, id) => controller.selectUser(id));
  ipcMain.handle('tracker:seed', () => controller.seedUsers());
  ipcMain.handle('tracker:start', () => controller.start());
  ipcMain.handle('tracker:pause', () => controller.pause());
  ipcMain.handle('tracker:stop', () => controller.stop());
  ipcMain.handle('tracker:connect', (_event, uri) => controller.saveConnection(uri));
  ipcMain.handle('tracker:preferences', (_event, prefs) => controller.savePreferences(prefs));
  ipcMain.handle('tracker:preview', () => controller.getPreview());
  ipcMain.handle('tracker:open-data', () => shell.openPath(controller.dataDir));
  ipcMain.handle('tracker:open-shots', () => shell.openPath(controller.screenshotDir));
}

if (locked) {
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.daymark.timetracker');
    controller = new DesktopController({ dataDir: app.getPath('userData'),
      getIdleSeconds: () => powerMonitor.getSystemIdleTime() });
    try { await controller.initialize(); }
    catch (error) { console.error('[startup]', error); controller.logError(error); }
    registerIpc();
    createWindow();
    controller.on('update', state => {
      if (window && !window.isDestroyed()) window.webContents.send('tracker:update', state);

    });
   controller.on('screenshot-captured', ({ count }) => {

  // Show Windows notification
  if (
    settingEnabled('SCREENSHOT_NOTIFICATION') &&
    Notification.isSupported()
  ) {
    const notification = new Notification({
      title: 'Daymark — Screenshot Captured',
      body: `${count} screen${count === 1 ? '' : 's'} saved successfully.`,
      silent: true
    });

    notification.show();

    // Automatically dismiss after 5 seconds
    setTimeout(() => {
      notification.close();
    }, 5000);
  }

  // Play screenshot sound
  // Play gentle screenshot sound
if (
  settingEnabled('SCREENSHOT_SOUND') &&
  window &&
  !window.isDestroyed() &&
  !window.webContents.isDestroyed()
) {
  window.webContents.send('tracker:soft-sound');
}

});
    powerMonitor.on('suspend', () => controller?.checkpointForShutdown());
  }).catch(error => {
    console.error('[fatal startup]', error);
    app.exit(1);
  });
  app.on('window-all-closed', () => { void requestShutdown(); });
}
