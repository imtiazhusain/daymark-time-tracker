'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { loadMongoUri, saveMongoUri } = require('../src/services/connection-settings');

function temp(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daymark-connection-test-'));
  try { return callback(path.join(dir, 'data', '.env')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('first launch has no connection, subsequent launches load the saved URI', () => temp(file => {
  assert.equal(loadMongoUri(file), null);
  const uri = 'mongodb+srv://user:p%40ss%23word@cluster.example.net/timetracker?retryWrites=true&w=majority';
  saveMongoUri(file, uri);
  assert.equal(loadMongoUri(file), uri);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  // Simulate another application launch from the same Windows account.
  assert.equal(loadMongoUri(file), uri);
}));

test('updating saved Atlas details replaces the URI without deleting local time', () => temp(file => {
  saveMongoUri(file, 'mongodb://localhost:27017/old');
  saveMongoUri(file, 'mongodb://localhost:27017/new');
  assert.equal(loadMongoUri(file), 'mongodb://localhost:27017/new');
}));

test('loads connections saved by previous desktop version and manual plain env', () => temp(file => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'MONGODB_URI="mongodb+srv://user:p%40ss@cluster.example.net/db"\n');
  assert.equal(loadMongoUri(file), 'mongodb+srv://user:p%40ss@cluster.example.net/db');
  fs.writeFileSync(file, 'MONGODB_URI=mongodb://localhost:27017/db\n');
  assert.equal(loadMongoUri(file), 'mongodb://localhost:27017/db');
}));

test('rejects malformed URIs without overwriting existing saved connection', () => temp(file => {
  const valid = 'mongodb://localhost:27017/db';
  saveMongoUri(file, valid);
  assert.throws(() => saveMongoUri(file, 'http://example.org'), /Enter a complete/);
  assert.equal(loadMongoUri(file), valid);
}));
