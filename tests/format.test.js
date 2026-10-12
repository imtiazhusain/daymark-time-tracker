'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatDuration, localDateKey, positiveInt } = require('../src/utils/format');
const { meanPixelDifference } = require('../src/utils/image');

test('duration formatting', () => {
  assert.equal(formatDuration(7512), '2h 05m 12s');
  assert.equal(formatDuration(0), '0h 00m 00s');
  assert.equal(formatDuration(-1), '0h 00m 00s');
});
test('local date uses calendar day', () => {
  const date = new Date(2026, 9, 10, 23, 30, 0);
  assert.equal(localDateKey(date), '2026-10-10');
});
test('validated configurable intervals', () => {
  assert.equal(positiveInt('120', 30), 120);
  assert.equal(positiveInt('-1', 30), 30);
});
test('hash difference', () => {
  assert.equal(meanPixelDifference(Buffer.from([10, 20]), Buffer.from([12, 18])), 2);
  assert.equal(meanPixelDifference(null, Buffer.from([12])), Infinity);
});
