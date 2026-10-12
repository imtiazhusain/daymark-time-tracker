'use strict';

function pad(value) { return String(value).padStart(2, '0'); }

function formatDuration(seconds) {
  const count = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(count / 3600);
  const minutes = Math.floor((count % 3600) / 60);
  const secs = count % 60;
  return `${hours}h ${pad(minutes)}m ${pad(secs)}s`;
}

// Use the *machine's local timezone*, not UTC.
function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localTime(date = new Date()) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileTime(date = new Date()) {
  return `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function midnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function positiveInt(value, fallback, min = 1, max = 86400) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function errorMessage(error) {
  return String(error && error.message ? error.message : error).replace(/\s+/g, ' ').slice(0, 220);
}

module.exports = { formatDuration, localDateKey, localTime, fileTime, midnight, positiveInt, errorMessage };
