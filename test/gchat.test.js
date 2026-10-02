'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The session-key tests assume a single identity; set it before config is
// first required (mirrors llm.test.js, which deletes it — same reason, the
// module-level require captures config.identity at load).
process.env.IDENTITY = 'data';
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/gchat')];
const {
  parseEvent,
  gchatSessionKey,
  classify,
  turnStatus,
  setPlaceholder,
  clearPlaceholder,
} = require('../src/gchat');

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

// The turn placeholder. It answers the mention immediately, so a multi-minute
// turn never looks dead, then closes out as a one-line status carrying the
// elapsed time. Both helpers are best-effort: the answer is already posted by
// the time they run, so a failed edit or delete must never turn a delivered
// answer into a failed turn.
test('turnStatus reports the elapsed time of a generated answer', () => {
  assert.equal(turnStatus({ ms: 120000 }), 'Answer was generated in 120s');
  assert.equal(turnStatus({ ms: 3800 }), 'Answer was generated in 4s');
});

test('turnStatus reports a failed turn', () => {
  assert.equal(turnStatus({ ms: 12000, failed: true }), 'Turn failed after 12s');
});

// "generated in 0s" reads as a bug rather than as "fast".
test('turnStatus floors at one second', () => {
  assert.equal(turnStatus({ ms: 200 }), 'Answer was generated in 1s');
  assert.equal(turnStatus({ ms: 0 }), 'Answer was generated in 1s');
});

test('setPlaceholder edits the placeholder to the status', async () => {
  const calls = [];
  const patch = async (args) => {
    calls.push(args);
  };
  await setPlaceholder({ name: 'spaces/AAA/messages/1' }, 'Answer was generated in 12s', patch);

  assert.deepEqual(calls, [
    { messageName: 'spaces/AAA/messages/1', text: 'Answer was generated in 12s' },
  ]);
});

test('setPlaceholder is a no-op when the turn never got a placeholder', async () => {
  const calls = [];
  const patch = async (args) => {
    calls.push(args);
  };
  await setPlaceholder(null, 'x', patch);
  await setPlaceholder(undefined, 'x', patch);
  await setPlaceholder({}, 'x', patch);

  assert.deepEqual(calls, [], 'nothing to edit — no call, and no error either');
});

test('setPlaceholder swallows a failed edit', async () => {
  await assert.doesNotReject(
    setPlaceholder({ name: 'spaces/AAA/messages/1' }, 'x', async () => {
      throw new Error('chat api 500');
    }),
    'a delivered answer must survive a failed status edit',
  );
});

// clearPlaceholder is the transient-failure path only: the turn is not over, so
// the placeholder goes rather than sitting beside the retry's own.
test('clearPlaceholder deletes the placeholder', async () => {
  const calls = [];
  await clearPlaceholder({ name: 'spaces/AAA/messages/1' }, async (args) => {
    calls.push(args);
  });

  assert.deepEqual(calls, [{ messageName: 'spaces/AAA/messages/1' }]);
});

test('clearPlaceholder is a no-op when the turn never got a placeholder', async () => {
  const calls = [];
  const remove = async (args) => {
    calls.push(args);
  };
  await clearPlaceholder(null, remove);
  await clearPlaceholder(undefined, remove);
  await clearPlaceholder({}, remove);

  assert.deepEqual(calls, [], 'nothing to delete — no call, and no error either');
});

test('clearPlaceholder swallows a failed delete', async () => {
  await assert.doesNotReject(
    clearPlaceholder({ name: 'spaces/AAA/messages/1' }, async () => {
      throw new Error('chat api 500');
    }),
    'a delivered answer must survive a failed placeholder delete',
  );
});
