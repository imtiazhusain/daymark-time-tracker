'use strict';
const mongoose = require('mongoose');
const { errorMessage } = require('../utils/format');

mongoose.set('bufferCommands', false);

let lastAttempt = 0;
let connecting = null;
let reportedDown = false;

// MongoDB may emit asynchronous connection errors even after a successful
// initial connect. Handle them without crashing the tracker.
mongoose.connection.on('error', error => {
  if (!reportedDown) console.warn(`[db] Connection error: ${errorMessage(error)}`);
  reportedDown = true;
});

function isConnected() { return mongoose.connection.readyState === 1; }

async function ensureConnected(force = false) {
  if (isConnected()) { reportedDown = false; return true; }
  if (!process.env.MONGODB_URI) return false;
  if (connecting) return connecting;
  if (!force && Date.now() - lastAttempt < 15000) return false;

  lastAttempt = Date.now();
  connecting = (async () => {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        maxPoolSize: 2,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 4000,
        connectTimeoutMS: 4000,
        socketTimeoutMS: 8000,
        autoIndex: true
      });
      if (reportedDown) console.log('[db] MongoDB reconnected; syncing local data.');
      reportedDown = false;
      return true;
    } catch (error) {
      if (!reportedDown) console.warn(`[db] Offline: ${errorMessage(error)} (tracking will continue locally)`);
      reportedDown = true;
      return false;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

async function disconnect() {
  try { await mongoose.disconnect(); }
  catch (error) { console.warn(`[db] Disconnect: ${errorMessage(error)}`); }
}

module.exports = { mongoose, ensureConnected, isConnected, disconnect };
