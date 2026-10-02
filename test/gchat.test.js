'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The session-key tests assume a single identity; set it before config is
// first required (mirrors llm.test.js, which deletes it — same reason, the
// module-level require captures config.identity at load).
process.env.IDENTITY = 'data';
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/gchat')];
const { parseEvent, gchatSessionKey, classify, withProgress } = require('../src/gchat');

const CHAT_EVENT = {
  commonEventObject: { hostApp: 'CHAT', platform: 'WEB' },
  chat: {
    user: { name: 'users/1', displayName: 'Alice', email: 'alice@example.com', type: 'HUMAN' },
    eventTime: '2026-09-04T08:51:28.326367Z',
    messagePayload: {
      space: { name: 'spaces/AAA', type: 'DM' },
      message: {
        name: 'spaces/AAA/messages/1',
        argumentText: 'ping',
        thread: { name: 'spaces/AAA/threads/BBB' },
      },
    },
  },
};

test('parseEvent extracts Chat message fields', () => {
  const event = parseEvent(Buffer.from(JSON.stringify(CHAT_EVENT)));
  assert.deepEqual(event, {
    spaceName: 'spaces/AAA',
    threadName: 'spaces/AAA/threads/BBB',
    senderEmail: 'alice@example.com',
    argumentText: 'ping',
  });
});

test('parseEvent skips non-CHAT host', () => {
  const payload = { ...CHAT_EVENT, commonEventObject: { hostApp: 'GMAIL' } };
  assert.equal(parseEvent(Buffer.from(JSON.stringify(payload))), null);
});

test('parseEvent skips events without messagePayload', () => {
  const payload = { commonEventObject: { hostApp: 'CHAT' }, chat: {} };
  assert.equal(parseEvent(Buffer.from(JSON.stringify(payload))), null);
});

test('parseEvent returns null on invalid JSON', () => {
  assert.equal(parseEvent(Buffer.from('not json')), null);
});

test('gchatSessionKey uses trailing ids, identity last', () => {
  assert.equal(gchatSessionKey('spaces/AAA', 'spaces/AAA/threads/BBB'), 'gchat:AAA_BBB:data');
});

test('gchatSessionKey degrades to _space without a thread', () => {
  assert.equal(gchatSessionKey('spaces/AAA', null), 'gchat:AAA_space:data');
});

test('gchatSessionKey has exactly three colon segments, gchat prefix', () => {
  const key = gchatSessionKey('spaces/AAA', 'spaces/AAA/threads/BBB');
  assert.equal(key.split(':').length, 3);
  assert.equal(key.split(':')[0], 'gchat');
  assert.equal(key.split(':')[2], 'data');
});

test('classify: non-empty is shape, empty is ask-requester', () => {
  assert.equal(classify('how do I deploy kafka'), 'shape');
  assert.equal(classify(''), 'ask-requester');
  assert.equal(classify('   '), 'ask-requester');
});

// The sender gate. A Chat turn runs Claude Code in a clone of the Data
// Assistant vault, so anyone who can mention the app can read from it — the
// allowlist is what holds that to the named people. Every case below reloads
// BOTH modules: gchat captures `config` at load, so re-requiring config alone
// would leave the predicate reading a stale list.
function loadGchat(emails) {
  if (emails === undefined) delete process.env.GCHAT_ALLOWED_EMAILS;
  else process.env.GCHAT_ALLOWED_EMAILS = emails;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/gchat')];
  return require('../src/gchat');
}

test('isAllowedSender refuses everyone when GCHAT_ALLOWED_EMAILS is unset', () => {
  assert.equal(loadGchat(undefined).isAllowedSender('alice@seibert.group'), false);
});

test('isAllowedSender refuses everyone when GCHAT_ALLOWED_EMAILS is empty', () => {
  assert.equal(loadGchat('').isAllowedSender('alice@seibert.group'), false);
});

test('isAllowedSender admits a listed address and refuses an unlisted one', () => {
  const gchat = loadGchat('alice@seibert.group, bob@seibert.group');
  assert.ok(gchat.isAllowedSender('alice@seibert.group'));
  assert.ok(gchat.isAllowedSender('bob@seibert.group'));
  assert.equal(gchat.isAllowedSender('mallory@example.com'), false);
});

// Google reports the address in the account's own casing, so a byte compare
// would refuse the very people on the list. Both directions are checked: the
// casing can arrive on either side.
test('isAllowedSender ignores case on both the sender and the list entry', () => {
  assert.ok(loadGchat('alice@seibert.group').isAllowedSender('Alice@Seibert.Group'));
  assert.ok(loadGchat('Alice@Seibert.Group').isAllowedSender('alice@seibert.group'));
});

test('isAllowedSender refuses a message that carries no sender address', () => {
  const gchat = loadGchat('alice@seibert.group');
  assert.equal(gchat.isAllowedSender(''), false);
  assert.equal(gchat.isAllowedSender(undefined), false);
});

delete process.env.GCHAT_ALLOWED_EMAILS;

// The progress notice. A demo turn that investigates and writes code takes
// minutes, and without a notice the thread looks dead until the answer lands.
// The threshold is what keeps the notice off ordinary turns, so every case
// below drives an injected clock instead of waiting out a real one.
function fakeClock() {
  const timers = [];
  let scheduled = 0;
  return {
    schedule(fn) {
      scheduled += 1;
      const timer = { fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel(timer) {
      if (timer) timer.cancelled = true;
    },
    // Fire every live timer, the way the event loop would once the delay
    // elapses.
    async fire() {
      for (const timer of timers) if (!timer.cancelled) await timer.fn();
    },
    scheduledCount: () => scheduled,
    liveCount: () => timers.filter((t) => !t.cancelled).length,
  };
}

test('withProgress posts nothing when the turn settles first', async () => {
  const clock = fakeClock();
  let posts = 0;
  const answer = await withProgress({
    afterMs: 15000,
    onProgress: () => {
      posts += 1;
    },
    run: async () => 'fast answer',
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  assert.equal(answer, 'fast answer');
  assert.equal(posts, 0, 'a turn under the threshold must post no progress notice');
  assert.equal(clock.liveCount(), 0, 'the timer is cleared, so a fast turn cannot post later');
});

test('withProgress posts exactly once when the turn outlives the threshold', async () => {
  const clock = fakeClock();
  let posts = 0;
  const answer = await withProgress({
    afterMs: 15000,
    onProgress: () => {
      posts += 1;
    },
    run: async () => {
      await clock.fire();
      return 'slow answer';
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  assert.equal(answer, 'slow answer');
  assert.equal(posts, 1, 'a slow turn posts one notice, not one per interval');
  assert.equal(clock.scheduledCount(), 1, 'the timer is armed once and never re-armed');
});

test('withProgress lands the notice before the answer', async () => {
  const clock = fakeClock();
  const landed = [];
  await withProgress({
    afterMs: 15000,
    onProgress: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      landed.push('progress');
    },
    run: async () => {
      await clock.fire();
      return 'slow answer';
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  landed.push('answer');

  assert.deepEqual(
    landed,
    ['progress', 'answer'],
    'the notice must be in the thread before the answer',
  );
});

test('withProgress never loses the answer to a failed notice', async () => {
  const clock = fakeClock();
  const answer = await withProgress({
    afterMs: 15000,
    onProgress: async () => {
      throw new Error('chat api 500');
    },
    run: async () => {
      await clock.fire();
      return 'slow answer';
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  assert.equal(answer, 'slow answer', 'a courtesy notice must never fail the turn');
});
