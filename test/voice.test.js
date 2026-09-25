'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
// `make precommit` sources local.env (Makefile `-include`), which sets
// IDENTITY, and these key-shape tests assume a single-identity deployment —
// exactly the trap test/llm.test.js already dodges by deleting the var before
// the first require of config. Without this, every `voice:G1` assertion fails
// with a `:personal` suffix it never asked for.
delete process.env.IDENTITY;
delete require.cache[require.resolve('../src/config')];
const voice = require('../src/voice');
const config = require('../src/config');
const { Session } = voice;

// postToChannel is a routing function over `sessions`, `.closed`, `.channel`,
// and `.transcript` — none of it needs a real Discord connection or audio
// pipeline, unlike the rest of this module (see CLAUDE.md's "Verifying Voice
// Changes"), so fake session objects are enough to exercise the three
// branches the design calls out: no live session, exactly one, and two+.
function fakeSession({ channelId = 'chan-1', closed = false, sendImpl, guildId } = {}) {
  const sent = [];
  const transcriptWrites = [];
  return {
    channelId,
    guildId,
    closed,
    channel: {
      send: sendImpl || (async (part) => sent.push(part)),
    },
    transcript: { writeText: (speaker, text) => transcriptWrites.push({ speaker, text }) },
    // yieldVoice() (and leave()) call destroy() — a no-op is enough here since
    // these fakes never own a real voice connection.
    destroy: () => {},
    _sent: sent,
    _transcriptWrites: transcriptWrites,
  };
}

// speak() tells the endpoint out of band that the turn came from the keyboard
// (llm.markTypedTurn). Stubbed here so the suite never reaches a real endpoint
// — an unstubbed call would POST to whatever is listening on the developer's
// machine and set a hint on a LIVE shim, which is a test quietly mutating
// production-ish state, not a passing test. Recorded so the calls themselves
// can be asserted.
const llm = require('../src/llm');
const realMarkTypedTurn = llm.markTypedTurn;
const realSetVoiceSolo = llm.setVoiceSolo;
const realSetVoiceWake = llm.setVoiceWake;
const realSetTranscribe = llm.setTranscribe;
let typedTurnCalls = [];
let voiceSoloCalls = [];
let voiceWakeCalls = [];
let transcribeCalls = [];

test.beforeEach(() => {
  voice.sessions.clear();
  // A test that armed a rejoin must not leave the timer or the attempt counter
  // behind for the next one — the counter is module-level by design (a rejoin
  // replaces the Session), so clearing `sessions` alone does not reset it.
  for (const state of voice.rejoins.values()) if (state.timer) clearTimeout(state.timer);
  voice.rejoins.clear();
  typedTurnCalls = [];
  voiceSoloCalls = [];
  voiceWakeCalls = [];
  transcribeCalls = [];
  llm.markTypedTurn = async (key, typed = true) => {
    typedTurnCalls.push({ key, typed });
    return true;
  };
  llm.setVoiceSolo = async (solo, key) => {
    voiceSoloCalls.push({ solo, key });
    return { ok: true };
  };
  llm.setVoiceWake = async (value, key) => {
    voiceWakeCalls.push({ value, key });
    return { ok: true };
  };
  llm.setTranscribe = async (value, key) => {
    transcribeCalls.push({ value, key });
    return { ok: true };
  };
});

test.after(() => {
  llm.markTypedTurn = realMarkTypedTurn;
  llm.setVoiceSolo = realSetVoiceSolo;
  llm.setVoiceWake = realSetVoiceWake;
  llm.setTranscribe = realSetTranscribe;
});

// speak() awaits the typed-turn hint BEFORE touching the socket, so the two
// sends no longer happen in the same tick as the call — they land one
// microtask later. Tests that assert on the sends, or that emit the ack the
// sends are waiting for, have to let that turn first.
const flush = () => new Promise((r) => setImmediate(r));

// One 20ms frame of the playback queue, mirroring OUT_FRAME in src/voice.js.
// Used by the /cancel tests to hand pushAudio() a chunk big enough to be
// observable if it is (wrongly) queued.
const OUT_FRAME_BYTES = (48000 * 2 * 2 * 20) / 1000;

test('postToChannel drops with no-live-session when sessions is empty', async () => {
  const result = await voice.postToChannel('ARC-L1 Wide Forest Station');
  assert.deepEqual(result, { posted: false, reason: 'no-live-session' });
});

test('postToChannel drops with no-live-session when every session is closed', async () => {
  voice.sessions.set('guild-1', fakeSession({ closed: true }));
  const result = await voice.postToChannel('hello');
  assert.deepEqual(result, { posted: false, reason: 'no-live-session' });
});

test('postToChannel sends and writes the transcript for exactly one live session', async () => {
  const session = fakeSession({ channelId: 'chan-42' });
  voice.sessions.set('guild-1', session);

  const result = await voice.postToChannel('ARC-L1 Wide Forest Station');

  assert.deepEqual(result, { posted: true, channel: 'chan-42' });
  assert.deepEqual(session._sent, ['ARC-L1 Wide Forest Station']);
  assert.equal(session._transcriptWrites.length, 1);
  assert.equal(session._transcriptWrites[0].text, 'ARC-L1 Wide Forest Station');
});

test('postToChannel drops as ambiguous when two sessions are live', async () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1' }));
  voice.sessions.set('guild-2', fakeSession({ channelId: 'chan-2' }));

  const result = await voice.postToChannel('hello');

  assert.deepEqual(result, { posted: false, reason: 'ambiguous-multiple-sessions' });
});

test('postToChannel ignores a closed session and still picks the one live session', async () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-closed', closed: true }));
  const live = fakeSession({ channelId: 'chan-live' });
  voice.sessions.set('guild-2', live);

  const result = await voice.postToChannel('hello');

  assert.deepEqual(result, { posted: true, channel: 'chan-live' });
});

test('postToChannel reports send-failed when channel.send throws', async () => {
  const session = fakeSession({
    sendImpl: async () => {
      throw new Error('boom');
    },
  });
  voice.sessions.set('guild-1', session);

  const result = await voice.postToChannel('hello');

  assert.deepEqual(result, { posted: false, reason: 'send-failed' });
  assert.equal(session._transcriptWrites.length, 0, 'no transcript write on a failed send');
});

test('postToChannel voiceOnly writes the transcript but never sends to the channel', async () => {
  const session = fakeSession({ channelId: 'chan-42' });
  voice.sessions.set('guild-1', session);

  const result = await voice.postToChannel('ARC-L1 Wide Forest Station', { voiceOnly: true });

  // The channel stays quiet — this is the whole point of the switch.
  assert.deepEqual(result, { posted: false, reason: 'voice-only', channel: 'chan-42' });
  assert.deepEqual(session._sent, []);
  // ...but the record keeps the full answer, so silencing the chat loses nothing.
  assert.equal(session._transcriptWrites.length, 1);
  assert.equal(session._transcriptWrites[0].text, 'ARC-L1 Wide Forest Station');
});

test('postToChannel voiceOnly still chunks-drops nothing and follows the same routing', async () => {
  // Voice-only must not change the routing rules — an ambiguous multi-session
  // call is still dropped rather than guessed at, and the transcript write
  // still lands only for exactly one live session.
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1' }));
  voice.sessions.set('guild-2', fakeSession({ channelId: 'chan-2' }));

  const result = await voice.postToChannel('hello', { voiceOnly: true });

  assert.deepEqual(result, { posted: false, reason: 'ambiguous-multiple-sessions' });
});

test('yieldVoice is a no-op success when this identity holds no call', async () => {
  const result = await voice.yieldVoice('sc');
  assert.deepEqual(result, { yielded: false, reason: 'no-live-session' });
});

test('yieldVoice leaves the live call and announces who took over', async () => {
  const session = fakeSession({ channelId: 'chan-1', guildId: 'guild-1' });
  voice.sessions.set('guild-1', session);
  let destroyed = false;
  session.destroy = () => (destroyed = true);

  const result = await voice.yieldVoice('sc');

  assert.equal(result.yielded, true);
  assert.deepEqual(result.channels, ['chan-1']);
  assert.equal(destroyed, true);
  assert.equal(voice.sessions.has('guild-1'), false);
  assert.equal(session._sent.length, 1);
  assert.match(session._sent[0], /sc is taking over/);
  assert.equal(session._transcriptWrites.length, 1);
  assert.match(session._transcriptWrites[0].text, /yielded to sc/);
});

test('yieldVoice ignores a closed session, same as postToChannel', async () => {
  voice.sessions.set('guild-1', fakeSession({ closed: true }));
  const result = await voice.yieldVoice('sc');
  assert.deepEqual(result, { yielded: false, reason: 'no-live-session' });
});

// liveSessionFor and Session.speak are the routing + injection halves of
// "typed during a live call is answered aloud" — exercised the same way as
// postToChannel above: fake collaborators, no real Discord/s2s connection.

function fakeWs({ readyState = WebSocket.OPEN } = {}) {
  const ws = new EventEmitter();
  ws.readyState = readyState;
  ws.sent = [];
  ws.send = (raw) => ws.sent.push(JSON.parse(raw));
  return ws;
}

test('liveSessionFor returns null when the guild has no session', () => {
  assert.equal(voice.liveSessionFor('guild-1', 'chan-1'), null);
});

test('liveSessionFor returns null for a closed session', () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1', closed: true }));
  assert.equal(voice.liveSessionFor('guild-1', 'chan-1'), null);
});

test('liveSessionFor returns null when the channel does not match', () => {
  voice.sessions.set('guild-1', fakeSession({ channelId: 'chan-1' }));
  assert.equal(voice.liveSessionFor('guild-1', 'chan-2'), null);
});

test('liveSessionFor returns the session when live and the channel matches', () => {
  const session = fakeSession({ channelId: 'chan-1' });
  voice.sessions.set('guild-1', session);
  assert.equal(voice.liveSessionFor('guild-1', 'chan-1'), session);
});

// /cancel is the ONE stop path that is not gated on config.interruptResponse,
// so it cannot lean on the server to stop generating the way barge-in does
// (speech_started carries turn_detection.interrupt_response; a slash command
// carries nothing). The response keeps arriving, and `stopAudio()` alone only
// drops what has already landed — the next chunk re-opens playback and the
// abandoned reply resumes mid-sentence. These four tests pin the suppression
// that makes the command real, and the clears that keep it from muting the
// NEXT reply. The player is a stub because the module loads real Discord deps.
function playbackCtx(t, { speaking = false, cancelled = false } = {}) {
  const ctx = {
    speaking,
    cancelled,
    audio: null,
    outQueue: Buffer.alloc(0),
    outTick: null,
    ending: false,
    speechOff: false,
    stallStartedAt: null,
    stallDetected: false,
    player: {
      stopCalls: 0,
      playCalls: 0,
      stop() {
        this.stopCalls += 1;
      },
      play() {
        this.playCalls += 1;
      },
    },
    // cancelPlayback() calls through to these, so the context has to carry the
    // real implementations — otherwise the test would be asserting against a
    // stand-in rather than the code that ships. clearStallClock() is a no-op
    // here because stallStartedAt is null (nothing is armed).
    stopAudio: Session.prototype.stopAudio,
    clearStallClock: Session.prototype.clearStallClock,
    // Reached by the response.done / response.created handlers. Both are
    // no-ops on this context (no audio to end, no channel to type in), but they
    // have to exist for onEvent() to run to the line under test.
    endAudio: Session.prototype.endAudio,
    showTyping: Session.prototype.showTyping,
    // pushAudio() reports the stall measurement before it starts playback.
    // No-op here: stallStartedAt is null, which is the "no clock armed" state.
    reportStall: Session.prototype.reportStall,
  };
  // pushAudio() arms the pacing interval on the happy path. A real interval
  // would hold the test process open, so it is cleared however the test ends.
  t.after(() => clearInterval(ctx.outTick));
  return ctx;
}

const onCtx = (ctx, event) => Session.prototype.onEvent.call(ctx, JSON.stringify(event));

test('cancelPlayback is a no-op when nothing is playing', (t) => {
  const ctx = playbackCtx(t, { speaking: false });
  assert.equal(Session.prototype.cancelPlayback.call(ctx), false);
  // Not merely "returned false" — it must not arm the suppression, or a
  // no-op /cancel would silently swallow the next genuine reply.
  assert.equal(ctx.cancelled, false);
});

test('cancelPlayback stops playback and suppresses the rest of the turn', (t) => {
  const ctx = playbackCtx(t, { speaking: true });
  assert.equal(Session.prototype.cancelPlayback.call(ctx), true);
  assert.equal(ctx.speaking, false, 'the flag /cancel reports on is cleared');
  assert.equal(ctx.cancelled, true, 'the turn is marked suppressed');
  assert.equal(ctx.player.stopCalls, 1, 'playback was actually stopped');
});

test('a cancelled turn does not restart playback on the next chunk', (t) => {
  const ctx = playbackCtx(t, { speaking: true });
  Session.prototype.cancelPlayback.call(ctx);
  // A chunk from the same server response, arriving after the cancel.
  Session.prototype.pushAudio.call(ctx, Buffer.alloc(OUT_FRAME_BYTES, 7));
  assert.equal(ctx.audio, null, 'no playback stream is re-opened');
  assert.equal(ctx.player.playCalls, 0, 'the player is never re-started');
  assert.equal(ctx.outQueue.length, 0, 'the cleared queue is not refilled');
  assert.equal(ctx.speaking, false, 'the reply does not resume');
});

test('a cancelled turn does not speak the stall clip', (t) => {
  const ctx = playbackCtx(t, { speaking: true });
  Session.prototype.cancelPlayback.call(ctx);
  Session.prototype.speakStallClip.call(ctx);
  assert.equal(ctx.audio, null, 'the filler must not re-open playback');
});

test('a fresh response clears the suppression so the next reply plays', (t) => {
  const ctx = playbackCtx(t, { speaking: true });
  Session.prototype.cancelPlayback.call(ctx);
  assert.equal(ctx.cancelled, true);
  onCtx(ctx, { type: 'response.done' });
  assert.equal(ctx.cancelled, false, 'the next reply must not be swallowed');
  // And the following chunk plays normally again.
  Session.prototype.pushAudio.call(ctx, Buffer.alloc(OUT_FRAME_BYTES, 7));
  assert.notEqual(ctx.audio, null, 'playback resumes for the next turn');
  assert.equal(ctx.player.playCalls, 1, 'the player was re-started');
});

test('response.created is the backstop clear for a turn that ended silently', (t) => {
  const ctx = playbackCtx(t, { speaking: true });
  Session.prototype.cancelPlayback.call(ctx);
  onCtx(ctx, { type: 'response.created' });
  assert.equal(ctx.cancelled, false);
});

test('speak resolves no-socket when the session is closed', async () => {
  const fake = { closed: true, ws: fakeWs(), typedReplyPending: false };
  const result = await Session.prototype.speak.call(fake, 'hello');
  assert.deepEqual(result, { ok: false, reason: 'no-socket' });
});

test('speak resolves no-socket when the ws is not open', async () => {
  const fake = {
    closed: false,
    ws: fakeWs({ readyState: WebSocket.CONNECTING }),
    typedReplyPending: false,
  };
  const result = await Session.prototype.speak.call(fake, 'hello');
  assert.deepEqual(result, { ok: false, reason: 'no-socket' });
});

test('speak sends conversation.item.create then response.create, in order', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'tell me a joke via voice');
  await flush();
  assert.equal(ws.sent.length, 2);
  assert.equal(ws.sent[0].type, 'conversation.item.create');
  assert.deepEqual(ws.sent[0].item, {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'tell me a joke via voice' }],
  });
  assert.equal(ws.sent[1].type, 'response.create');
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  assert.deepEqual(await pending, { ok: true });
});

test('a transcribed mic utterance raises the typing indicator', () => {
  let typingCalls = 0;
  const fake = fakeOnEventTarget({
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  // The spoken path does NOT get response.created — the server only emits it
  // for a client-requested response (handlers/response.py:191). Driving this
  // test with response.created is what made the first attempt look correct
  // while doing nothing on a real call.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hey bot, how many vision pages do I have',
    }),
  );

  assert.equal(fake.answering, true);
  assert.equal(typingCalls, 1, 'shown immediately, not on the first 8s tick');
  clearInterval(fake.typingTimer);
});

test('an accumulated turn is still addressed when a later sentence opens with the phrase', () => {
  // The exact live failure: speech-to-speech grows one turn across progressive
  // finals, so the phrase never sits at position zero and a whole-utterance
  // prefix match rejected three properly-addressed attempts in a row.
  assert.equal(
    config.isAddressed(
      'Uh can you check about my free disk space? Hey bot, can you check about my free disk space?',
    ),
    true,
  );
  // Still anchored — the phrase has to OPEN a sentence, not merely appear.
  assert.equal(config.isAddressed('I told him the bot was broken'), false);
  assert.equal(config.isAddressed("So, hey bot, what's my task"), false);
  assert.equal(config.isAddressed('hey Bob, did you see this'), false);
});

test('boolean settings accept the spellings people actually write', () => {
  // INTERRUPT_RESPONSE=true silently did nothing when this only tested for '1'.
  const saved = process.env.INTERRUPT_RESPONSE;
  try {
    for (const [raw, want] of [
      ['1', true],
      ['true', true],
      ['ON', true],
      ['yes', true],
      ['0', false],
      ['false', false],
      ['off', false],
      ['"1"', true], // Make's include leaves the quotes in the value
    ]) {
      process.env.INTERRUPT_RESPONSE = raw;
      delete require.cache[require.resolve('../src/config')];
      assert.equal(require('../src/config').interruptResponse, want, `for ${raw}`);
    }
  } finally {
    if (saved === undefined) delete process.env.INTERRUPT_RESPONSE;
    else process.env.INTERRUPT_RESPONSE = saved;
    delete require.cache[require.resolve('../src/config')];
    require('../src/config');
  }
});

test('an unaddressed utterance raises no indicator and never sets answering', () => {
  let typingCalls = 0;
  const fake = fakeOnEventTarget({
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'what do you think about the deploy',
    }),
  );

  // Not cosmetic: the endpoint answers an unaddressed turn with silence, so
  // nothing arrives to clear `answering`. Left set, it hangs the dots until the
  // five-minute cap AND makes speak() refuse typed turns as busy for the same
  // period — every sentence said to a colleague would wedge the typed path.
  assert.equal(typingCalls, 0, 'no dots for speech that will never be answered');
  assert.equal(fake.answering, false, 'and the busy gate must not arm');
  assert.equal(fake.typingTimer, null);
});

test('the indicator stops when the response ends', () => {
  const fake = fakeOnEventTarget({
    channel: { sendTyping: async () => {} },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hey bot, hi',
    }),
  );
  assert.equal(fake.answering, true);
  Session.prototype.onEvent.call(fake, JSON.stringify({ type: 'response.done' }));
  assert.equal(fake.answering, false, 'the ticker stops itself on the next tick');
  clearInterval(fake.typingTimer);
});

test('showTyping does not stack a second ticker on a repeated response.created', () => {
  let typingCalls = 0;
  const fake = fakeOnEventTarget({
    channel: {
      sendTyping: async () => {
        typingCalls += 1;
      },
    },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });

  const utterance = JSON.stringify({
    type: 'conversation.item.input_audio_transcription.completed',
    transcript: 'hey bot, hi',
  });
  Session.prototype.onEvent.call(fake, utterance);
  Session.prototype.onEvent.call(fake, utterance);

  assert.equal(typingCalls, 1, 'the second call must find a live ticker and leave it alone');
  clearInterval(fake.typingTimer);
});

// These two carry a real `guildId`. Without one, `voiceKeyFor(undefined)` falls
// back to `default` — so a keyless fake made them pass against BOTH the buggy
// and the fixed code, which is how they came to assert `default` and quietly
// contradict the regression test below.
test('speak tells the endpoint the turn was typed, before sending anything', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-1' };
  const pending = Session.prototype.speak.call(fake, 'what is my most important task');
  // Ordering is the whole point: the endpoint consumes the hint at the top of
  // the turn, so a hint that lands after the send is a hint that arrives too
  // late for the turn it describes.
  assert.deepEqual(typedTurnCalls, [{ key: 'voice:guild-1', typed: true }]);
  assert.equal(ws.sent.length, 0, 'nothing sent until the hint is in');
  await flush();
  assert.equal(ws.sent.length, 2);
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.deepEqual(
    typedTurnCalls,
    [{ key: 'voice:guild-1', typed: true }],
    'not retracted on success',
  );
});

test('speak retracts the typed hint when the turn never happens', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-1' };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 20 });
  await flush();
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
  // Otherwise the next unrelated SPOKEN reply inherits the flag and gets
  // posted to the channel as though someone had typed the question.
  assert.deepEqual(typedTurnCalls, [
    { key: 'voice:guild-1', typed: true },
    { key: 'voice:guild-1', typed: false },
  ]);
});

test('a proactively-refused speak never sets a hint at all', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, inResponse: true };
  await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(typedTurnCalls, [], 'the common busy case must not touch the endpoint');
});

test('speak sets typedReplyPending on a successful ack', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.equal(fake.typedReplyPending, true);
});

test('speak resolves busy on conversation_already_has_active_response', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  ws.emit(
    'message',
    JSON.stringify({ type: 'error', error: { type: 'conversation_already_has_active_response' } }),
  );
  assert.deepEqual(await pending, { ok: false, reason: 'busy' });
  assert.equal(fake.typedReplyPending, false, 'a refused response must not be marked pending');
});

test('speak ignores unrelated events and resolves timeout if nothing acks', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 20 });
  await flush();
  ws.emit('message', JSON.stringify({ type: 'response.output_audio.delta', delta: 'AAAA' }));
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
});

test('speak resolves on any error type, not just conversation_already_has_active_response', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  ws.emit('message', JSON.stringify({ type: 'error', error: { type: 'invalid_request' } }));
  assert.deepEqual(await pending, { ok: false, reason: 'invalid_request' });
});

test('speak refuses busy without sending anything when a response is already in flight', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, inResponse: true };
  const result = await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 0, 'a proactively-refused speak() must not send anything');
});

test('speak refuses busy while a MIC turn is being answered', async () => {
  const ws = fakeWs();
  // `inResponse` deliberately false: a mic turn never gets response.created,
  // so this is the state a real spoken answer is actually in. Gating only on
  // inResponse let this case through to be refused by the server instead.
  const fake = { closed: false, ws, typedReplyPending: false, answering: true };
  const result = await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 0);
  assert.deepEqual(typedTurnCalls, [], 'and no typed hint is left behind');
});

test('speak refuses busy when another speak() is already awaiting its ack', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, awaitingSpeakAck: true };
  const result = await Session.prototype.speak.call(fake, 'hi');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(ws.sent.length, 0);
});

test('speak sets and clears awaitingSpeakAck around a successful round trip', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi');
  await flush();
  assert.equal(fake.awaitingSpeakAck, true, 'set before the ack arrives');
  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
  assert.equal(fake.awaitingSpeakAck, false, 'cleared once the ack settles the promise');
  assert.equal(fake.pendingSpeakFinish, null);
});

test('speak resolves no-socket immediately when connectS2S tears down the socket mid-wait', async () => {
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false };
  const pending = Session.prototype.speak.call(fake, 'hi', { timeoutMs: 5000 });
  await flush();
  // Simulate connectS2S()'s fail-fast hook without a real reconnect.
  fake.pendingSpeakFinish({ ok: false, reason: 'no-socket' });
  assert.deepEqual(await pending, { ok: false, reason: 'no-socket' });
});

// onEvent is the other half of the round trip: it is what actually flips
// inResponse/typedReplyPending as real server events arrive, and what marks
// the transcript. Exercised directly (not just observed via speak()'s
// side effects) with a fake collaborator — onEvent's only preconditions are
// `this.audio` (endAudio() no-ops when null) and `this.transcript`.
function fakeOnEventTarget(overrides = {}) {
  const transcriptWrites = [];
  // Prototype-backed, not a bare object literal: onEvent dispatches to real
  // Session methods, and on a plain object every one of those is a TypeError
  // rather than a no-op — which is how the stall clock's clearStallClock()
  // call broke eight unrelated tests the moment it was added. Own properties
  // below still shadow the prototype, so the explicit stubs keep winning.
  return Object.assign(Object.create(Session.prototype), {
    audio: null,
    speaking: false,
    typedReplyPending: false,
    inResponse: false,
    transcript: { writeText: (speaker, text) => transcriptWrites.push({ speaker, text }) },
    _transcriptWrites: transcriptWrites,
    endAudio: () => {},
    // Stubbed by default so the event tests stay about event handling; the two
    // tests that are ABOUT the indicator pass the real prototype method in.
    showTyping: () => {},
    answering: false,
    // Wait state for the "slot already in use" retry deadline — see
    // Session.prototype.onSlotFreed and the 'error' handler in onEvent.
    slotWaitStartedAt: null,
    // Stall clock — see Session.prototype.startStallClock. `solo` is here
    // because the transcription handler reads it to decide `answering`, and
    // that verdict is what disarms the clock for an unaddressed utterance.
    solo: false,
    // The bot-side half of text-only. Default FALSE, matching the constructor:
    // a failed probe must leave the filler behaving as it did before the mode
    // existed rather than silently muting it everywhere.
    speechOff: false,
    stallStartedAt: null,
    stallTimer: null,
    stallDetected: false,
    // Playback surface speakStallClip() drives. The player is a stub because
    // these tests are about what gets queued, not about Discord's player.
    outQueue: Buffer.alloc(0),
    outTick: null,
    ending: false,
    player: { play: () => {}, stop: () => {} },
    ...overrides,
  });
}

// reportStall's entire output is a log line, so asserting on it means reading
// that line. voice.js holds the same module object this returns, so patching
// the property here is what its `log.info` call resolves to — no seam needed.
function captureInfo(fn) {
  const log = require('../src/log');
  const real = log.info;
  const lines = [];
  log.info = (msg, fields) => lines.push({ msg, fields });
  try {
    fn();
  } finally {
    log.info = real;
  }
  return lines;
}

// An armed-but-not-fired timer. unref'd so a failing assertion that skips the
// cleanup cannot leave node:test holding the process open for a minute.
function armedTimer() {
  const t = setTimeout(() => {}, 60000);
  t.unref();
  return t;
}

test('onEvent sets inResponse on response.created, for any trigger', () => {
  const fake = fakeOnEventTarget();
  Session.prototype.onEvent.call(fake, JSON.stringify({ type: 'response.created' }));
  assert.equal(fake.inResponse, true);
});

test('onEvent clears inResponse and typedReplyPending on response.done', () => {
  const fake = fakeOnEventTarget({ inResponse: true, typedReplyPending: true });
  Session.prototype.onEvent.call(fake, JSON.stringify({ type: 'response.done' }));
  assert.equal(fake.inResponse, false);
  assert.equal(fake.typedReplyPending, false);
});

// The stall clock — SC1's measurement. `speech_stopped` is the only event that
// can start it on a mic turn: `response.created` is suppressed on that path
// (see `answering` in the constructor) and `speech_started` fires while the
// user is still mid-sentence.
test('onEvent arms the stall clock on speech_stopped', () => {
  const fake = fakeOnEventTarget();
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }),
  );
  assert.notEqual(
    fake.stallStartedAt,
    null,
    'speech_stopped is the earliest signal the bot gets that an answer is owed',
  );
  assert.notEqual(fake.stallTimer, null);
  Session.prototype.clearStallClock.call(fake); // never leave a live 8s timer behind
  assert.equal(fake.stallTimer, null);
});

test('an unaddressed utterance disarms the stall clock, because silence is not a wait', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now(), stallTimer: armedTimer() });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'did you see the game last night',
    }),
  );
  assert.equal(fake.answering, false);
  assert.equal(fake.stallStartedAt, null);
  assert.equal(
    fake.stallTimer,
    null,
    'the timer must be cleared, not left to fire on a turn nobody is waiting for',
  );
});

test('an addressed utterance leaves the stall clock running', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now(), stallTimer: armedTimer() });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hey bot, what is the disk usage',
    }),
  );
  assert.equal(fake.answering, true);
  assert.notEqual(fake.stallStartedAt, null, 'an answer is coming, so the wait is still measured');
  Session.prototype.clearStallClock.call(fake);
});

test('reportStall logs the utterance-to-audio gap and clears the clock', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 12345 });
  const lines = captureInfo(() => Session.prototype.reportStall.call(fake));
  const line = lines.find((l) => l.msg.includes('start-to-audio'));
  assert.ok(line, 'expected a start-to-audio line');
  assert.ok(
    line.fields.gapMs >= 12345,
    `gapMs ${line.fields.gapMs} must be at least the 12345ms already elapsed`,
  );
  assert.equal(line.fields.detected, false, 'a fast turn is measured but not a stall');
  assert.equal(
    fake.stallStartedAt,
    null,
    'cleared so the next turn measures from its own utterance, not this one',
  );
});

test('reportStall reports detected once the threshold timer has fired', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 9000, stallDetected: true });
  const lines = captureInfo(() => Session.prototype.reportStall.call(fake));
  const line = lines.find((l) => l.msg.includes('start-to-audio'));
  assert.equal(line.fields.detected, true);
});

test('reportStall logs nothing when no utterance armed the clock', () => {
  const fake = fakeOnEventTarget();
  const lines = captureInfo(() => Session.prototype.reportStall.call(fake));
  assert.deepEqual(lines, [], 'a typed turn must not produce a mic-turn measurement');
});

// The filler itself. It has to start the pump on its own — at stall time no
// real audio has arrived, so nothing else has created the stream yet.
test('speakStallClip starts the pump with the clip queued for it', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100 });
  Session.prototype.speakStallClip.call(fake);
  assert.notEqual(fake.audio, null, 'the clip needs a live stream, since no real audio exists yet');
  assert.equal(fake.speaking, true, 'the ring must be lit, and barge-in must be able to cut it');
  assert.ok(fake.outQueue.length > 0, 'the clip PCM must be queued for the pump');
  Session.prototype.stopAudio.call(fake); // clears outTick — never leave a live interval
  assert.equal(fake.outTick, null);
});

test('speakStallClip is a no-op once playback is already live', () => {
  const fake = fakeOnEventTarget({
    stallStartedAt: Date.now() - 8100,
    audio: { end: () => {} }, // the answer is already playing
    outQueue: Buffer.alloc(0),
  });
  Session.prototype.speakStallClip.call(fake);
  assert.equal(
    fake.outQueue.length,
    0,
    'a live answer must not have a filler spliced in front of it',
  );
});

// The clip bypasses the TTS path, so nothing else writes it down. The shim's
// `_PROGRESS_LINES` fillers ride `on_text` into `response.output_audio_
// transcript.done` and land in the record that way; without this the stall
// filler would be the one thing said in a call that the transcript omits.
test('speakStallClip records the filler in the transcript, under the assistant label', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100 });
  Session.prototype.speakStallClip.call(fake);
  const written = fake._transcriptWrites.filter((w) => w.text.includes('getting the audio ready'));
  assert.equal(written.length, 1, 'the clip is spoken, so the record must show it');
  assert.equal(
    written[0].speaker,
    config.assistantLabel,
    'the listener heard the assistant say it',
  );
  Session.prototype.stopAudio.call(fake);
});

test('speakStallClip writes no transcript line when playback never starts', () => {
  const fake = fakeOnEventTarget({
    stallStartedAt: Date.now() - 8100,
    audio: { end: () => {} }, // an answer is already playing
  });
  Session.prototype.speakStallClip.call(fake);
  assert.deepEqual(
    fake._transcriptWrites,
    [],
    'nothing was said, so nothing may be recorded as said',
  );
});

// text-only, bot side. The shim will never send audio in this mode, so the
// stall is not a slow turn — it is the mode working — and the clip would be the
// ONE sound of a call that asked for none. It also lands AFTER the answer has
// been posted to the channel, so the listener hears a filler for a reply they
// have already read. Observed live 2026-09-11: chat post at 15:38:22, clip at
// 15:38:26, 8002ms after speech stopped.
test('speakStallClip stays silent in text-only mode', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100, speechOff: true });
  let played = false;
  fake.player = {
    play: () => {
      played = true;
    },
    stop: () => {},
  };
  Session.prototype.speakStallClip.call(fake);
  assert.equal(fake.outQueue.length, 0, 'no clip may be queued');
  assert.equal(fake.audio, null, 'no pump may be opened — that is what lights the ring');
  assert.equal(played, false, 'the player must not be started');
});

test('speakStallClip still plays when speech is on', () => {
  // The positive control. A guard that muted the filler in every mode would
  // pass the test above and break the feature it exists for.
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100, speechOff: false });
  Session.prototype.speakStallClip.call(fake);
  assert.ok(fake.outQueue.length > 0, 'the clip must still be queued in the speaking modes');
  Session.prototype.stopAudio.call(fake); // never leave a live interval behind
});

test('startStallClock refreshes the speech posture from the shim', async () => {
  // Re-read per utterance rather than tracked locally: /mode is set out of
  // band, so a local copy would drift the moment the shim restarted. The probe
  // rides the 8s wait the clock is starting, so it costs the turn nothing.
  const llm = require('../src/llm');
  const realState = llm.getVoiceState;
  const realKeyFor = llm.voiceKeyFor;
  llm.voiceKeyFor = () => 'voice:G1';
  llm.getVoiceState = async () => ({ ok: true, speech: false });
  try {
    const fake = fakeOnEventTarget({ guildId: 'G1' });
    Session.prototype.startStallClock.call(fake);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.speechOff, true, 'the shim said text-only, so the bot must know');
    Session.prototype.clearStallClock.call(fake);
  } finally {
    llm.getVoiceState = realState;
    llm.voiceKeyFor = realKeyFor;
  }
});

test('a failed speech probe leaves the filler speaking, not muted', async () => {
  // Fail-open, and deliberately: the default (speech on) is the absence of an
  // override, so an unreachable shim must not silently disable the filler in
  // every mode. The cost of being wrong is a filler in a text-only call during
  // a shim outage; the cost the other way is a broken feature everywhere.
  const llm = require('../src/llm');
  const realState = llm.getVoiceState;
  const realKeyFor = llm.voiceKeyFor;
  llm.voiceKeyFor = () => 'voice:G1';
  llm.getVoiceState = async () => ({ ok: false, error: 'endpoint 500' });
  try {
    const fake = fakeOnEventTarget({ guildId: 'G1', speechOff: true });
    Session.prototype.startStallClock.call(fake);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.speechOff, false, 'an unreadable posture must not mute the filler');
    Session.prototype.clearStallClock.call(fake);
  } finally {
    llm.getVoiceState = realState;
    llm.voiceKeyFor = realKeyFor;
  }
});

test('the stall log carries the speech posture, so a text-only crossing reads as expected', () => {
  // "stall — no audio yet" fires on every text-only turn, where it is the mode
  // working rather than a fault. The flag is what separates the two readings
  // without suppressing the one line that shows a turn produced no speech.
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100, speechOff: true });
  const lines = captureInfo(() => Session.prototype.onStallThreshold.call(fake));
  const stall = lines.find((l) => l.msg.includes('stall — no audio yet'));
  assert.ok(stall, 'the crossing is still reported');
  assert.equal(stall.fields.speechOff, true);
});

// The stall gate has TWO halves, and this pair is why: the threshold alone is
// not enough to know an answer is owed. The addressing verdict arrives with the
// transcription, which on a stalled turn lands after the threshold fires — the
// STT stage is the largest component of the wait (11.34s of a 25.6s turn).
test('crossing the threshold records the stall but stays silent while the verdict is unknown', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100, answering: false });
  Session.prototype.onStallThreshold.call(fake);
  assert.equal(fake.stallDetected, true, 'the stall is still recorded and logged');
  assert.equal(fake.audio, null, 'nothing may be spoken before the bot knows an answer is owed');
});

test('crossing the threshold narrates when an answer is already known to be owed', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 8100, answering: true });
  Session.prototype.onStallThreshold.call(fake);
  assert.notEqual(fake.audio, null);
  Session.prototype.stopAudio.call(fake);
});

test('a wait already past the threshold is narrated once the verdict lands as addressed', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 12000, stallDetected: true });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'hey bot, what is the disk usage',
    }),
  );
  assert.notEqual(fake.audio, null, 'late is better than never — the wait is still running');
  Session.prototype.stopAudio.call(fake);
});

test('a wait already past the threshold stays silent when the verdict lands as unaddressed', () => {
  const fake = fakeOnEventTarget({ stallStartedAt: Date.now() - 12000, stallDetected: true });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'did you see the game last night',
    }),
  );
  assert.equal(fake.audio, null, 'no answer is coming, so nothing may promise one');
});

// Regression guard for the ordering inside pushAudio: the clip makes
// `this.audio` non-null BEFORE any real audio arrives, so a guard-first
// ordering silently drops the measurement on exactly the stalled turns it
// exists to record.
test('pushAudio still reports the gap when the stall clip already started the pump', () => {
  const fake = fakeOnEventTarget({
    stallStartedAt: Date.now() - 12000,
    stallDetected: true,
    audio: { write: () => {} }, // the clip owns the stream
    outQueue: Buffer.alloc(0),
  });
  const lines = captureInfo(() => Session.prototype.pushAudio.call(fake, Buffer.alloc(320)));
  const line = lines.find((l) => l.msg.includes('start-to-audio'));
  assert.ok(line, 'the measurement must survive the clip having started playback');
  assert.ok(line.fields.gapMs >= 12000, `gapMs ${line.fields.gapMs} must be at least 12000`);
  assert.equal(line.fields.detected, true);
});

test('onEvent marks a typed-triggered reply distinctly in the transcript', () => {
  const fake = fakeOnEventTarget({ typedReplyPending: true });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'response.output_audio_transcript.done',
      transcript: 'here is your answer',
    }),
  );
  assert.deepEqual(fake._transcriptWrites, [
    { speaker: config.assistantLabel, text: '(typed→spoken) here is your answer' },
  ]);
  assert.equal(fake.typedReplyPending, false, 'consumed once written');
});

test('onEvent marks an ordinary spoken reply with no typed marker', () => {
  const fake = fakeOnEventTarget({ typedReplyPending: false });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'hello there' }),
  );
  assert.deepEqual(fake._transcriptWrites, [
    { speaker: config.assistantLabel, text: 'hello there' },
  ]);
});

test('postToChannel chunks long text across multiple sends', async () => {
  const session = fakeSession();
  voice.sessions.set('guild-1', session);
  const long = 'x'.repeat(2500);

  const result = await voice.postToChannel(long);

  assert.deepEqual(result, { posted: true, channel: session.channelId });
  assert.ok(
    session._sent.length >= 2,
    'a 2500-char message must span more than one Discord message',
  );
  assert.equal(session._sent.join(''), long);
});

test('barge-in obeys the interrupt switch, not just the server side', () => {
  // Two interrupt paths exist: the server cancels generation, the bot destroys
  // playback. Gating only the server left an acknowledgement still cutting the
  // assistant off mid-sentence, with the switch reading "off".
  const stopped = [];
  const fake = fakeOnEventTarget({
    speaking: true,
    stopAudio: () => stopped.push('stopped'),
  });

  const saved = config.interruptResponse;
  try {
    config.interruptResponse = false;
    Session.prototype.onEvent.call(
      fake,
      JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
    );
    assert.deepEqual(stopped, [], 'switch off: speaking over it must not kill playback');

    config.interruptResponse = true;
    Session.prototype.onEvent.call(
      fake,
      JSON.stringify({ type: 'input_audio_buffer.speech_started' }),
    );
    assert.deepEqual(stopped, ['stopped'], 'switch on: barge-in still works');
  } finally {
    config.interruptResponse = saved;
  }
});

test('a wake phrase preceded by hesitation still counts', () => {
  // Three real failures from one call. Requiring the phrase at the literal
  // sentence start made the feature unusable in ordinary speech while passing
  // every test written from imagined utterances.
  assert.equal(
    config.isAddressed('Hello. How are you? Uh hey bot, can you check my free disk space?'),
    true,
  );
  assert.equal(config.isAddressed('Uh hey hey bot, did you hear me?'), true);
  assert.equal(config.isAddressed("Okay, um, hey bot, what's my task?"), true);
  // Only NOISE may precede it — a real word still does not count.
  assert.equal(config.isAddressed("So, hey bot, what's my task"), false);
  assert.equal(config.isAddressed('Oh hey.'), false);
});

test('a turn that produces nothing does not leave the indicator stuck', () => {
  // Observed live at 12:39: an addressed turn died with "listener gone", so no
  // response.done arrived and `answering` stayed true — dots to the cap, and
  // speak() refusing typed turns as busy for the same period.
  const fake = fakeOnEventTarget({
    channel: { sendTyping: async () => {} },
    typingTimer: null,
    closed: false,
    showTyping: Session.prototype.showTyping,
  });
  const utter = (t) =>
    Session.prototype.onEvent.call(
      fake,
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        transcript: t,
      }),
    );

  utter('hey bot, check my tasks');
  assert.equal(fake.answering, true);

  // The turn dies silently — no response.done. The NEXT utterance is what ends
  // the stuck state, so the bound is "until you speak again", not the cap.
  utter('so anyway, as I was saying to you');
  assert.equal(fake.answering, false, 'a later utterance must clear a stranded flag');

  clearInterval(fake.typingTimer);
});

test('hi bot is accepted — the mishearing that blocked a real question', () => {
  assert.equal(
    config.isAddressed('…Ghost MK2 spaceship. Ah hi bot. Can you check for a task?'),
    true,
  );
  // Still not a free-for-all: a different word after "hi" is not a wake phrase.
  assert.equal(config.isAddressed('hi Bob, did you see this'), false);
});

test('ooh is a hesitation too — the ninth attempt in the reliability run', () => {
  // 'oh' was on the list, 'ooh' was not: one letter, and the gate declined a
  // real question. Third variant found the same way (hey bought, hi bot, ooh)
  // — every miss this feature has had is a transcription spelling, never logic.
  assert.equal(config.isAddressed('Ooh, hey bot, how many tasks do I have in progress?'), true);
  assert.equal(config.isAddressed('Oh hey bot, how many tasks do we have in progress?'), true);
  // Unchanged: only noise may precede the phrase.
  assert.equal(config.isAddressed("So, hey bot, what's my task"), false);
});

test('an s2s error is reported on both surfaces, not just logged', async () => {
  const sent = [];
  const fake = fakeOnEventTarget({
    channel: { send: async (t) => sent.push(t) },
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'error',
      error: { type: 'response_failed', message: 'Language model generation failed: boom' },
    }),
  );
  await new Promise((r) => setImmediate(r));

  // From inside Discord a failed answer and an ignored utterance are the same
  // event — silence. Both surfaces must carry the reason.
  assert.equal(fake._transcriptWrites.length, 1);
  assert.match(fake._transcriptWrites[0].text, /^\(voice reply failed: Language model/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Could not answer that out loud/);
});

test('an s2s error clears the flags no response.done will clear', async () => {
  const fake = fakeOnEventTarget({
    channel: { send: async () => {} },
    answering: true,
    inResponse: true,
    typedReplyPending: true,
  });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'error', error: { type: 'response_failed', message: 'boom' } }),
  );

  // A turn failing before any assistant text emits no response.done, so these
  // would stay raised and wedge every later speak() as permanently busy —
  // observed on 2026-08-11 as a typed turn refused with reason `busy` while
  // nothing was in flight.
  assert.equal(fake.answering, false);
  assert.equal(fake.inResponse, false);
  assert.equal(fake.typedReplyPending, false);
});

test('a multi-line server error is compacted to one readable line', async () => {
  const sent = [];
  const fake = fakeOnEventTarget({ channel: { send: async (t) => sent.push(t) } });

  // Verbatim shape of the NLTK LookupError that caused the 30h silent outage:
  // a banner line, the reason, then a bulleted list of searched paths.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'error',
      error: {
        type: 'response_failed',
        message:
          '\n**********************************************************************\n' +
          "  Resource 'punkt_tab' not found.\n  Please use the NLTK Downloader:\n" +
          "  Searched in:\n    - '/Users/x/nltk_data'\n",
      },
    }),
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /\n/, 'a chat notice must stay one line');
  assert.match(sent[0], /punkt_tab' not found/);
});

test('a busy refusal does not cut off the answer already being spoken', async () => {
  const sent = [];
  let endAudioCalls = 0;
  const fake = fakeOnEventTarget({
    channel: { send: async (t) => sent.push(t) },
    endAudio: () => {
      endAudioCalls += 1;
    },
    answering: true,
    inResponse: true,
  });

  // conversation_already_has_active_response arrives BY DEFINITION while a
  // response is in flight. Treating it as a dead turn would clear the flags and
  // stop playback mid-answer -- and text.js already reports it for typed turns,
  // so handling it here would also double-post.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'error',
      error: { type: 'conversation_already_has_active_response', message: 'busy' },
    }),
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(fake.answering, true, 'an in-flight answer must survive a busy refusal');
  assert.equal(fake.inResponse, true);
  assert.equal(endAudioCalls, 0, 'playback must not be stopped');
  assert.equal(sent.length, 0, 'text.js already reports this one');
  assert.equal(fake._transcriptWrites.length, 0);
});

function slotInUseErrorJson() {
  // speech-to-speech has exactly one session slot machine-wide — this is the
  // error text it sends when another process already holds it.
  return JSON.stringify({
    type: 'error',
    error: {
      type: 'server_error',
      message: 'session slots are in use, disconnect an existing client',
    },
  });
}

test('the FIRST slot-in-use refusal waits instead of leaving immediately', async () => {
  const sent = [];
  const guildId = 'guild-slot-wait';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
  });

  // v0.19.0 left on the FIRST refusal — a race against its own handover, which
  // asks the previous holder to yield before this bot even tries to connect.
  // The first refusal can arrive while that yield is still in flight.
  Session.prototype.onEvent.call(fake, slotInUseErrorJson());
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, false, 'must not leave on the first refusal');
  assert.equal(voice.sessions.has(guildId), true);
  assert.equal(sent.length, 0, 'no channel notice while still within the retry window');
  assert.equal(fake._transcriptWrites.length, 0);
  assert.ok(fake.slotWaitStartedAt, 'wait state must be recorded');
});

test('a slot-in-use refusal within the deadline keeps waiting on later attempts too', async () => {
  const sent = [];
  const guildId = 'guild-slot-still-waiting';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  // Started 3s ago — well inside the 10s default deadline, mirroring the 2s
  // retry cadence's second or third attempt.
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
    slotWaitStartedAt: Date.now() - 3000,
  });

  Session.prototype.onEvent.call(fake, slotInUseErrorJson());
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, false);
  assert.equal(voice.sessions.has(guildId), true);
  assert.equal(sent.length, 0, 'still no channel notice — a successful handover must be silent');
  assert.equal(fake._transcriptWrites.length, 0);
});

test('a slot-in-use refusal past the deadline leaves loudly, exactly as before', async () => {
  const sent = [];
  const guildId = 'guild-slot-deadline-expired';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  // Started well before the 10s default deadline.
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
    slotWaitStartedAt: Date.now() - (config.voiceSlotRetryDeadlineMs + 1000),
  });

  Session.prototype.onEvent.call(fake, slotInUseErrorJson());
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, true, 'the session must be left once the deadline passes');
  assert.equal(voice.sessions.has(guildId), false);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /already in use/i);
  assert.equal(fake._transcriptWrites.length, 1);
  assert.match(fake._transcriptWrites[0].text, /slot in use elsewhere/);
});

test('the retry deadline is configurable', () => {
  const original = process.env.VOICE_SLOT_RETRY_DEADLINE_MS;
  try {
    process.env.VOICE_SLOT_RETRY_DEADLINE_MS = '2500';
    delete require.cache[require.resolve('../src/config')];
    const freshConfig = require('../src/config');
    assert.equal(freshConfig.voiceSlotRetryDeadlineMs, 2500);
  } finally {
    if (original === undefined) delete process.env.VOICE_SLOT_RETRY_DEADLINE_MS;
    else process.env.VOICE_SLOT_RETRY_DEADLINE_MS = original;
    delete require.cache[require.resolve('../src/config')];
    require('../src/config');
  }
});

test('onSlotFreed logs recovery and clears the wait state, once the slot frees', () => {
  const fake = fakeOnEventTarget({ slotWaitStartedAt: Date.now() - 4000 });
  Session.prototype.onSlotFreed.call(fake);
  assert.equal(fake.slotWaitStartedAt, null);
});

test('onSlotFreed is a no-op when nothing was being waited on', () => {
  const fake = fakeOnEventTarget({ slotWaitStartedAt: null });
  // Must not throw computing Date.now() - null in some unexpected way, and
  // must leave the (already-null) state alone.
  Session.prototype.onSlotFreed.call(fake);
  assert.equal(fake.slotWaitStartedAt, null);
});

test('the handover is claimed on session.created, the server acceptance, not WS open', () => {
  // WS open precedes BOTH outcomes — the router may still reject with
  // session_limit_reached, which sends no session.created. So the "handover
  // completed" claim (onSlotFreed) belongs to session.created, and a wait
  // state set by a prior rejection must be cleared there, not in the open
  // handler. This is the honesty fix for the 2026-08-22 secondary defect.
  const fake = fakeOnEventTarget({
    slotWaitStartedAt: Date.now() - 4000,
    onSlotFreed: Session.prototype.onSlotFreed,
  });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'session.created', session: { id: 'sess-1' } }),
  );
  assert.equal(fake.slotWaitStartedAt, null, 'acceptance clears the wait state');
});

test('session.created is a no-op when nothing was being waited on', () => {
  const fake = fakeOnEventTarget({
    slotWaitStartedAt: null,
    onSlotFreed: Session.prototype.onSlotFreed,
  });
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'session.created', session: { id: 'sess-2' } }),
  );
  assert.equal(fake.slotWaitStartedAt, null, 'already-clear state stays clear');
});

// A minimal session the noteVoiceState idle-release path needs: channelId for
// the "here" anchor, `channel` for the fire-time humansIn re-check, the real
// schedule/cancel methods, a destroy() that records, and (optionally) a
// transcript whose writes are captured. voiceStateUpdate-shaped objects carry
// the same `guild` with a channel cache resolving to `channel`.
function fakeNvsSession({ channel, transcript, guildId = 'guild-nvs' }) {
  return {
    guildId,
    channelId: 'chan-A',
    channel,
    closed: false,
    idleReleaseTimer: null,
    scheduleIdleRelease: Session.prototype.scheduleIdleRelease,
    cancelIdleRelease: Session.prototype.cancelIdleRelease,
    names: new Map(),
    ...(transcript ? { transcript } : {}),
    destroy: () => {},
  };
}

function voiceStatePair({ channel, member = { id: 'u1', displayName: 'Uno' } }) {
  const guild = { id: 'guild-nvs', channels: { cache: { get: () => channel } } };
  return {
    old: { guildId: guild.id, guild, channelId: 'chan-A', member },
    next: { guildId: guild.id, guild, channelId: null, member },
  };
}

test('noteVoiceState schedules (not takes) the idle release when the last human leaves', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  const writes = [];
  const session = fakeNvsSession({
    channel,
    transcript: { writeText: (speaker, text) => writes.push({ speaker, text }) },
  });
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);

  assert.ok(
    session.idleReleaseTimer,
    'a brief absence must not tear the session down — a grace timer is armed instead',
  );
  assert.equal(voice.sessions.has(guildId), true, 'session stays in the map during the grace');
  assert.deepEqual(
    writes,
    [{ speaker: 'Uno', text: '(left the channel)' }],
    'the departing member is still written while the session exists',
  );
});

test('noteVoiceState schedules the idle release with transcription off too', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  const session = fakeNvsSession({ channel }); // no transcript — transcription off
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);

  assert.ok(session.idleReleaseTimer, 'grace must hold for calls with transcription off');
  assert.equal(voice.sessions.has(guildId), true);
});

test('the idle grace timer releases the session when it fires and the channel is still empty', async () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  let destroyed = false;
  const session = fakeNvsSession({ channel });
  session.destroy = () => (destroyed = true);
  voice.sessions.set(guildId, session);

  const original = config.voiceIdleReleaseMs;
  config.voiceIdleReleaseMs = 20;
  try {
    const { old, next } = voiceStatePair({ channel });
    voice.noteVoiceState(old, next);
    assert.ok(session.idleReleaseTimer, 'timer armed on empty');
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    config.voiceIdleReleaseMs = original;
  }

  assert.equal(destroyed, true, 'release fires after the grace window');
  assert.equal(voice.sessions.has(guildId), false);
});

test('a rejoining human cancels the scheduled idle release', async () => {
  const guildId = 'guild-nvs';
  const emptyChannel = { members: fakeMembers([]) };
  const filledChannel = { members: fakeMembers([{ user: { bot: false } }]) };
  let destroyed = false;
  const session = fakeNvsSession({ channel: emptyChannel });
  session.destroy = () => (destroyed = true);
  voice.sessions.set(guildId, session);

  const original = config.voiceIdleReleaseMs;
  config.voiceIdleReleaseMs = 20;
  try {
    const { old, next } = voiceStatePair({ channel: emptyChannel });
    voice.noteVoiceState(old, next); // last human leaves -> armed
    assert.ok(session.idleReleaseTimer, 'timer armed on empty');
    // Someone rejoins before the grace elapses.
    const pair2 = voiceStatePair({ channel: filledChannel });
    voice.noteVoiceState({ ...pair2.next, channelId: null }, { ...pair2.old, channelId: 'chan-A' });
    assert.equal(session.idleReleaseTimer, null, 'rejoin cancels the timer');
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    config.voiceIdleReleaseMs = original;
  }

  assert.equal(destroyed, false, 'the session survives once someone is back');
  assert.equal(voice.sessions.has(guildId), true);
});

test('noteVoiceState keeps the session while other humans remain', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([{ user: { bot: false } }]) };
  const session = fakeNvsSession({ channel });
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);

  assert.equal(session.idleReleaseTimer, null, 'a departing member is not the last human');
  assert.equal(voice.sessions.has(guildId), true);
});

test('cancelIdleRelease clears a pending grace timer (what destroy calls)', () => {
  const guildId = 'guild-nvs';
  const channel = { members: fakeMembers([]) };
  const session = fakeNvsSession({ channel });
  voice.sessions.set(guildId, session);
  const { old, next } = voiceStatePair({ channel });
  voice.noteVoiceState(old, next);
  assert.ok(session.idleReleaseTimer, 'armed by the empty departure');

  session.cancelIdleRelease();
  assert.equal(session.idleReleaseTimer, null, 'cleared');
});

test('a non-slot s2s error still follows its existing path unchanged', async () => {
  const sent = [];
  const guildId = 'guild-non-slot-error';
  let destroyed = false;
  voice.sessions.set(guildId, { destroy: () => (destroyed = true) });
  const fake = fakeOnEventTarget({
    guildId,
    channel: { send: async (t) => sent.push(t) },
    answering: true,
    inResponse: true,
  });

  // A generic server error unrelated to the slot must never trip the
  // slot-in-use wait/leave machinery.
  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({ type: 'error', error: { type: 'server_error', message: 'boom, unrelated' } }),
  );
  await new Promise((r) => setImmediate(r));

  assert.equal(destroyed, false);
  assert.equal(voice.sessions.has(guildId), true);
  assert.equal(sent.length, 0);
  assert.equal(fake._transcriptWrites.length, 0);
  assert.equal(fake.slotWaitStartedAt, null);
});

// A Collection-like stand-in: `.filter` returning something with `.size` is the
// whole contract humansIn depends on, so a Map-backed fake is enough.
function fakeMembers(users) {
  return {
    filter: (fn) => ({ size: users.filter(fn).length }),
  };
}

test('humansIn does not count the assistant itself', () => {
  // The bot is a member of the channel it listens to, so counting naively makes
  // "alone" unreachable — the case this whole feature turns on.
  const channel = {
    members: fakeMembers([{ user: { bot: false } }, { user: { bot: true } }]),
  };
  assert.equal(voice.humansIn(channel), 1);
});

test('humansIn returns null for an unreadable channel, not zero', () => {
  // null and 0 must not collapse: an unreadable room leaves the gate where it
  // is, while zero would read as "nobody here" and is a different claim.
  assert.equal(voice.humansIn(undefined), null);
  assert.equal(voice.humansIn({}), null);
  assert.equal(voice.humansIn({ members: {} }), null);
});

test('humansIn counts a second person, which is what re-arms the gate', () => {
  const channel = {
    members: fakeMembers([
      { user: { bot: false } },
      { user: { bot: false } },
      { user: { bot: true } },
    ]),
  };
  assert.equal(voice.humansIn(channel), 2);
});

test('solo raises the typing indicator for an unaddressed utterance', () => {
  let typing = 0;
  const fake = fakeOnEventTarget({ solo: true, showTyping: () => (typing += 1) });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'so what does that leave for tomorrow',
    }),
  );

  // The shim answers this turn when solo, so the bot must raise the dots for it
  // — a drift between the two sides shows up exactly here.
  assert.equal(fake.answering, true);
  assert.equal(typing, 1);
});

test('not solo still requires the phrase on the bot side', () => {
  let typing = 0;
  const fake = fakeOnEventTarget({ solo: false, showTyping: () => (typing += 1) });

  Session.prototype.onEvent.call(
    fake,
    JSON.stringify({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'so what does that leave for tomorrow',
    }),
  );

  assert.equal(fake.answering, false);
  assert.equal(typing, 0, 'no dots for a turn the shim will not answer');
});

test('the typed-turn hint is keyed per guild, matching the turn it describes', async () => {
  // THE REGRESSION. v0.10.0 keyed voice as `voice:<guildId>` but this call kept
  // sending DEFAULT_SESSION_KEY, so the shim wrote the hint to `default` and
  // read it from `voice:<guildId>`. It never matched, `typed_turn` stayed false,
  // and every typed message in a live call was judged by the WAKE PHRASE as if
  // spoken — anything not opening with "hey bot" dropped as unaddressed, with
  // no error and no log line beyond QUIET.
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-9' };
  const pending = Session.prototype.speak.call(fake, 'what were we working on?');
  await flush();

  assert.deepEqual(typedTurnCalls, [{ key: 'voice:guild-9', typed: true }]);
  assert.notEqual(typedTurnCalls[0].key, llm.DEFAULT_SESSION_KEY);

  ws.emit('message', JSON.stringify({ type: 'response.created' }));
  await pending;
});

test('a failed typed turn retracts the hint on the same key it set', async () => {
  // A retraction on the wrong key leaves the hint standing, which marks the
  // next unrelated SPOKEN reply as typed-originated.
  const ws = fakeWs();
  const fake = { closed: false, ws, typedReplyPending: false, guildId: 'guild-9' };
  const pending = Session.prototype.speak.call(fake, 'this one dies');
  await flush();
  ws.emit(
    'message',
    JSON.stringify({ type: 'error', error: { type: 'conversation_already_has_active_response' } }),
  );
  assert.deepEqual(await pending, { ok: false, reason: 'busy' });

  assert.deepEqual(typedTurnCalls, [
    { key: 'voice:guild-9', typed: true },
    { key: 'voice:guild-9', typed: false },
  ]);
});

test('syncSolo POSTs even when the channel is unreadable, arming the gate', async () => {
  // THE 2026-08-18 FIX. Pre-fix this early-returned without POSTing when
  // humans===null (channel.members not readable at slash-command time), so the
  // shim kept whatever stale value a previous call had set. The Brogrammers
  // join inherited a private session's solo=True and answered unaddressed
  // speech. Post-fix the POST happens regardless, the shim's per-key entry
  // is explicitly set to not-solo, and the bot's local flag arms too.
  const fakeSession = { voiceKey: 'voice:G1', solo: false };
  await voice.syncSolo(fakeSession, { members: {} });
  assert.deepEqual(voiceSoloCalls, [{ solo: false, key: 'voice:G1' }]);
  assert.equal(fakeSession.solo, false, 'unreadable channel keeps the gate armed');
});

test('syncSolo carries the session key on the POST', async () => {
  // The shim keys solo state by the same identifier bindVoiceKey uses. If the
  // POST drops the key, the shim rejects with 400 — the test above covered
  // the bot-side obligation to always POST; this covers the value it carries.
  const fakeSession = { voiceKey: 'voice:G1:personal', solo: false };
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  assert.deepEqual(voiceSoloCalls, [{ solo: false, key: 'voice:G1:personal' }]);
});

test('syncSolo POSTs even when the new value matches session.solo', async () => {
  // Belt-and-braces against the cross-call leak. The old code skipped the
  // POST when nothing changed; today the POST always runs because a missed
  // POST is exactly the failure mode this whole change exists to prevent.
  // Two consecutive calls with the same value produce two POSTs.
  const fakeSession = { voiceKey: 'voice:G2', solo: false };
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  assert.equal(voiceSoloCalls.length, 2, 'unconditional POST every syncSolo');
  assert.ok(voiceSoloCalls.every((c) => c.key === 'voice:G2' && c.solo === false));
});

test('syncSolo flips session.solo on a real change', async () => {
  const fakeSession = { voiceKey: 'voice:G3', solo: false };
  await voice.syncSolo(fakeSession, makeChannel({ humans: 1 }));
  assert.equal(fakeSession.solo, true, 'alone flips local flag to true on POST success');
  await voice.syncSolo(fakeSession, makeChannel({ humans: 2 }));
  assert.equal(fakeSession.solo, false, 'second human re-arms the gate');
  assert.deepEqual(
    voiceSoloCalls.map((c) => c.solo),
    [true, false],
  );
});

test('syncSolo stays armed when VOICE_ALWAYS_WAKE forces it', async () => {
  // An instance that opted out must never tell the shim it is solo, even when
  // exactly one human is in the channel. Same direction as the unreadable
  // channel: the gate stays armed, so unaddressed speech is not answered.
  const prev = config.voiceAlwaysWake;
  config.voiceAlwaysWake = true;
  try {
    const fakeSession = { voiceKey: 'voice:G4', solo: false };
    await voice.syncSolo(fakeSession, makeChannel({ humans: 1 }));
    assert.equal(fakeSession.solo, false, 'flag forces the armed state locally');
    assert.deepEqual(voiceSoloCalls, [{ solo: false, key: 'voice:G4' }]);
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('syncSolo honours a runtime wake override in both directions', async () => {
  // The override replaces the env default for THIS call. Forcing it on an
  // instance whose default is off is the noisy-room case; relaxing it on one
  // whose default is on is the Star Citizen instance going solo for a session.
  const prev = config.voiceAlwaysWake;
  try {
    config.voiceAlwaysWake = false;
    const forced = { voiceKey: 'voice:G5', solo: false, wakeOverride: true };
    await voice.syncSolo(forced, makeChannel({ humans: 1 }));
    assert.equal(forced.solo, false, 'override on keeps the gate armed while alone');

    config.voiceAlwaysWake = true;
    const relaxed = { voiceKey: 'voice:G6', solo: false, wakeOverride: false };
    await voice.syncSolo(relaxed, makeChannel({ humans: 1 }));
    assert.equal(relaxed.solo, true, 'override off disarms despite the env default');
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('a null wake override falls back to the configured default', async () => {
  // The third state — what `/wakephrase auto` restores. A session that has never been
  // touched by the command must behave exactly as it did before the command existed.
  const prev = config.voiceAlwaysWake;
  try {
    config.voiceAlwaysWake = true;
    const session = { voiceKey: 'voice:G7', solo: false, wakeOverride: null };
    await voice.syncSolo(session, makeChannel({ humans: 1 }));
    assert.equal(session.solo, false, 'null defers to VOICE_ALWAYS_WAKE');
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('a relaxed override still cannot disarm the gate in a shared room', async () => {
  // Precedence: the override replaces only the always-wake term. Head-count is
  // untouched, so `/wakephrase off` never makes the bot answer unaddressed speech
  // while someone else is in the channel.
  const prev = config.voiceAlwaysWake;
  try {
    config.voiceAlwaysWake = true;
    const session = { voiceKey: 'voice:G8', solo: false, wakeOverride: false };
    await voice.syncSolo(session, makeChannel({ humans: 3 }));
    assert.equal(session.solo, false, 'three humans keep the gate armed');
  } finally {
    config.voiceAlwaysWake = prev;
  }
});

test('setWakeOverride adopts locally only when the shim accepts', async () => {
  // The admin command's core: POST the override FIRST, and only mirror it on
  // the session if the shim took it. A failed POST must leave both sides where
  // they were, never drift.
  const session = {
    voiceKey: 'voice:G4',
    solo: false,
    wakeOverride: null,
    channel: makeChannel({ humans: 1 }),
  };
  voice.sessions.set('G4', session);
  const res = await voice.setWakeOverride('G4', true);
  assert.equal(res.ok, true);
  assert.equal(session.wakeOverride, true, 'accepted by the shim, adopted locally');
  assert.deepEqual(voiceWakeCalls, [{ value: true, key: 'voice:G4' }]);
  // syncSolo re-ran under the new posture: still solo (one human) but armed.
  assert.equal(session.solo, false, 'override on keeps the gate armed while alone');
});

test('setWakeOverride does not adopt when the POST fails', async () => {
  // Fail closed, same contract as syncSolo: the shim still holds its old value,
  // so the bot must keep its old value too — an adopted-but-rejected override
  // is the drift that shows up as typing dots with no answer.
  const session = {
    voiceKey: 'voice:G5',
    solo: false,
    wakeOverride: null,
    channel: makeChannel({ humans: 1 }),
  };
  voice.sessions.set('G5', session);
  llm.setVoiceWake = async () => ({ ok: false, error: 'endpoint 500' });
  const res = await voice.setWakeOverride('G5', false);
  assert.equal(res.ok, false);
  assert.equal(session.wakeOverride, null, 'rejected by the shim, not adopted');
});

test('setWakeOverride refuses with no live call', async () => {
  // Bare /wakephrase outside a call must not invent a target.
  const res = await voice.setWakeOverride('G99', true);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no live call');
});

test('setWakeOverride treats an unsupported route as a no-op, not a failure to retry', async () => {
  // A shim without /voice/wake (404) has no override state at all — report
  // that as unsupported so the caller says "stays as it is" rather than
  // hammering a route that does not exist.
  const session = {
    voiceKey: 'voice:G6',
    solo: false,
    wakeOverride: null,
    channel: makeChannel({ humans: 1 }),
  };
  voice.sessions.set('G6', session);
  llm.setVoiceWake = async () => ({ ok: false, unsupported: true });
  const res = await voice.setWakeOverride('G6', true);
  assert.equal(res.ok, false);
  assert.equal(res.unsupported, true);
  assert.equal(session.wakeOverride, null, 'nothing adopted on 404');
});

test('syncSolo keeps session.solo armed when the POST fails', async () => {
  // The shim's per-key state did not get updated on a failed POST, so the bot
  // must mirror that — fail closed, never fail open. Same direction as a
  // 404 from /voice/solo: the gate stays armed until proven otherwise.
  const realStub = llm.setVoiceSolo;
  llm.setVoiceSolo = async () => ({ ok: false, error: 'endpoint 500' });
  try {
    const fakeSession = { voiceKey: 'voice:G4', solo: false };
    await voice.syncSolo(fakeSession, makeChannel({ humans: 1 }));
    assert.equal(fakeSession.solo, false, 'a failed POST keeps the gate armed');
  } finally {
    llm.setVoiceSolo = realStub;
  }
});

function makeChannel({ humans, bots = 0 }) {
  const users = [
    ...Array.from({ length: humans }, () => ({ user: { bot: false } })),
    ...Array.from({ length: bots }, () => ({ user: { bot: true } })),
  ];
  return { members: fakeMembers(users) };
}

test('setTranscribing(false) drops the transcript so nothing more is written', () => {
  // The /transcribe toggle's gate: with the session dropped, every existing
  // `if (this.transcript)` guard — segment writes, text writes, flush
  // scheduling — goes quiet. No separate flag to keep in sync.
  const session = Object.create(Session.prototype);
  session.guildName = 'TestGuild';
  session.channelName = 'TestChannel';
  session.transcript = { write: () => 'file', writeText: () => 'file' };
  session.setTranscribing(false);
  assert.equal(session.transcript, null);
});

test('setTranscribing(true) constructs a live transcript when none exists', () => {
  // Toggled on mid-call from a `TRANSCRIBE=0` join: the session starts with no
  // transcript (null), and /transcribe on must build one so writes resume.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-toggle-'));
  const originalDir = config.transcriptDir;
  config.transcriptDir = dir;
  try {
    const session = Object.create(Session.prototype);
    session.guildName = 'TestGuild';
    session.channelName = 'TestChannel';
    session.transcript = null;
    session.setTranscribing(true);
    assert.ok(session.transcript, 'on must construct a transcript session');
    // ~420ms of 48k stereo PCM — above the 400ms click/breath floor, so the
    // write must land on disk.
    const file = session.transcript.write('u1', 'Alice', Buffer.alloc(80000));
    assert.ok(file, 'a write while on must produce a segment');
    assert.ok(fs.existsSync(file), 'and the segment must exist on disk');
  } finally {
    config.transcriptDir = originalDir;
  }
});

test('setTranscribing toggling off and on keeps one transcript, not fragments', () => {
  // Toggled off then on again mid-call must resume in the SAME session (same
  // folder), so the transcript reads as one call rather than two sessions.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-toggle-'));
  const originalDir = config.transcriptDir;
  config.transcriptDir = dir;
  try {
    const session = Object.create(Session.prototype);
    session.guildName = 'TestGuild';
    session.channelName = 'TestChannel';
    session.transcript = null;
    session.setTranscribing(true);
    const first = session.transcript;
    session.setTranscribing(false);
    assert.equal(session.transcript, null);
    session.setTranscribing(true);
    assert.equal(session.transcript, first, 're-enable must reuse the same session');
  } finally {
    config.transcriptDir = originalDir;
  }
});

// --- leave-reason gating + auto-rejoin (2026-09-25) -------------------------
//
// The contract: the bot leaves a call only on /leave, an idle timeout, or a
// yield to another identity; every OTHER disconnect rejoins the same channel.
// Two halves are unit-testable — the reason bookkeeping (leave() records why,
// which is what lets the stateChange handler tell an intentional leave from a
// drop) and the backoff sequence. The trigger itself, a real Discord socket
// dropping, needs a live call: see CLAUDE.md's "Verifying Voice Changes".

/** A channel-shaped object good enough for scheduleRejoin's re-resolve. */
function fakeChannel(guildId = 'G1', id = 'chan-1') {
  return { id, guild: { id: guildId, channels: { cache: { get: () => undefined } } } };
}

test('leave() records the reason for every intentional path and drops the session', () => {
  for (const reason of ['command', 'idle', 'yield', 'slot-in-use', 'shutdown']) {
    const session = fakeSession({ guildId: 'G1' });
    let destroyed = false;
    session.destroy = () => {
      destroyed = true;
    };
    voice.sessions.set('G1', session);

    assert.equal(voice.leave('G1', reason), true);
    assert.equal(session.leaveReason, reason, `leave() must record ${reason}`);
    assert.equal(destroyed, true, `leave() must destroy the session for ${reason}`);
    assert.equal(voice.sessions.has('G1'), false, `the session must be gone after ${reason}`);
  }
});

test('a live session carries no leaveReason — that null is the rejoin trigger', () => {
  const session = fakeSession({ guildId: 'G1' });
  voice.sessions.set('G1', session);
  assert.equal(session.leaveReason, null);
});

test('rejoinDelayMs doubles from the base and stops at the cap', () => {
  const saved = { base: config.voiceRejoinBaseMs, cap: config.voiceRejoinMaxDelayMs };
  config.voiceRejoinBaseMs = 2000;
  config.voiceRejoinMaxDelayMs = 60000;
  try {
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => voice.rejoinDelayMs(n)),
      [2000, 4000, 8000, 16000, 32000],
    );
    // The cap is the guard against an unbounded wait if the attempt count is
    // ever raised past the point where doubling outruns it.
    assert.equal(voice.rejoinDelayMs(10), 60000);
  } finally {
    config.voiceRejoinBaseMs = saved.base;
    config.voiceRejoinMaxDelayMs = saved.cap;
  }
});

test('cancelRejoin ends an armed sequence', () => {
  voice.scheduleRejoin('G1', fakeChannel());
  assert.equal(voice.rejoins.get('G1').attempts, 1);
  voice.cancelRejoin('G1');
  assert.equal(voice.rejoins.has('G1'), false);
});

test('leave("pre-join") preserves the sequence — join() must not reset the counter', () => {
  voice.scheduleRejoin('G1', fakeChannel());
  voice.sessions.set('G1', fakeSession({ guildId: 'G1' }));
  try {
    voice.leave('G1', 'pre-join');
    // The counter survives, so a rejoin that keeps failing cannot loop forever
    // at attempt 1 — which is exactly why `pre-join` is exempt from
    // cancelRejoin.
    assert.equal(voice.rejoins.get('G1')?.attempts, 1);
  } finally {
    voice.cancelRejoin('G1');
  }
});

test('scheduleRejoin abandons loudly once the attempt budget is spent', () => {
  const savedMax = config.voiceRejoinMaxAttempts;
  config.voiceRejoinMaxAttempts = 2;
  try {
    const session = fakeSession({ guildId: 'G1' });
    voice.sessions.set('G1', session);

    // Advance the counter without waiting on real timers: clearing the timer
    // while keeping the counter is the exact state the next call observes.
    for (let i = 0; i < 2; i += 1) {
      voice.scheduleRejoin('G1', fakeChannel());
      const state = voice.rejoins.get('G1');
      clearTimeout(state.timer);
      state.timer = null;
    }
    assert.equal(voice.rejoins.get('G1').attempts, 2);

    voice.scheduleRejoin('G1', fakeChannel()); // 3 > budget → abandon
    assert.equal(voice.rejoins.has('G1'), false, 'the sequence must end');
    assert.equal(voice.sessions.has('G1'), false, 'the session must be released');
    assert.equal(session.leaveReason, 'rejoin-abandoned');
  } finally {
    config.voiceRejoinMaxAttempts = savedMax;
  }
});

test('a non-finite base delay falls back to the documented default', () => {
  const saved = config.voiceRejoinBaseMs;
  config.voiceRejoinBaseMs = NaN; // what `parseInt('abc', 10)` yields
  try {
    // Without the guard this is NaN, and `setTimeout(fn, NaN)` fires at once.
    assert.equal(voice.rejoinDelayMs(1), 2000);
  } finally {
    config.voiceRejoinBaseMs = saved;
  }
});

test('a non-finite attempt budget still abandons — NaN must not mean "retry forever"', () => {
  const savedMax = config.voiceRejoinMaxAttempts;
  config.voiceRejoinMaxAttempts = NaN;
  try {
    const session = fakeSession({ guildId: 'G1' });
    voice.sessions.set('G1', session);

    for (let i = 0; i < 5; i += 1) {
      voice.scheduleRejoin('G1', fakeChannel());
      const state = voice.rejoins.get('G1');
      clearTimeout(state.timer);
      state.timer = null;
    }
    assert.equal(voice.rejoins.get('G1').attempts, 5);

    // `attempts > NaN` is always false, so without the guard this call arms an
    // immediate retry instead of abandoning, and the loop never stops.
    voice.scheduleRejoin('G1', fakeChannel());
    assert.equal(voice.rejoins.has('G1'), false, 'NaN must fall back to the default budget');
    assert.equal(session.leaveReason, 'rejoin-abandoned');
  } finally {
    config.voiceRejoinMaxAttempts = savedMax;
  }
});
