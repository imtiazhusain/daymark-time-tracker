'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ActivityService = require('../src/services/activity.service');

test('activity measures input seconds and resets the capture window', () => {
  let time = 0;
  let idle = 0;
  const activity = new ActivityService({ getIdleSeconds: () => idle, now: () => time });
  activity.start();
  assert.equal(activity.snapshot().activityPercentage, null);
  time = 1000; activity.sample();
  idle = 2; time = 2000; activity.sample();
  assert.deepEqual(activity.snapshot(), {
    activityPercentage: 50, activityWindowSeconds: 2, activityActiveSeconds: 1
  });
  activity.stop();
  time = 100000;
  activity.start();
  time += 1000;
  assert.equal(activity.snapshot().activityPercentage, 0);
  activity.stop();
});

test('long gaps do not become fully active and failures are unavailable', () => {
  let time = 0;
  let fail = false;
  const activity = new ActivityService({ getIdleSeconds: () => {
    if (fail) throw new Error('Unavailable');
    return 0;
  }, now: () => time });
  activity.start();
  time = 100000;
  assert.equal(activity.snapshot().activityPercentage, 1);
  fail = true; time += 1000;
  assert.equal(activity.snapshot().activityPercentage, null);
  activity.stop();
});
