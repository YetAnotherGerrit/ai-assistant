'use strict';

const test = require('node:test');
const assert = require('node:assert');

// `make precommit` sources local.env (Makefile `-include`), which sets
// IDENTITY. These key-shape tests assume a single-identity deployment, so the
// var has to go before config is first required — the per-test identity tests
// below delete it themselves, but the module-level requires here would
// otherwise capture `config.identity = 'personal'` and every `voice:G1`
// assertion would fail with a `:personal` suffix it never asked for.
delete process.env.IDENTITY;
delete require.cache[require.resolve('../src/config')];
delete require.cache[require.resolve('../src/llm')];
const { sessionKeyFor, DEFAULT_SESSION_KEY } = require('../src/llm');

const channel = (over) => ({ isThread: () => false, isVoiceBased: () => false, ...over });

test('a voice channel shares the spoken conversation, per guild', () => {
  // The one case with teeth: a voice channel's integrated text chat is an
  // ordinary text channel to Discord, so without this it gets its own session
  // and a link pasted mid-call never reaches the conversation being spoken.
  // It is also what lets `switch` / `new` reach voice at all.
  //
  // The guild id is load-bearing and this fixture used to omit it (`guild: {}`),
  // so the assertion held while the behaviour changed underneath it: the key
  // fell back to the default exactly because there was no id to key on.
  const key = sessionKeyFor(
    channel({ id: 'V1', guild: { id: 'G1' }, isVoiceBased: () => true }),
    'U9',
  );
  assert.equal(key, 'voice:G1');
});

test('two servers do not share one spoken conversation', () => {
  // The regression that motivated per-guild keys: joining a call at work
  // resumed the personal conversation, because ALL voice landed on one key.
  // speech-to-speech cannot send a session header, so nothing else separates
  // them.
  const inGuild = (id) =>
    sessionKeyFor(channel({ id: `V-${id}`, guild: { id }, isVoiceBased: () => true }), 'U9');
  assert.notEqual(inGuild('G1'), inGuild('G2'));
});

test('a voice channel with no resolvable guild still yields a usable key', () => {
  const key = sessionKeyFor(channel({ id: 'V1', guild: {}, isVoiceBased: () => true }), 'U9');
  assert.equal(key, DEFAULT_SESSION_KEY);
});

test('IDENTITY unset reproduces the v0.16.0 key exactly', () => {
  // No behaviour change for an existing single-identity deployment.
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { voiceKeyFor } = require('../src/llm');
  assert.equal(voiceKeyFor('G1'), 'voice:G1');
});

test('IDENTITY set adds a third segment to the voice key', () => {
  // THE AXIS FIX: persona (identity) and session (guild) are different
  // things, so the key has to carry both once an identity is set.
  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { voiceKeyFor } = require('../src/llm');
  assert.equal(voiceKeyFor('G1'), 'voice:G1:sc');
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('one identity across two guilds still separates sessions, sharing persona', () => {
  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { voiceKeyFor } = require('../src/llm');
  const inG1 = voiceKeyFor('G1');
  const inG2 = voiceKeyFor('G2');
  assert.notEqual(inG1, inG2, 'sessions must stay separate per guild');
  assert.ok(
    inG1.endsWith(':sc') && inG2.endsWith(':sc'),
    'persona must be the same identity in both',
  );
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('two identities in the same guild produce different session keys', () => {
  // THE LEAK THIS FIX EXISTS TO PREVENT: without the identity segment, two
  // bots serving the same guild would collide on one `voice:<guildId>` key.
  process.env.IDENTITY = 'personal';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const asPersonal = require('../src/llm').voiceKeyFor('G1');

  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const asSc = require('../src/llm').voiceKeyFor('G1');

  assert.notEqual(asPersonal, asSc);
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('threads, channels and DMs each get their own conversation', () => {
  assert.equal(
    sessionKeyFor(channel({ id: 'H1', guild: {}, isThread: () => true }), 'U9'),
    'thread:H1',
  );
  assert.equal(sessionKeyFor(channel({ id: 'T1', guild: {} }), 'U9'), 'channel:T1');
  assert.equal(sessionKeyFor(channel({ id: 'D1' }), 'U9'), 'dm:U9');
});

test('switch rejects free text without calling the endpoint', async () => {
  // A slash-command option accepts anything, so `/switch speech to speech`
  // reached the shim and came back as a filesystem path. The shape check has to
  // sit in front, and must not need a reachable endpoint to say so.
  const { switchSession } = require('../src/commands');
  const reply = await switchSession('k', 'speech to speech');
  assert.match(reply, /not a session id/);
});

test('every switch refusal reaches Discord without an absolute path', async () => {
  // The shim's refusals name their reason, which is what a reader needs — but
  // each also embeds a host path, and the three put it behind DIFFERENT
  // prepositions. Stripping only " in /…" left the newer refusals leaking
  // `/Users/…` into a Discord channel: the widened lookup says "under <dir>",
  // and a transcript with no recorded cwd says "at <file>".
  const { switchSession } = require('../src/commands');
  const realFetch = globalThis.fetch;
  const refusals = [
    'no transcript for abc in /Users/me/.claude/projects/-x',
    'no transcript for abc in any project directory under /Users/me/.claude/projects',
    'cannot resume abc: its transcript at /Users/me/.claude/projects/-x/abc.jsonl ' +
      'records no working directory, so the resume cwd is unknown',
  ];
  try {
    for (const message of refusals) {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message } }),
      });
      const reply = await switchSession('k', 'be8fae09-a97e-4c11-a659-cb36975016cc');
      assert.match(reply, /^Could not switch: /);
      assert.doesNotMatch(reply, /\/Users\//, `path leaked for: ${message}`);
      assert.doesNotMatch(reply, /\.claude/, `project dir leaked for: ${message}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a channel object missing the type helpers still yields a key', () => {
  // Partial channels are real: a DM arrives uncached, and an older discord.js
  // object may lack isVoiceBased. Optional calls must not throw.
  assert.equal(sessionKeyFor({ id: 'X1', guild: {} }, 'U9'), 'channel:X1');
  assert.equal(sessionKeyFor(undefined, 'U9'), 'dm:U9');
});

test('two transcript lines written in the same millisecond both survive', () => {
  // The name was `${Date.now()}-<speaker>-000000`, so two writes inside one
  // millisecond collided and the second overwrote the first — a line lost with
  // nothing logged. It is not a rare race: a holding line and the first
  // sentence of the answer arrive together.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { TranscriptSession } = require('../src/transcript');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'));
  const session = Object.create(TranscriptSession.prototype);
  session.segments = dir;

  session.writeText('Assistant', 'holding line');
  session.writeText('Assistant', 'the actual answer');

  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2, 'both writes must produce their own segment');
  assert.deepEqual(
    files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')),
    ['holding line', 'the actual answer'],
    'and stay in insertion order',
  );
  // The transcriber only picks up names matching this shape.
  for (const f of files) assert.match(f, /^\d+-.+-\d+\.txt$/);
});

test('IDENTITY unset reproduces existing thread/dm/channel keys exactly', () => {
  // No behaviour change for an existing single-identity deployment — same
  // guarantee `voiceKeyFor` already gives for voice.
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { sessionKeyFor } = require('../src/llm');
  assert.equal(
    sessionKeyFor(channel({ id: 'H1', guild: {}, isThread: () => true }), 'U9'),
    'thread:H1',
  );
  assert.equal(sessionKeyFor(channel({ id: 'T1', guild: {} }), 'U9'), 'channel:T1');
  assert.equal(sessionKeyFor(channel({ id: 'D1' }), 'U9'), 'dm:U9');
});

test('IDENTITY set adds a third segment to thread/dm/channel keys', () => {
  // THE GAP THIS PR CLOSES: a header was tried first and dropped — multiple
  // identities sharing one Discord guild produce the IDENTICAL
  // thread:/channel:/dm: key, so only the KEY (not a header) can separate
  // their sessions. This mirrors voiceKeyFor's `:<identity>` suffix.
  process.env.IDENTITY = 'sc';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const { sessionKeyFor } = require('../src/llm');
  try {
    assert.equal(
      sessionKeyFor(channel({ id: 'H1', guild: {}, isThread: () => true }), 'U9'),
      'thread:H1:sc',
    );
    assert.equal(sessionKeyFor(channel({ id: 'T1', guild: {} }), 'U9'), 'channel:T1:sc');
    assert.equal(sessionKeyFor(channel({ id: 'D1' }), 'U9'), 'dm:U9:sc');
  } finally {
    delete process.env.IDENTITY;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/llm')];
  }
});

test('two identities in the same channel produce different session keys', () => {
  // THE LEAK THIS FIX EXISTS TO PREVENT: three bots now share one guild in
  // production — without the identity segment, two of them typing in the
  // SAME channel would collide on one `channel:<id>` key and resume each
  // other's conversation under the wrong cwd.
  process.env.IDENTITY = 'personal';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const asPersonal = require('../src/llm').sessionKeyFor(channel({ id: 'T1', guild: {} }), 'U9');

  process.env.IDENTITY = 'boss';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
  const asBoss = require('../src/llm').sessionKeyFor(channel({ id: 'T1', guild: {} }), 'U9');

  assert.notEqual(asPersonal, asBoss);
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/llm')];
});

test('bindVoiceKey distinguishes unsupported from broken', async () => {
  // The bot may not depend on which backend sits behind OPENAI_BASE_URL, so a
  // stateless endpoint with no /voice/bind must degrade to one shared voice
  // conversation — NOT warn, and never block the join. A real error has to stay
  // distinguishable from that, because it means spoken turns are reaching a
  // conversation the speaker did not choose.
  const { bindVoiceKey } = require('../src/llm');
  const realFetch = global.fetch;

  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await bindVoiceKey('voice:G1'), { ok: false, unsupported: true });

    global.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await bindVoiceKey('voice:G1'), { ok: false, error: 'endpoint 500' });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await bindVoiceKey('voice:G1');
    assert.equal(down.retryable, true, 'an unreachable endpoint must be retried, not accepted');
    assert.match(down.error, /ECONNREFUSED/, 'and the cause must not be swallowed');

    global.fetch = async () => ({ ok: true });
    assert.deepEqual(await bindVoiceKey('voice:G1'), { ok: true });
  } finally {
    global.fetch = realFetch;
  }
});

test('setVoiceSolo carries the voice session key as X-Session-Key', async () => {
  // The shim's solo state is keyed by the same identifier bindVoiceKey keys
  // a session with. Without this header the shim would have to either reject
  // the POST (the route requires a key since the 2026-08-18 cross-call leak)
  // or fall back to a default key — which is exactly what the old global did.
  // The fix lives or dies on this header being present on every call.
  const { setVoiceSolo } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200 };
    };
    await setVoiceSolo(true, 'voice:G1:personal');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['X-Voice-Solo'], 'true');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
    await setVoiceSolo(false, 'voice:G1:personal');
    assert.equal(captured.headers['X-Voice-Solo'], 'false');
  } finally {
    global.fetch = realFetch;
  }
});

test('setVoiceSolo distinguishes unsupported from broken', async () => {
  // Same contract as bindVoiceKey: an endpoint without /voice/solo (any
  // stateless backend) must degrade gracefully, NOT block the join. A real
  // error has to stay distinguishable so the caller can choose between
  // "no route here" and "the route is broken".
  const { setVoiceSolo } = require('../src/llm');
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await setVoiceSolo(true, 'voice:G1'), { ok: false, unsupported: true });

    global.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await setVoiceSolo(true, 'voice:G1'), { ok: false, error: 'endpoint 500' });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await setVoiceSolo(true, 'voice:G1');
    assert.equal(down.retryable, true);
    assert.match(down.error, /ECONNREFUSED/);
  } finally {
    global.fetch = realFetch;
  }
});

test('setMode carries the mode and the conversation key', async () => {
  // The /mode slash command's back-edge. A mode is a PAIR of shim flags —
  // text-only is chat-on + speech-off — so it travels as one value on one
  // route. Setting the flags independently would make (chat off, speech off)
  // reachable, and that state leaves the user with nothing at all. The header
  // has to name the exact conversation: a missing or wrong X-Session-Key would
  // either be rejected by the route or flip a different conversation's mode.
  const { setMode } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  let url;
  try {
    global.fetch = async (u, init) => {
      url = u;
      captured = init;
      return { ok: true, status: 200 };
    };
    await setMode('text-only', 'voice:G1:personal');
    assert.match(url, /\/mode$/);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['X-Mode'], 'text-only');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
    await setMode('voice-only', 'voice:G1:personal');
    assert.equal(captured.headers['X-Mode'], 'voice-only');
  } finally {
    global.fetch = realFetch;
  }
});

test('setMode distinguishes unsupported from broken', async () => {
  // Same contract as setVoiceSolo: an endpoint without /mode (any stateless
  // backend, or a shim predating text-only) must degrade gracefully — the mode
  // stays as it was, the user is told the backend does not support modes, and
  // nothing wedges.
  const { setMode } = require('../src/llm');
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await setMode('text-only', 'voice:G1'), { ok: false, unsupported: true });

    global.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await setMode('text-only', 'voice:G1'), {
      ok: false,
      error: 'endpoint 500',
    });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await setMode('text-only', 'voice:G1');
    assert.equal(down.retryable, true);
    assert.match(down.error, /ECONNREFUSED/);
  } finally {
    global.fetch = realFetch;
  }
});

test('setInterrupt carries the posture and the conversation key', async () => {
  // The /interrupt slash command's back-edge. The shim's turn loop reads the
  // per-key flag at the moment the listener disappears, so the header has to
  // name the exact conversation — a missing or wrong X-Session-Key would
  // either be rejected by the route or flip a different conversation's turn.
  const { setInterrupt } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ cancel: false }) };
    };
    const off = await setInterrupt(false, 'voice:G1:personal');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['X-Barge-In'], 'off');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
    assert.deepEqual(off, { ok: true, cancel: false });
    await setInterrupt(true, 'voice:G1:personal');
    assert.equal(captured.headers['X-Barge-In'], 'on');
  } finally {
    global.fetch = realFetch;
  }
});

test('setInterrupt query form sends no X-Barge-In and reads the state back', async () => {
  // Bare /interrupt (no option) is the query form: no posture header, and the
  // returned `cancel` is the shim's current state — so the reply can say "it
  // is off" without a third round trip.
  const { setInterrupt } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ cancel: true }) };
    };
    const query = await setInterrupt(null, 'voice:G1:personal');
    assert.equal(captured.headers['X-Barge-In'], undefined);
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
    assert.deepEqual(query, { ok: true, cancel: true });
  } finally {
    global.fetch = realFetch;
  }
});

test('setInterrupt default form sends X-Barge-In: default (the clear)', async () => {
  // `/interrupt default` is the clear form, deliberately distinct from the
  // bare-command query (which sends no header at all): the header carries
  // `default`, and the shim pops the per-key override.
  const { setInterrupt } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ cancel: true }) };
    };
    await setInterrupt('default', 'voice:G1:personal');
    assert.equal(captured.headers['X-Barge-In'], 'default');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
  } finally {
    global.fetch = realFetch;
  }
});

test('setInterrupt distinguishes unsupported from broken', async () => {
  // Same contract as setChatPosting: an endpoint without /voice/barge (any
  // stateless backend) must degrade gracefully — cancellation stays as it was
  // (ON, the default), the user gets told the backend does not support the
  // toggle, and nothing wedges.
  const { setInterrupt } = require('../src/llm');
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await setInterrupt(false, 'voice:G1'), { ok: false, unsupported: true });

    global.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await setInterrupt(false, 'voice:G1'), { ok: false, error: 'endpoint 500' });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await setInterrupt(false, 'voice:G1');
    assert.equal(down.retryable, true);
    assert.match(down.error, /ECONNREFUSED/);
  } finally {
    global.fetch = realFetch;
  }
});

test('setTranscribe carries the posture and the conversation key', async () => {
  // The /transcribe slash command's back-edge. The shim's per-key store is the
  // authoritative posture, so the header has to name the exact conversation —
  // a missing or wrong X-Session-Key would either be rejected by the route or
  // flip a different conversation's transcription.
  const { setTranscribe } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ transcribe: true }) };
    };
    const off = await setTranscribe(false, 'voice:G1:personal');
    assert.equal(captured.method, 'POST');
    assert.equal(captured.headers['X-Transcribe'], 'off');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
    assert.deepEqual(off, { ok: true, transcribe: true });
    await setTranscribe(true, 'voice:G1:personal');
    assert.equal(captured.headers['X-Transcribe'], 'on');
  } finally {
    global.fetch = realFetch;
  }
});

test('setTranscribe default form sends X-Transcribe: default (the clear)', async () => {
  // `/transcribe default` is the clear form, deliberately distinct from the
  // bare-command query (which sends no header at all): the header carries
  // `default`, and the shim pops the per-key override.
  const { setTranscribe } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ transcribe: true }) };
    };
    await setTranscribe('default', 'voice:G1:personal');
    assert.equal(captured.headers['X-Transcribe'], 'default');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
  } finally {
    global.fetch = realFetch;
  }
});

test('setTranscribe query form sends no X-Transcribe and reads the state back', async () => {
  // Bare /transcribe (no option) is the query form: no posture header, and the
  // returned `transcribe` is the shim's current state — so the reply can say
  // "we are being written down" without a third round trip.
  const { setTranscribe } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return { ok: true, status: 200, json: async () => ({ transcribe: false }) };
    };
    const query = await setTranscribe(null, 'voice:G1:personal');
    assert.equal(captured.headers['X-Transcribe'], undefined);
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1:personal');
    assert.deepEqual(query, { ok: true, transcribe: false });
  } finally {
    global.fetch = realFetch;
  }
});

test('setTranscribe distinguishes unsupported from broken', async () => {
  // Same contract as setInterrupt: an endpoint without /voice/transcribe (any
  // stateless backend) must degrade gracefully — transcription stays as it
  // was (ON, the default), the user gets told the backend does not support the
  // toggle, and nothing wedges.
  const { setTranscribe } = require('../src/llm');
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await setTranscribe(false, 'voice:G1'), { ok: false, unsupported: true });

    global.fetch = async () => ({ ok: false, status: 500 });
    assert.deepEqual(await setTranscribe(false, 'voice:G1'), { ok: false, error: 'endpoint 500' });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await setTranscribe(false, 'voice:G1');
    assert.equal(down.retryable, true);
    assert.match(down.error, /ECONNREFUSED/);
  } finally {
    global.fetch = realFetch;
  }
});

test('getVoiceState carries the conversation key and reads the state back', async () => {
  // The /status back-edge: one GET that returns every runtime per-conversation
  // toggle for a key, so the operator sees wake / posting / interrupt /
  // transcribe at a glance instead of invoking each flag bare.
  const { getVoiceState } = require('../src/llm');
  const realFetch = global.fetch;
  let captured;
  try {
    global.fetch = async (_url, init) => {
      captured = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          key: 'voice:G1',
          wake: true,
          wake_override: null,
          posting: true,
          interrupt: false,
          transcribe: true,
        }),
      };
    };
    const state = await getVoiceState('voice:G1');
    assert.equal(captured.headers['X-Session-Key'], 'voice:G1');
    assert.deepEqual(state, {
      ok: true,
      key: 'voice:G1',
      wake: true,
      wake_override: null,
      posting: true,
      interrupt: false,
      transcribe: true,
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('getVoiceState distinguishes unsupported from broken', async () => {
  // /status must not break because the toggle-state probe hiccuped — an
  // unreachable or route-less shim degrades to a note, never a broken report.
  const { getVoiceState } = require('../src/llm');
  const realFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await getVoiceState('voice:G1'), { ok: false, error: 'endpoint 404' });

    global.fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const down = await getVoiceState('voice:G1');
    assert.equal(down.retryable, true);
    assert.match(down.error, /ECONNREFUSED/);
  } finally {
    global.fetch = realFetch;
  }
});
