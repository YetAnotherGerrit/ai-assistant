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
  messagesToHistory,
  threadWindow,
  threadHistory,
  collectThreadMessages,
  readThreadHistory,
  THREAD_FETCH_CAP,
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
    messageName: 'spaces/AAA/messages/1',
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

// Reading the thread between mentions. Google Chat delivers only @mentions, so
// anything said between them has to be fetched and handed to the conversation
// seam as history.
function chatMessage(text, type, createTime) {
  return { text, sender: { type }, createTime };
}

test("messagesToHistory: the bot's own messages are assistant, everyone else user", () => {
  const history = messagesToHistory([
    chatMessage('how do I deploy kafka', 'HUMAN', '2026-10-02T08:00:00Z'),
    chatMessage('run make buca', 'BOT', '2026-10-02T08:01:00Z'),
    chatMessage('that failed', 'HUMAN', '2026-10-02T08:02:00Z'),
  ]);
  assert.deepEqual(history, [
    { role: 'user', content: 'how do I deploy kafka' },
    { role: 'assistant', content: 'run make buca' },
    { role: 'user', content: 'that failed' },
  ]);
});

test('messagesToHistory drops messages carrying no text', () => {
  assert.deepEqual(
    messagesToHistory([chatMessage('', 'HUMAN', '1'), { sender: { type: 'BOT' } }]),
    [],
  );
});

test('messagesToHistory: an empty thread yields an empty history', () => {
  assert.deepEqual(messagesToHistory([]), []);
  assert.deepEqual(messagesToHistory(undefined), []);
});

test("threadWindow starts at the bot's own last message, inclusive", () => {
  const messages = [
    chatMessage('old', 'HUMAN', '1'),
    chatMessage('bot one', 'BOT', '2'),
    chatMessage('middle', 'HUMAN', '3'),
    chatMessage('bot two', 'BOT', '4'),
    chatMessage('after', 'HUMAN', '5'),
  ];
  assert.deepEqual(
    threadWindow(messages).map((m) => m.text),
    ['bot two', 'after'],
  );
});

test('threadWindow keeps everything when the bot has never answered', () => {
  const messages = [chatMessage('a', 'HUMAN', '1'), chatMessage('b', 'HUMAN', '2')];
  assert.equal(threadWindow(messages).length, 2);
});

// Chat reports the mentioning message with the @mention still in `text`, while
// `argumentText` has it stripped — so the conversation seam cannot recognise it
// as a duplicate and the request would reach the model twice.
test('threadHistory drops the mentioning message itself', () => {
  const messages = [
    {
      name: 'spaces/A/messages/1',
      text: 'the deploy failed',
      sender: { type: 'HUMAN' },
      createTime: '1',
    },
    {
      name: 'spaces/A/messages/2',
      text: '@Data Assistant what broke?',
      sender: { type: 'HUMAN' },
      createTime: '2',
    },
  ];
  assert.deepEqual(threadHistory(messages, 'spaces/A/messages/2'), [
    { role: 'user', content: 'the deploy failed' },
  ]);
});

// A thread longer than the cap: pagination must stop once the cap is reached,
// rather than draining the whole thread.
function pagedThread({ pages, perPage }) {
  const calls = { count: 0 };
  const fetchPage = async ({ pageToken }) => {
    calls.count += 1;
    const index = pageToken ? Number(pageToken) : 0;
    return {
      messages: Array.from({ length: perPage }, (_, i) => {
        const n = index * perPage + i;
        return chatMessage(`m${n}`, 'HUMAN', String(n).padStart(4, '0'));
      }),
      nextPageToken: index + 1 < pages ? String(index + 1) : null,
    };
  };
  return { fetchPage, calls };
}

test('collectThreadMessages stops paginating at the cap', async () => {
  const { fetchPage, calls } = pagedThread({ pages: 10, perPage: 10 });
  const out = await collectThreadMessages({ cap: 50, fetchPage });
  assert.equal(out.length, 50);
  assert.equal(calls.count, 5, 'stops requesting pages once the cap is reached');
});

test('collectThreadMessages keeps the most recent messages, not the oldest', async () => {
  const { fetchPage } = pagedThread({ pages: 4, perPage: 10 });
  const out = await collectThreadMessages({ cap: 15, fetchPage });
  assert.equal(out.length, 15);
  assert.equal(out[0].text, 'm5');
  assert.equal(out.at(-1).text, 'm19');
});

test('collectThreadMessages on an empty thread returns nothing', async () => {
  const out = await collectThreadMessages({
    cap: THREAD_FETCH_CAP,
    fetchPage: async () => ({ messages: [], nextPageToken: null }),
  });
  assert.deepEqual(out, []);
});

// The read must never fail a turn. Until a Workspace administrator grants
// `chat.app.messages.readonly`, `spaces.messages.list` answers 403 on EVERY
// turn — the bot still has to answer, with the mention alone. If this catch
// ever moves out to the subscriber, the throw reaches its outer catch, the
// message is nacked, and Pub/Sub redelivers it: a loop, not a degraded answer.
const THREAD_EVENT = {
  spaceName: 'spaces/AAA',
  threadName: 'spaces/AAA/threads/BBB',
  messageName: 'spaces/AAA/messages/2',
};

test('readThreadHistory returns an empty history when the read is refused', async () => {
  const history = await readThreadHistory(THREAD_EVENT, async () => {
    throw new Error('chat api 403: The administrator must grant the app the required scope');
  });
  assert.deepEqual(history, []);
});

test('readThreadHistory never throws, whatever the read fails with', async () => {
  const history = await readThreadHistory(THREAD_EVENT, async () => {
    throw new Error('getaddrinfo ENOTFOUND chat.googleapis.com');
  });
  assert.deepEqual(history, []);
});

test('readThreadHistory returns the thread window on a successful read', async () => {
  const history = await readThreadHistory(THREAD_EVENT, async () => [
    {
      name: 'spaces/AAA/messages/1',
      text: 'the deploy failed',
      sender: { type: 'HUMAN' },
      createTime: '1',
    },
    {
      name: 'spaces/AAA/messages/2',
      text: '@Data Assistant what broke?',
      sender: { type: 'HUMAN' },
      createTime: '2',
    },
  ]);
  assert.deepEqual(history, [{ role: 'user', content: 'the deploy failed' }]);
});

delete process.env.GCHAT_ALLOWED_EMAILS;
