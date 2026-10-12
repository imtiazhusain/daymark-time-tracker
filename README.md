# Daymark — Windows Time Tracker (Desktop + CLI)

A Windows-only time tracker with a **desktop interface**, local screenshots, OCR, active-window metadata and MongoDB Atlas synchronization. Time is checkpointed to disk every heartbeat, including when Atlas is offline. The ZIP includes the **full application source** and a Windows `.exe` build configuration. A precompiled `.exe` is **not included**; build it on your Windows PC using the commands below.

## Quick start — desktop application

**Requirements:** Windows 10/11 (64-bit), Node.js 18.18+ (Node.js 20/22 LTS recommended), internet access for the first `npm install`, and a MongoDB Atlas connection string. On Windows, open PowerShell in the extracted `time-tracker` folder:

```powershell
npm install
npm start
```

**Even easier:** double-click `RUN-DESKTOP.bat` on Windows. It installs the required packages if they are missing and launches the desktop window.

`npm start` opens the **Daymark** desktop window. It is no longer the CLI command. The GUI stays open while tracking; closing the window stops tracking and checkpoints your time. Tracking is **never started automatically**.

### First-time configuration (no `.env` editing required)

1. On the **first launch only**, click **Settings** and enter your MongoDB Atlas URI in **MongoDB Atlas → Connection string**. Click **Save & connect**. This is remembered in `%APPDATA%\DaymarkTimeTracker/.env` and loaded automatically on subsequent launches (the actual location is shown inside the app). Use a database account with the intended read/write permissions. Atlas Network Access must allow your PC's outbound IP address.
2. Click **Add Saifullah & Hizbullah**. It is safe to click again; the upserts are idempotent.
3. Return to **Overview**, select a profile, and click **Start tracking**. Daymark also remembers your last selected profile for the next launch, but never starts tracking without your approval.
4. Click **Pause tracking** to pause both accounting and screenshots, **Resume tracking** to start another session, and **Stop** to end. Switching profiles is allowed after Stop.
5. The dashboard shows the current active time, captured screens, session count, pending records, last active window, a screenshot preview and Atlas connection status.

Offline use: once the user list has been cached successfully from Atlas, the same profiles are selectable while offline. If no list has ever been cached, connect Atlas to add/select users for the first time.

### MongoDB connection is one-time only

The first saved MongoDB URI is persisted in `%APPDATA%\DaymarkTimeTracker\.env`, outside the ZIP extraction directory and outside the installed executable. Reopening the app reads it automatically, reconnects to Atlas, and restores your last selected user from `selection.json`. In Settings, the URI field is hidden once configured: **Connection saved on this computer** is shown instead. Use **Change connection** only if you need a different MongoDB cluster or password. If offline, your connection is **still saved**; Daymark attempts a background reconnect approximately every 30 seconds while offline, and continues local time tracking. Never paste the connection string again merely because the server is temporarily unreachable.

If the app unexpectedly shows first-time configuration again, check whether `%APPDATA%\DaymarkTimeTracker\.env` exists **without sharing its contents**, and whether you are running under the same Windows account. Switching Windows accounts, removing this folder, or changing its roaming profile resets local configuration. Existing `state.json` and `pending-records.json` must not be deleted when updating the app.

### Build a Windows `.exe` (installer and portable app)

After installing dependencies **on a Windows 10/11 x64 machine**, run:

```powershell
npm run dist:win
```

Alternatively, double-click **`BUILD-EXE.bat`** after installing Node.js LTS. It installs dependencies and creates the executables automatically.

Outputs are placed in `dist/`. Electron Builder creates a Windows NSIS setup executable and a portable executable. Alternatively, for only the portable executable:

```powershell
npm run dist:portable
```

**You do not need Node.js installed to run the resulting built `.exe`** on another Windows PC. The `.exe` bundles the Electron runtime and application dependencies. An unsigned application can trigger a Windows SmartScreen warning; signing the installer requires a trusted code-signing certificate. Build on Windows to ensure native dependencies (`sharp`, `active-win`) have appropriate Windows binaries. Internet access is required during install/build; the final application can track offline once at least one user profile has been cached.

The desktop app intentionally has a larger idle RAM footprint than the original CLI because Electron includes Chromium. The screenshot/OCR work remains serialized, and its original worker re-use, throttling, and local recovery behavior is preserved.

### Where your data lives

Packaged desktop app and the Electron development app store **mutable data outside the installation** (in Electron's `app.getPath('userData')`, typically `%APPDATA%\DaymarkTimeTracker`):

```text
<application data folder>/
├── .env                      # MongoDB connection URI; local plaintext, handle privately
├── preferences.json          # screenshot/OCR settings
├── selection.json            # remembered selected profile
├── ocr-cache/                # Tesseract language data cached for offline OCR
├── state.json                # durable offline time and local session checkpoints
├── pending-records.json      # queued MongoDB screenshot records
└── screenshots/
    └── YYYY-MM-DD/
        ├── HH-mm-ss-SSS-screen1.jpg
        └── HH-mm-ss-SSS-screen2.jpg
```

A MongoDB Atlas connection URI is sensitive: don't share your `%APPDATA%` folder publicly. Raw screenshot image files are stored **locally**, not uploaded to Atlas; Atlas records contain the path, text and metadata. If you switch to a different PC, its screenshot paths are not automatically transferable. Electron's renderer has context isolation and only limited predefined IPC actions; it cannot access arbitrary files or database credentials. Tracking requires deliberately clicking Start.

### Resource considerations

- Default capture interval: **120 seconds**; default heartbeat **30 seconds**.
- Each screen saves an optimized, downscaled JPEG at max **1280 px** wide and quality **60**. The app does not keep full-resolution images on disk.
- OCR runs on grayscale downscaled images; it initializes on first use, reuses a single worker and terminates after **300 seconds** without work. Turn OCR off in Settings to save RAM/CPU.
- Multiple displays are captured separately; only one screenshot job runs at a time.
- The GUI itself uses more RAM than CLI because of Electron. Use `npm run cli` for the lightest memory footprint (requires separate `.env` file in project directory).
- No old screenshot deletion is automatic. Check the screenshots folder periodically if disk space is limited. For longer battery life, increase the screenshot interval in Settings.

### Crash, shutdown and network outage behavior

- Every heartbeat writes a **synchronous, atomic local `state.json` checkpoint** before asynchronous Atlas synchronization. Its per-installation cumulative counters make retries idempotent and prevent double-crediting already applied time.
- A missing heartbeat due to laptop sleep/hang is capped at 2 × the heartbeat interval; the app does not credit all sleep/offline hours.
- A normal Stop, pause or window exit flushes the last partial heartbeat and ends the session. Before Windows logout/shutdown, Electron also asks for a synchronous local checkpoint, even if Windows cannot wait for Atlas.
- On restart, an unfinished session is closed using `lastActiveAt`, not restart time. A new Start opens a new session and continues the persisted daily total.
- During a MongoDB outage, active time continues accruing locally and screenshot documents are queued in `pending-records.json`. Synchronization resumes once Atlas is available.
- Crossing local midnight opens a new daily record on the next heartbeat; increments are attributed to the local heartbeat date.
- **Limitations:** A hard power loss can discard at most the time since the last saved heartbeat. No software can persist a checkpoint after instant power removal. Forced shutdown can interrupt an in-progress image and its corresponding DB record.

## Sample MongoDB documents

`users`

```json
{ "_id": "507f1f77bcf86cd799439011", "name": "Saifullah", "createdAt": "2026-10-12T09:00:00.000Z" }
```

`screenshotData` (collection name has exact capitalization):

```json
{
  "captureId": "e6e6b0d4-9c25-4941-8960-dc428152b1d0",
  "user": "507f1f77bcf86cd799439011",
  "userName": "Saifullah",
  "date": "2026-10-12",
  "time": "10:02:00",
  "timestamp": "2026-10-12T05:02:00.000Z",
  "machine": {"hostname": "WORKSTATION", "platform": "win32", "username": "Saif"},
  "screenshotPath": "C:\\Users\\Saif\\AppData\\Roaming\\DaymarkTimeTracker\\screenshots\\2026-10-12\\10-02-00-123-screen1.jpg",
  "screen": 1,
  "activeWindow": {"title": "Report - Word", "appName": "Microsoft Word", "processPath": "C:\\Program Files\\Microsoft Office\\WINWORD.EXE"},
  "extractedText": "Example OCR result",
  "unchanged": false,
  "createdAt": "2026-10-12T05:02:01.000Z"
}
```

`dailySummary`

```json
{
  "user": "507f1f77bcf86cd799439011",
  "userName": "Saifullah",
  "date": "2026-10-12",
  "totalSeconds": 7512,
  "firstStartAt": "2026-10-12T04:00:00.000Z",
  "lastActiveAt": "2026-10-12T07:05:12.000Z",
  "sessions": [
    { "sessionId": "session-uuid-one", "startedAt": "2026-10-12T04:00:00.000Z", "endedAt": "2026-10-12T05:30:00.000Z", "activeSeconds": 5400 },
    { "sessionId": "session-uuid-two", "startedAt": "2026-10-12T06:30:00.000Z", "endedAt": "2026-10-12T07:05:12.000Z", "activeSeconds": 2112 }
  ],
  "syncSources": { "installationIdHere": { "seconds": 7512 } },
  "updatedAt": "2026-10-12T07:05:13.000Z"
}
```

## Project layout

```text
time-tracker/
├── desktop/
│   ├── main.js                 # Electron main, window lifecycle and IPC
│   ├── preload.js              # isolated, minimal renderer API
│   └── renderer/
│       ├── index.html          # graphical interface
│       ├── style.css
│       └── app.js
├── src/
│   ├── config/db.js
│   ├── models/{User,ScreenshotData,DailySummary}.js
│   ├── services/{desktop.controller,screenshot,ocr,window,timer,tracker}.service.js
│   ├── utils/{format,image}.js
│   └── index.js                # original terminal program
├── scripts/seed-users.js
├── resources/{tracker.ico,tracker.png}
├── BUILD-EXE.bat             # double-click to build an installer/portable .exe
├── RUN-DESKTOP.bat           # double-click to launch GUI in development
├── tests/
├── screenshots/              # CLI runtime folder only
├── .env.example              # CLI configuration example
├── package.json
└── README.md
```

## Original CLI (optional)

For PowerShell users who want the lightest version:

```powershell
Copy-Item .env.example .env
notepad .env   # enter MONGODB_URI
npm run seed
npm run cli
```

Controls: `p` pause, `r` resume, `s` status, `q` quit. The CLI stores `state.json`, `pending-records.json`, and `screenshots/` in the project directory; these locations are **separate** from the desktop app's `%APPDATA%` directory. If you have existing CLI data that must be retained, back it up before moving it into the desktop data folder; do not overwrite an existing desktop checkpoint. 

## Developer tests

```powershell
npm run check
npm test
```

Unit tests cover heartbeat caps, pause/resume, crash session closure, midnight rollover, retry-safe counter expressions and common utilities. These tests are **not** a substitute for a real Windows + MongoDB Atlas integration test. A full end-to-end test requires Windows, npm dependencies, a valid Atlas cluster and screenshot access.

---
