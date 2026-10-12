'use strict';
// No remote resources, no Node APIs, and no HTML injection. All privileged
// operations go through the narrow, validated preload API.
const api = window.trackerAPI;
const $ = id => document.getElementById(id);
let status = null;
let fetching = false;
let actionInProgress = false;
let previewKey = null;
let lastUsersKey = null;
let toastTimer = null;
let editingConnection = false;
let historyRequest = 0;

function humanTime(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60]
    .map(num => String(num).padStart(2, '0')).join(':');
}

function notice(message, bad = false) {
  clearTimeout(toastTimer);
  const toast = $('toast');
  toast.textContent = String(message);
  toast.classList.toggle('error', bad);
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4800);
}

function prettyError(err) {
  const raw = String(err?.message || err || 'Something went wrong.');
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function perform(fn, successMessage) {
  if (actionInProgress) return;
  actionInProgress = true;
  renderControls();
  try {
    const result = await fn();
    if (result?.state) status = result;
    if (successMessage) notice(successMessage);
    await refresh();
  } catch (err) { notice(prettyError(err), true); }
  finally { actionInProgress = false; renderControls(); }
}

function showPage(which) {
  $('overviewView').hidden = which !== 'overview';
  $('historyView').hidden = which !== 'history';
  $('settingsView').hidden = which !== 'settings';

  const pages = [
    ['navOverview', 'overview'],
    ['navHistory', 'history'],
    ['navSettings', 'settings']
  ];

  for (const [id, page] of pages) {
    $(id).classList.toggle('active', which === page);
  }

  $('breadcrumb').textContent = {
    overview: 'Overview',
    history: 'History',
    settings: 'Settings'
  }[which];
}

function updateUsers(s) {
  const key = JSON.stringify(s.users);
  if (lastUsersKey !== key) {
    lastUsersKey = key;
    const selector = $('userSelect');
    selector.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = s.users.length ? 'Choose a user...' : 'No users available';
    selector.append(placeholder);
    for (const user of s.users) {
      const opt = document.createElement('option');
      opt.value = user._id;
      opt.textContent = user.name;
      selector.append(opt);
    }
  }
  $('userSelect').value = s.selectedUserId || '';
}

function renderControls() {
  if (!status) return;
  const state = status.state;
  const running = state === 'running';
  const paused = state === 'paused';
  const hasUser = Boolean(status.selectedUserId);
  $('mainButton').disabled = actionInProgress || !hasUser;
  $('stopButton').disabled = actionInProgress || !['running', 'paused'].includes(state);
  $('userSelect').disabled = actionInProgress || running || paused;
  $('mainButtonText').textContent = running ? 'Pause tracking' : paused ? 'Resume tracking' : 'Start tracking';
  $('mainButton').firstChild.textContent = running ? 'Ⅱ ' : '▶ ';
  $('trackingLabel').textContent = running ? 'TRACKING IN PROGRESS' : paused ? 'TRACKING PAUSED' : 'NOT TRACKING';
  $('pulseDot').className = `pulse-dot ${running ? 'running' : paused ? 'paused' : ''}`;
  $('heroTag').textContent = running ? 'ON THE CLOCK' : paused ? 'ON A BREAK' : 'READY WHEN YOU ARE';
  $('connectButton').disabled = actionInProgress || running || paused;
  $('changeConnection').disabled = actionInProgress || running || paused;
  $('cancelConnection').disabled = actionInProgress || running || paused;
  $('seedButton').disabled = actionInProgress || running || paused;
}

function renderConnectionSettings(s) {
  const saved = Boolean(s.hasMongoUri);
  $('connectionSaved').hidden = !saved || editingConnection;
  $('connectionEditor').hidden = saved && !editingConnection;
  $('cancelConnection').hidden = !saved;
  $('connectionEditorHint').textContent = saved ? '(replace saved connection)' : '(first-time setup)';
  $('savedConnectionMessage').textContent = s.dbConnected
    ? 'Connected automatically. No need to enter your Atlas URI again.'
    : 'Your Atlas URI is saved. Daymark retries automatically; tracking works offline.';
}

function draw(s) {
  status = s;
  renderConnectionSettings(s);
  updateUsers(s);
  $('timeValue').textContent = humanTime(s.secondsToday);
  $('screenshotCount').textContent = Number(s.screenshotCount).toLocaleString();
  $('sessionCount').textContent = Number(s.sessionCount).toLocaleString();
  $('pendingCount').textContent = Number(s.pendingRecords).toLocaleString();
  $('unsyncedTime').textContent = `${Number(s.unsyncedSeconds).toLocaleString()} sec`;
  $('greeting').textContent = s.selectedUserName
    ? `Welcome back, ${s.selectedUserName}. Here's how your day is going.`
    : s.users.length ? 'Choose a profile to begin your session.'
    : s.hasMongoUri
      ? 'Your Atlas connection is saved. Waiting to reconnect and load profiles.'
      : 'Set up your MongoDB connection once in Settings to begin.';
  $('avatar').textContent = s.selectedUserName?.slice(0, 1).toUpperCase() || 'D';
  const d = new Date();
  $('todayDate').textContent = d.toLocaleDateString(undefined, { weekday:'short', month:'short', day:'numeric', year:'numeric' });
  const db = $('dbIndicator');
  db.classList.toggle('online', s.dbConnected);
  db.classList.toggle('offline', !s.dbConnected);
  db.lastChild.textContent = s.dbConnected ? ' Database connected' : ' Database offline';
  $('connectionChip').textContent = s.dbConnected ? 'Connected' : s.hasMongoUri ? 'Offline / reconnecting' : 'Not configured';
  $('captureInterval').textContent = `Every ${s.settings.screenshotIntervalSeconds}s`;
  $('ocrState').textContent = s.settings.ocrEnabled ? 'Enabled' : 'Disabled';
  $('dataFolder').textContent = s.dataDir;
  if (s.lastCaptureAt) {
    const time = new Date(s.lastCaptureAt).toLocaleTimeString();
    $('lastCapture').textContent = s.lastWindowTitle || 'Screen captured';
    $('lastApp').textContent = [s.lastAppName || 'Unknown application', `Screen ${s.lastScreen || 1}`, time, s.lastUnchanged ? 'Unchanged' : 'Processed'].join(' · ');
  } else {
    $('lastCapture').textContent = 'Nothing captured yet';
    $('lastApp').textContent = 'Start tracking to record window activity.';
  }
  if (s.previewAvailable && s.lastCaptureAt && s.lastCaptureAt !== previewKey) {
    previewKey = s.lastCaptureAt;
    void api.preview().then(data => {
      if (!data) return;
      const img = $('previewImage');
      img.src = data;
      img.hidden = false;
      $('previewEmpty').hidden = true;
    }).catch(() => {});
  }
  renderControls();
}

async function refresh() {
  if (fetching || actionInProgress && status?.state === 'closing') return;
  fetching = true;
  try { draw(await api.status()); }
  catch (err) { console.warn('Status request failed:', err); }
  finally { fetching = false; }
}

function localMonth() {
  const now = new Date();

  return `${now.getFullYear()}-${String(
    now.getMonth() + 1
  ).padStart(2, '0')}`;
}


function monthTime(seconds) {
  const n = Math.max(
    0,
    Math.floor(Number(seconds) || 0)
  );

  if (n === 0) return '0 hours';

  const hours = Math.floor(n / 3600);
  const minutes = Math.floor(n / 60) % 60;
  const secs = n % 60;

  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}


async function loadMonthHistory() {
  const request = ++historyRequest;
  const userId = status?.selectedUserId;
  const month = $('historyMonth').value;
  const tableBody = $('historyDays');

  tableBody.replaceChildren();

  $('historyTotal').textContent = '0 hours';
  $('historyWorkDays').textContent = '0';

  if (!userId) {
    $('historyUser').textContent =
      'Select a user on Overview to view their history.';

    $('historySource').textContent =
      'No user selected.';

    return;
  }

  if (!month) {
    $('historySource').textContent =
      'Choose a month.';

    return;
  }

  $('historyUser').textContent =
    `Time report for ${status.selectedUserName}`;

  $('historySource').textContent =
    'Loading saved time...';

  $('refreshHistory').disabled = true;

  try {
    const result = await api.monthHistory(month);

    // Ignore outdated requests if the user/month changed.
    if (
      request !== historyRequest ||
      status?.selectedUserId !== userId
    ) {
      return;
    }

    $('historyTotal').textContent =
      monthTime(result.totalSeconds);

    $('historyWorkDays').textContent =
      String(result.days.filter(d => d.seconds > 0).length);

    $('historySource').textContent = result.connected
      ? 'MongoDB Atlas + pending local time'
      : 'Offline — showing saved local data only';

    for (const day of result.days) {
      const tr = document.createElement('tr');
      const dateTd = document.createElement('td');
      const durationTd = document.createElement('td');

      const [y, m, d] = day.date.split('-').map(Number);

      dateTd.textContent = new Date(
        y, m - 1, d
      ).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });

      durationTd.textContent =
        monthTime(day.seconds);

      if (day.seconds === 0) {
        tr.className = 'history-zero';
      }

      tr.append(dateTd, durationTd);
      tableBody.append(tr);
    }

  } catch (error) {
    if (request === historyRequest) {
      $('historySource').textContent =
        'Could not load history.';

      notice(prettyError(error), true);
    }

  } finally {
    if (request === historyRequest) {
      $('refreshHistory').disabled = false;
    }
  }
}
$('navOverview').addEventListener('click', () => showPage('overview'));
$('navHistory').addEventListener('click', () => {
  showPage('history');
  void loadMonthHistory();
});

$('historyMonth').addEventListener('change', () => {
  void loadMonthHistory();
});

$('refreshHistory').addEventListener('click', () => {
  void loadMonthHistory();
});
$('navSettings').addEventListener('click', () => {
  showPage('settings');
});
$('userSelect').addEventListener('change', e => {
  const id = e.target.value;
  if (id) void perform(() => api.selectUser(id));
});
$('mainButton').addEventListener('click', () => {
  if (!status) return;
  const isRunning = status.state === 'running';
  void perform(() => isRunning ? api.pause() : api.start(), isRunning ? 'Tracking paused. Time saved.' : 'Time tracking started.');
});
$('stopButton').addEventListener('click', () => void perform(() => api.stop(), 'Tracking stopped. Your time has been saved.'));
$('connectButton').addEventListener('click', () => {
  const uri = $('mongoUri').value.trim();
  if (!uri) { notice('Enter your MongoDB Atlas connection URI.', true); return; }
  void perform(async () => {
    const connected = await api.connect(uri);
    $('mongoUri').value = '';
    editingConnection = false;
    if (connected.connected) notice('Connection saved. Future launches will reconnect automatically.');
    else notice('Connection saved. Atlas is offline; Daymark will retry automatically.');
  });
});
$('changeConnection').addEventListener('click', () => {
  editingConnection = true;
  if (status) renderConnectionSettings(status);
  $('mongoUri').focus();
});
$('cancelConnection').addEventListener('click', () => {
  editingConnection = false;
  $('mongoUri').value = '';
  if (status) renderConnectionSettings(status);
});
$('seedButton').addEventListener('click', () => void perform(() => api.seedUsers(), 'Default users are ready.'));

$('openShots').addEventListener('click', () => void api.openScreenshotFolder());
$('openData').addEventListener('click', () => void api.openDataFolder());
api.onUpdate(s => { if (!actionInProgress) draw(s); });
$('historyMonth').value = localMonth();
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 1000);


// Gentle screenshot notification sound
let screenshotAudioContext = null;

async function playSoftScreenshotSound() {
  try {
    const AudioContextClass =
      window.AudioContext || window.webkitAudioContext;

    if (!AudioContextClass) return;

    if (!screenshotAudioContext) {
      screenshotAudioContext = new AudioContextClass();
    }

    if (screenshotAudioContext.state === 'suspended') {
      await screenshotAudioContext.resume();
    }

    const ctx = screenshotAudioContext;
    const now = ctx.currentTime;

    // Create gentle tone
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(520, now);

    // Very low volume with smooth fade
    gainNode.gain.setValueAtTime(0.0001, now);

    gainNode.gain.linearRampToValueAtTime(
      0.040,
      now + 0.015
    );

    gainNode.gain.exponentialRampToValueAtTime(
      0.0001,
      now + 0.14
    );

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.15);

    oscillator.onended = () => {
      oscillator.disconnect();
      gainNode.disconnect();
    };

  } catch (error) {
    console.warn('Screenshot sound unavailable:', error);
  }
}

api.onScreenshotSound(() => {
  void playSoftScreenshotSound();
});