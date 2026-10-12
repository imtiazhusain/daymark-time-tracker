'use strict';
// The desktop version saves its Atlas URI once in its stable Windows app-data
// directory. A JSON-quoted .env value preserves punctuation in passwords; the
// original CLI continues to use dotenv and its own project-local .env.
const fs = require('fs');
const path = require('path');

function validateMongoUri(value) {
  const uri = String(value || '').trim();
  if (!/^mongodb(?:\+srv)?:\/\/[^\r\n]+$/i.test(uri)) {
    throw new Error('Enter a complete mongodb:// or mongodb+srv:// connection URI.');
  }
  return uri;
}

function loadMongoUri(file) {
  if (!fs.existsSync(file)) return null;
  const contents = fs.readFileSync(file, 'utf8');
  const line = contents.split(/\r?\n/).find(part => /^\s*MONGODB_URI\s*=/.test(part));
  if (!line) return null;
  const encoded = line.slice(line.indexOf('=') + 1).trim();
  if (!encoded) return null;
  // Existing builds wrote JSON-stringified values, which are deliberately
  // parsed before anything else. Also support manually authored plain .envs.
  const value = encoded.startsWith('"') ? JSON.parse(encoded) : encoded;
  return validateMongoUri(value);
}

function saveMongoUri(file, uri) {
  const normalized = validateMongoUri(uri);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, `MONGODB_URI=${JSON.stringify(normalized)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return normalized;
}

module.exports = { validateMongoUri, loadMongoUri, saveMongoUri };
