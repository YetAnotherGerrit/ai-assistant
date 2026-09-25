'use strict';

const {
  joinVoiceChannel,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  NoSubscriberBehavior,
  getVoiceConnection,
} = require('@discordjs/voice');
const prism = require('prism-media');
const { PassThrough } = require('stream');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const config = require('./config');
const log = require('./log');
const { TranscriptSession } = require('./transcript');
const { chunk } = require('./discord-chunk');
// Imported as a namespace, not destructured: the typed-turn hint is stubbed in
// tests, and a destructured binding would capture the original function.
const llm = require('./llm');

const DISCORD_RATE = 48000,
  DISCORD_CH = 2;
const S2S_RATE = 16000;
const TICK_MS = 20;
// Resolved in config.js with every other env read, so the service's real
// configuration surface can be enumerated in one place.
const UTTERANCE_GAP_MS = config.utteranceGapMs;
const IN_BYTES = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000; // 20ms @48k stereo
const OUT_SAMPLES = (S2S_RATE * TICK_MS) / 1000; // 20ms @16k mono
// One 20ms frame of what Discord plays back: 48k, stereo, 16-bit.
const OUT_FRAME = (DISCORD_RATE * DISCORD_CH * 2 * TICK_MS) / 1000;

/**
 * A sentence ending welded to the next sentence's capital: `long.No`.
 *
 * Seen once in a real transcript — a holding line and an answer with nothing
 * between them. Every layer we can inspect preserves the space (the endpoint
 * ends each SSE chunk with one, speech-to-speech joins sentence batches with
 * one), so the next occurrence has to be caught in flight rather than
 * reconstructed afterwards.
 *
 * Requiring an uppercase letter keeps abbreviations, decimals and URLs out —
 * `e.g`, `3.5` and `example.com` do not match.
 */
const RUN_ON = /[.!?][A-Z]/;
const SILENCE = Buffer.alloc(OUT_FRAME);

// Discord's typing indicator lapses after ~10s, so it has to be re-sent while
// an answer is still being produced. The cap bounds a response that never
// reports finishing — dots that never stop are worse than none.
const TYPING_TICK_MS = 8000;
// Two minutes, not five. This is the LAST resort — the ordinary ends are
// `response.done` and the next utterance re-evaluating `answering`. Five
// minutes of dots after a turn died is long enough to read as "the bot is
// broken", which is the thing the indicator exists to prevent.
const TYPING_MAX_MS = 2 * 60 * 1000;

// A server error message is not written for a chat channel: an NLTK LookupError
// arrives as ~20 lines with a bullet list of searched paths. Collapse to the
// first meaningful line so the notice stays one readable sentence — the full
// text is in the log, which is where a stack trace belongs.
function reasonLine(raw, max = 140) {
  const first = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^\*+$/.test(l));
  if (!first) return 'unknown';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

// 48k stereo -> 16k mono. Mix channels first, then average groups of 3 (box
// low-pass). NOT naive striding, which walks alternating channels on an
// interleaved stream and aliases everything above 8 kHz back into the band.
function down(buf) {
  const out = Buffer.alloc(OUT_SAMPLES * 2);
  for (let i = 0; i < OUT_SAMPLES; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const off = (i * 3 + k) * 4;
      if (off + 3 >= buf.length) break;
      acc += (buf.readInt16LE(off) + buf.readInt16LE(off + 2)) / 2;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 3))), i * 2);
  }
  return out;
}

// 16k mono -> 48k stereo, linear interpolation.
function up(buf) {
  const n = buf.length / 2;
  const out = Buffer.alloc(n * 3 * 4);
  let o = 0;
  for (let i = 0; i < n; i++) {
    const cur = buf.readInt16LE(i * 2);
    const nxt = i + 1 < n ? buf.readInt16LE((i + 1) * 2) : cur;
    for (let k = 0; k < 3; k++) {
      const v = Math.round(cur + (nxt - cur) * (k / 3));
      out.writeInt16LE(v, o);
      out.writeInt16LE(v, o + 2);
      o += 4;
    }
  }
  return out;
}

/**
 * The stall filler, pre-rendered by tools/make-stall-clip.py and committed.
 *
 * Converted to Discord's 48 kHz stereo once, here, so playing it is a buffer
 * write and never a decode. That is the whole point: it has to cost nothing at
 * the moment it is needed, when the stages that would normally produce audio
 * are the ones that are slow.
 *
 * A missing or unreadable file yields an empty buffer rather than throwing.
 * The filler improves a slow turn; a bot that refuses to start because a
 * courtesy clip is absent has traded a cosmetic gap for an outage.
 */
const STALL_CLIP = (() => {
  try {
    return up(fs.readFileSync(path.join(__dirname, 'stall-clip.pcm')));
  } catch (e) {
    log.warn('voice: stall clip unavailable, stalls will stay silent', { error: e.message });
    return Buffer.alloc(0);
  }
})();

/**
 * What the clip says, so the call transcript records it.
 *
 * Read from the sidecar the generator writes rather than pasted in here: the
 * PCM and the text have to agree, and two copies of a spoken line diverge the
 * first time one of them is edited. The shim's `_PROGRESS_LINES` fillers reach
 * the transcript by riding the normal TTS path (`response.output_audio_
 * transcript.done`); this clip bypasses TTS entirely, so without this it would
 * be the one filler nobody could find in the record afterwards.
 *
 * Empty when the sidecar is missing, which drops the transcript line but still
 * plays the clip — the same degrade-don't-fail posture as the clip itself.
 */
const STALL_CLIP_TEXT = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'stall-clip.txt'), 'utf8').trim();
  } catch (e) {
    log.warn('voice: stall clip text unavailable, the filler will go unrecorded', {
      error: e.message,
    });
    return '';
  }
})();

/** One live voice session: Discord audio <-> speech-to-speech. */
class Session {
  constructor(connection, guildId, guildName, channelName, channelId, channel) {
    this.conn = connection;
    this.guildId = guildId;
    // A Discord voice channel has an integrated text chat sharing its id, so
    // this is what links a posted message to the running transcript.
    this.channelId = channelId;
    // The channel object itself, kept for postToChannel — the shim's
    // chat-bridge posts arrive with no channel id (see postToChannel below),
    // so this is what lets the bot answer "which channel" on its own.
    this.channel = channel;
    // Whether the operator is the only human here. Mirrors what the shim was
    // last told, so both sides gate on the same fact. FALSE until proven
    // otherwise — the safe direction, since being wrong the other way means
    // answering every sentence of a conversation held with someone else.
    this.solo = false;
    // Whether the shim will synthesise anything this turn — the bot-side half
    // of text-only mode. Also mirrors the shim, re-read per utterance rather
    // than tracked locally: /mode is set out of band, so a local copy would
    // drift the moment the shim restarted or another client flipped it. FALSE
    // until proven otherwise, which is the shim's own default (speech on) and
    // so keeps a failed probe from silently disabling the filler everywhere.
    this.speechOff = false;
    // Runtime override of `config.voiceAlwaysWake` for THIS call, set by an
    // admin over /wakephrase. Tri-state, matching the shim's own store: true forces
    // the phrase, false relaxes to head-count behaviour, null means no override
    // — use the configured default. Null on every new session, so an override
    // never outlives the call it was set in.
    this.wakeOverride = null;
    // Per-speaker buffers. Discord gives a separate stream per user (per SSRC),
    // which is the expensive half of any diarization pipeline — appending them
    // all to one buffer would throw that away AND garble the audio, since the
    // chunks interleave rather than align in time.
    this.inbox = new Map(); // userId -> Buffer
    this.audio = null; // open PassThrough while a reply is playing
    this.outQueue = Buffer.alloc(0); // 48k stereo PCM waiting to be paced out
    this.outTick = null;
    this.ending = false;
    this.speaking = false;
    // Set by cancelPlayback() (the /cancel command) and held until the server
    // finishes the response it cancelled. Without it the cancel is cosmetic:
    // the server has no "cancel this item" message, so the rest of the reply
    // keeps arriving, and pushAudio() starts playback again on the next chunk
    // — the abandoned answer resumes mid-sentence. Barge-in does not need this
    // because `speech_started` also tells the server to cancel the generation,
    // so no further chunks come; /cancel sends no such signal.
    this.cancelled = false;
    this.subscribed = new Set();
    this.closed = false;
    // Set by leave() to the reason it was called. Read by the stateChange
    // handler, which rejoins only while this is still null — i.e. only when
    // nobody asked to leave. See the leave contract in [[Discord Assistant
    // Leaves the Voice Call Without Being Told To]].
    this.leaveReason = null;
    this.ws = null;
    this.retry = null; // at most one outstanding reconnect
    // Armed when the last human leaves the channel, cleared on a rejoin or
    // teardown. Fires `voiceIdleReleaseMs` later — if the channel is STILL
    // empty, the session (and its s2s slot) is released. The handover bypasses
    // this: a joining bot evicts an idle holder immediately via the shim's
    // yield, never waiting out the grace window.
    this.idleReleaseTimer = null;
    // Set on the FIRST "slot already in use" refusal, cleared on a
    // successful (re)connect. Bounds how long the 'error' handler below
    // waits out a possible handover before giving up loudly — see
    // config.voiceSlotRetryDeadlineMs.
    this.slotWaitStartedAt = null;
    // Set while a response triggered by speak() (a typed turn, not a mic
    // turn) is in flight, so the transcript line it produces can be marked
    // distinctly from an ordinary spoken reply. Cleared once that reply's
    // transcript is written, or defensively on response.done.
    this.typedReplyPending = false;
    // Mirrors the server's own `st.in_response` (response.py) — set on
    // EVERY `response.created`, mic-triggered or not, cleared defensively on
    // BOTH `response.output_audio.done` and `response.done` (same two events
    // that reset typedReplyPending, for the same reason: a response that
    // ends abnormally must not wedge the next speak() as permanently busy).
    // speak() reads this before sending anything, because the server allows
    // only one response at a time regardless of who triggered it, and a
    // mic-driven reply to someone else on the call can otherwise be
    // mistaken, event-type-only, for the ack of our own request — see
    // speak()'s doc comment.
    this.inResponse = false;
    // True only while THIS session's own speak() call is waiting on its ack,
    // so a second typed turn arriving before the first is acked is refused
    // client-side rather than racing the same listener.
    this.awaitingSpeakAck = false;
    // Set by speak() while it is waiting; connectS2S() calls this to fail a
    // pending speak() fast (rather than making its caller wait out the full
    // ack timeout) when the socket it was waiting on is torn down.
    this.pendingSpeakFinish = null;
    // Live "…is typing" ticker in the call's text chat, while any answer is
    // being produced — see showTyping().
    this.typingTimer = null;
    // "An answer is on its way", for the typing indicator only.
    //
    // Deliberately NOT `inResponse`: that mirrors the server's client-visible
    // response state, and the server only announces `response.created` for a
    // response the CLIENT asked for (handlers/response.py:191). A mic turn
    // never emits one — by the time audio begins, assistant text has already
    // called `_ensure_response`, so `audio.py`'s `need_created` is false and
    // the event is skipped. So a spoken turn needs its own signal, and the
    // earliest honest one is the user's utterance being transcribed.
    this.answering = false;
    // The mic turn's stall clock: set when the user stops speaking, cleared
    // when audio arrives or the turn is abandoned. `speech_stopped` is the
    // earliest signal the bot gets that an answer is owed — `response.created`
    // never arrives for a mic turn (see `answering` above), and
    // `speech_started` fires while the user is still mid-sentence. So the gap
    // measured from here IS the wait the listener experiences.
    this.stallStartedAt = null;
    // Fires when that gap crosses config.voiceStallThresholdMs. Kept separate
    // from the measurement: every turn reports its gap, but only one slow
    // enough to be worth speaking into trips this.
    this.stallTimer = null;
    // Latched by the timer above and read by reportStall(). A flag rather than
    // inferring from `stallTimer === null`, which clearStallClock() also sets.
    this.stallDetected = false;

    // Transcript path — EVERY speaker, independent of the command allowlist.
    // Buffers here are flushed on each speaker's silence boundary.
    //
    // `transcript` doubles as the runtime transcription toggle: it is null
    // while this call is NOT being written down (either the TRANSCRIBE env
    // default was off at join, or an admin ran /transcribe off mid-call), and
    // non-null while it is. Every write path and the non-allowlisted-speaker
    // subscription guard already branch on `this.transcript`, so a toggle is
    // just constructing or dropping the session — no separate flag to drift.
    // The names are kept so /transcribe on can construct one mid-call.
    this.guildName = guildName;
    this.channelName = channelName;
    // The stable holder across a toggle-off, so a call paused then resumed
    // stays ONE transcript session (no second `## session` header mid-call).
    this.transcriptSession = null;
    this.transcript = config.transcribe ? new TranscriptSession(guildName, channelName) : null;
    this.utterance = new Map(); // userId -> Buffer (48k stereo, as captured)
    this.flushTimers = new Map(); // userId -> pending flush
    this.names = new Map(); // userId -> display name

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.conn.subscribe(this.player);
    this.player.on('idle', () => {
      this.speaking = false;
    });

    this.conn.receiver.speaking.on('start', (userId) => {
      clearTimeout(this.flushTimers.get(userId)); // resumed — keep accumulating
      this.flushTimers.delete(userId);
      this.listen(userId);
    });
    // Silence boundary per speaker: this is what turns a continuous stream into
    // utterances, and it is why the transcript reads like a conversation rather
    // than one undifferentiated block.
    this.conn.receiver.speaking.on('end', (userId) => this.scheduleFlush(userId));
    this.connectS2S();

    // Discord emits audio ONLY while someone speaks, but s2s closes a turn on
    // SILENCE. Without this fixed-rate pump sending silence between utterances
    // the turn never ends and no reply is ever produced.
    this.pump = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * Flip whether THIS call is written down, mid-call.
   *
   * Called by the /transcribe handler AFTER the shim's per-key store took the
   * change — the bot mirrors the shim, it never leads it. (A fresh call's
   * starting posture is set directly from the TRANSCRIBE env default in the
   * constructor, not through here.) Enabling reuses the session captured by a
   * previous disable, so a call toggled off then on stays ONE transcript
   * rather than fragmenting into a second `## session` header; disabling
   * drops `this.transcript`, which makes every existing guard — writes, flush
   * scheduling, and the non-allowlisted speaker subscription decision — go
   * quiet with no separate flag to keep in sync.
   */
  setTranscribing(on) {
    if (on && !this.transcript) {
      this.transcript =
        this.transcriptSession ?? new TranscriptSession(this.guildName, this.channelName);
    } else if (!on && this.transcript) {
      this.transcriptSession = this.transcript;
      this.transcript = null;
    }
  }

  listen(userId) {
    if (this.subscribed.has(userId)) return;
    const allowed = config.isAllowed(userId);
    // Subscribe to everyone when transcribing; otherwise only to people who may
    // drive the bot. Two different questions: who can COMMAND it (allowlist)
    // and who gets WRITTEN DOWN (transcript).
    if (!allowed && !this.transcript) {
      if (!this.subscribed.has(`denied:${userId}`)) {
        this.subscribed.add(`denied:${userId}`);
        log.info('voice: ignoring speaker, not allowlisted', { userId });
      }
      return;
    }
    this.subscribed.add(userId);
    log.info('voice: speaker subscribed', { userId, drivesBot: allowed });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_RATE,
      channels: DISCORD_CH,
      frameSize: 960,
    });
    this.conn.receiver
      .subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 24 * 3600 * 1000 },
      })
      .pipe(decoder)
      .on('data', (c) => {
        // Command path: only allowlisted audio reaches speech-to-speech.
        if (allowed) {
          this.inbox.set(userId, Buffer.concat([this.inbox.get(userId) ?? Buffer.alloc(0), c]));
        }
        // Transcript path: everyone, kept separate per speaker.
        if (this.transcript) {
          this.utterance.set(
            userId,
            Buffer.concat([this.utterance.get(userId) ?? Buffer.alloc(0), c]),
          );
        }
      });
  }

  /**
   * Close an utterance only after sustained silence.
   *
   * Discord fires `speaking.end` on every brief pause, so flushing immediately
   * chops one sentence into fragments and the transcript fills with "Yeah."
   * lines. Waiting UTTERANCE_GAP_MS — and cancelling if the same speaker
   * resumes — keeps a sentence together.
   */
  scheduleFlush(userId) {
    if (!this.transcript) return;
    clearTimeout(this.flushTimers.get(userId));
    this.flushTimers.set(
      userId,
      setTimeout(() => {
        this.flushTimers.delete(userId);
        this.flush(userId);
      }, UTTERANCE_GAP_MS),
    );
  }

  /** Write one speaker's utterance to disk. */
  flush(userId) {
    if (!this.transcript) return;
    const pcm = this.utterance.get(userId);
    if (!pcm?.length) return;
    this.utterance.delete(userId);
    this.transcript.write(userId, this.names.get(userId) ?? userId, pcm);
  }

  tick() {
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Take one 20ms slice from each speaker and sum them sample-aligned. With a
    // single speaker this is a pass-through; with several it is a real mix
    // rather than interleaved garbage. Speaker identity is preserved in the
    // buffers above, so per-speaker STT stays possible later.
    const ready = [];
    for (const [userId, buf] of this.inbox) {
      if (buf.length < IN_BYTES) continue;
      ready.push(buf.subarray(0, IN_BYTES));
      this.inbox.set(userId, buf.subarray(IN_BYTES));
    }

    let frame;
    if (ready.length === 0) {
      frame = Buffer.alloc(OUT_SAMPLES * 2); // silence keeps the VAD turn closing
    } else if (ready.length === 1) {
      frame = down(ready[0]);
    } else {
      frame = Buffer.alloc(OUT_SAMPLES * 2);
      const mixed = ready.map(down);
      for (let i = 0; i < OUT_SAMPLES; i++) {
        let sum = 0;
        for (const m of mixed) sum += m.readInt16LE(i * 2);
        frame.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i * 2);
      }
    }
    this.ws.send(
      JSON.stringify({ type: 'input_audio_buffer.append', audio: frame.toString('base64') }),
    );
  }

  /**
   * (Re)connect to speech-to-speech, leaving exactly ONE live socket behind.
   *
   * Replacing `this.ws` does not silence the socket it replaced: the old object
   * keeps its `message` listener, so it goes on feeding onEvent and every reply
   * is played once per stale socket. Heard as a doubled response, and it grows
   * with each reconnect — one s2s restart is enough to start it.
   *
   * Likewise only one retry timer may be outstanding, or two chains race and
   * each leaves its own socket.
   */
  connectS2S() {
    if (this.closed) return;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    // A pending speak() was waiting on the socket that just got torn down —
    // fail it now rather than making the caller wait out the full ack
    // timeout for a reply that can never arrive.
    if (this.pendingSpeakFinish) this.pendingSpeakFinish({ ok: false, reason: 'no-socket' });

    const ws = new WebSocket(config.s2sUrl, { maxPayload: 0 });
    this.ws = ws;
    ws.on('open', () => {
      log.info('  voice: s2s connected');
      // No onSlotFreed() here: WS open precedes BOTH server outcomes. The
      // router claims the pipeline slot AFTER accept and either sends
      // `session.created` (slot acquired) or `session_limit_reached` + close
      // (slot busy). Claiming a completed handover on open is how a rejected
      // reconnect logged "handover completed" and then took the rejection —
      // the 2026-08-22 secondary defect. The honest signal is the server's
      // `session.created`, handled in onEvent().
      // Deliberately a PARTIAL session.update: speech-to-speech deep-merges
      // incoming fields (handlers/session.py:28), so sending only this one
      // leaves the launcher's VAD tuning — thresholds, silence durations —
      // exactly as it was. Sending a full `turn_detection` object would reset
      // whatever it does not mention.
      // Both `type` discriminators are REQUIRED, and omitting either gets the
      // whole update rejected with "Unknown or invalid event: session.update"
      // — a message that reads like the event is unsupported when it is really
      // a validation failure. Verified against the openai SessionUpdateEvent
      // model directly: without `session.type` it does not validate.
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            turn_detection: { type: 'server_vad', interrupt_response: config.interruptResponse },
          },
        }),
      );
      log.info('  voice: interrupt-on-speech', { enabled: config.interruptResponse });
    });
    // Object, not a bare string: the logger spreads its second argument, so a
    // string renders as {"0":"c","1":"o",…} and the message is unreadable.
    ws.on('error', (e) => log.error('  voice: s2s error', { error: e.message }));
    ws.on('close', () => {
      // Ignore a close from a socket we already replaced, or it schedules a
      // reconnect on top of the live one.
      if (this.closed || this.ws !== ws) return;
      log.info('  voice: s2s closed, retrying in 2s');
      this.retry = setTimeout(() => this.connectS2S(), 2000);
    });
    // Same guard: a superseded socket must not reach the player.
    ws.on('message', (raw) => {
      if (this.ws === ws) this.onEvent(raw);
    });
  }

  /**
   * Push a typed turn into this session's own s2s socket so it is answered
   * aloud through the playback path already wired for spoken turns — see the
   * design note in [[Typed messages cannot be answered aloud]]. No second TTS
   * path: the reply returns through the existing `response.output_audio.delta`
   * -> `pushAudio` route once the server accepts the request below.
   *
   * Two events per the realtime protocol: `conversation.item.create` adds the
   * text to the LLM context without triggering generation, `response.create`
   * triggers it. The server acks with `response.created`, or refuses cleanly
   * with `conversation_already_has_active_response` if a response is already
   * in flight (response.py:150).
   *
   * **Why this gates on `inResponse`/`awaitingSpeakAck` before sending
   * anything**, rather than just racing the next `response.created` off the
   * shared socket: the server auto-generates a response for a MIC turn via
   * VAD with no client `response.create` at all, so a bare event-type match
   * cannot tell "the ack for MY request" from "someone else on the call just
   * finished a sentence". Gating first — refusing as `busy` client-side when
   * a response is already known to be in flight, and refusing a second
   * concurrent `speak()` the same way — closes that window down to the
   * network round-trip between the check and the send, which is the same
   * residual race the server itself accepts (its own gate is a plain
   * boolean, not a queue). Still not a client-side response STATE MACHINE:
   * `inResponse` only mirrors what the server already reports on every
   * `response.created`/`response.done`, it decides nothing on its own.
   *
   * Accepted tradeoff: once `conversation.item.create` is actually sent, a
   * `timeout` or a lost-race `no-socket` (via `connectS2S()`'s reconnect
   * hook) is reported to the caller, but the item itself is never retracted
   * — the server has no "cancel this item" message, and the deferred-item
   * flush in conversation.py means it may still surface in the transcript
   * later, attributed correctly to the user, just without a spoken reply
   * this turn. The common busy case never reaches this window at all,
   * because the gate above refuses before sending anything.
   */
  async speak(text, { timeoutMs = config.speakAckTimeoutMs } = {}) {
    // Both refusals are decided BEFORE the typed-turn hint is set, so the
    // common "someone is already talking" case never leaves a hint behind for
    // a turn that will not happen.
    if (this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, reason: 'no-socket' };
    }
    // `answering` as well as `inResponse`, and it is the one that matters for
    // a MIC turn: the server announces `response.created` only for a response
    // the client asked for, so `inResponse` stays false through an entire
    // spoken answer. Gating on it alone meant typing while the assistant was
    // already talking sailed past this check and was refused by the server
    // instead — correct, but a round trip later and with a worse reason.
    if (this.awaitingSpeakAck || this.inResponse || this.answering) {
      return { ok: false, reason: 'busy' };
    }

    // Before the turn, not after: the endpoint consumes the hint at the top of
    // the turn it belongs to, and s2s only calls the endpoint once generation
    // starts — strictly after the `response.created` awaited below. Awaited so
    // it cannot lose the race against a fast turn.
    //
    // KEYED PER GUILD, like the turn it describes. This said
    // `llm.DEFAULT_SESSION_KEY` with a comment claiming "voice always lands on
    // the default session key" — true until v0.10.0 keyed voice as
    // `voice:<guildId>`. After it, the hint was written to `default` and read
    // from `voice:<guildId>`, so it never matched: every typed message in a
    // live call was judged by the WAKE PHRASE as if it had been spoken, and
    // anything not opening with "hey bot" was dropped as unaddressed. No error,
    // no log line beyond `QUIET`. Second instance of the v0.9.x key-prefix
    // regression — same release, different consumer.
    await llm.markTypedTurn(llm.voiceKeyFor(this.guildId));
    // Deliberately a local closure rather than a second method: `speak` is
    // driven in tests as `Session.prototype.speak.call(fakeSession, …)`, and
    // anything reached through `this` would have to be re-attached to every
    // fake — a helper whose only effect is to make the code harder to test.
    const awaitAck = () =>
      new Promise((resolve) => {
        this.awaitingSpeakAck = true;
        const ws = this.ws;
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ws.removeListener('message', onAck);
          this.awaitingSpeakAck = false;
          this.pendingSpeakFinish = null;
          resolve(result);
        };
        this.pendingSpeakFinish = finish;
        const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
        const onAck = (raw) => {
          let e;
          try {
            e = JSON.parse(raw);
          } catch {
            return;
          }
          if (e.type === 'response.created') {
            this.typedReplyPending = true;
            finish({ ok: true });
          } else if (e.type === 'error') {
            // Any refusal ends the wait immediately — not just the one reason
            // this path anticipates — so a caller sees the real reason instead
            // of a misleading `timeout` several seconds later. The server's own
            // "one response at a time" refusal keeps its documented `busy`
            // label (response.py:150); every other error type is passed
            // through as-is rather than flattened to a generic string.
            const type = e.error?.type;
            finish({
              ok: false,
              reason:
                type === 'conversation_already_has_active_response' ? 'busy' : type || 'error',
            });
          }
        };
        ws.on('message', onAck);
        ws.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
          }),
        );
        ws.send(JSON.stringify({ type: 'response.create' }));
      });

    const result = await awaitAck();
    // A hint left behind by a turn that died after the send would mark the
    // next unrelated SPOKEN reply as typed-originated. Cheap to undo — and it
    // has to clear the SAME key it set, or the retraction misses too.
    if (!result.ok) await llm.markTypedTurn(llm.voiceKeyFor(this.guildId), false);
    return result;
  }

  /**
   * Keep Discord's "…is typing" dots alive in the call's text chat while the
   * assistant is answering — whichever surface asked.
   *
   * Raised from TWO signals, because the two surfaces announce themselves
   * differently and there is no single event covering both: `response.created`
   * for a turn the client asked for (typed), and the user's utterance being
   * transcribed for a mic turn — which never emits `response.created` at all.
   * Assuming one event covered both is exactly how the first attempt at this
   * shipped without working for speech.
   *
   * Accepted cost, stated because it is a real one: a spoken turn that never
   * produces a written copy (a greeting, a two-sentence answer with nothing
   * postable) now flashes the dots for a moment and posts nothing. That reads
   * as "it is working", which is true, and is the lesser evil against text
   * arriving with no warning it was coming.
   *
   * Self-terminating three ways, because an indicator nobody clears is worse
   * than none: the response ending, the session closing, and a hard cap.
   * Discord also clears it by itself the moment a message is sent.
   */
  showTyping() {
    if (!this.channel?.sendTyping || this.typingTimer) return;
    const startedAt = Date.now();
    const tick = () => this.channel.sendTyping().catch(() => {});
    tick();
    this.typingTimer = setInterval(() => {
      if (!this.answering || this.closed || Date.now() - startedAt > TYPING_MAX_MS) {
        clearInterval(this.typingTimer);
        this.typingTimer = null;
        // The cap is now a stuck-state guard, not just a cosmetic stop: since
        // speak() refuses while `answering` is true, a response that never
        // reports finishing would otherwise wedge typed turns as permanently
        // busy. Releasing it here bounds that to TYPING_MAX_MS.
        this.answering = false;
        return;
      }
      tick();
    }, TYPING_TICK_MS);
    // Never hold the process open for a cosmetic indicator.
    this.typingTimer.unref?.();
  }

  /**
   * A slot we were waiting out just freed — say so once, quietly, and clear
   * the wait state. Called on every successful (re)connect; a no-op unless
   * `slotWaitStartedAt` is actually set.
   *
   * This is the successful-handover case: the shim's yield had already asked
   * the previous holder to leave, and it finished before our deadline. Stays
   * silent in the channel by design — a normal handover must read as silent
   * from the user's point of view, or every ordinary switch spams the
   * channel with a notice nobody needed. Called from onEvent() on the
   * server's `session.created`, which only arrives once the slot is actually
   * acquired — never from connectS2S()'s WS 'open', which precedes both the
   * acceptance and the `session_limit_reached` rejection.
   */
  onSlotFreed() {
    if (!this.slotWaitStartedAt) return;
    log.info('  voice: slot freed, connected — handover completed', {
      waitedMs: Date.now() - this.slotWaitStartedAt,
    });
    this.slotWaitStartedAt = null;
  }

  onEvent(raw) {
    let e;
    try {
      e = JSON.parse(raw);
    } catch {
      return;
    }
    // LOG_LEVEL=debug traces the audio path: which events arrive, how much PCM
    // each carries, and how many times playback is triggered per turn. Cheap to
    // leave in — a doubled reply is invisible in the transcript, because it is
    // the same text played twice rather than said twice.
    log.debug('  voice: s2s event', {
      type: e.type,
      bytes: e.delta ? Buffer.byteLength(e.delta, 'base64') : undefined,
      playing: Boolean(this.audio),
    });
    switch (e.type) {
      // The router's actual acceptance of the session — sent only after it has
      // claimed the pipeline slot. This is the honest "slot acquired" signal:
      // on WS open the server may still reject with `session_limit_reached`
      // (which sends no session.created), so claiming a completed handover
      // belongs here, where a rejection can never have preceded it.
      case 'session.created':
        this.onSlotFreed();
        log.info('  voice: s2s session accepted', { sessionId: e.session?.id });
        break;
      // Mirrors the server's own st.in_response gate (response.py) — set on
      // EVERY response.created, not just ones speak() triggered, because a
      // mic-driven VAD turn puts the connection in the same busy state and
      // speak() must refuse just as cleanly during someone else's live reply.
      case 'response.created':
        this.inResponse = true;
        this.answering = true;
        // A fresh turn is never a cancelled one. Defensive, like the resets on
        // response.done: if the cancelled turn somehow ended without reporting
        // it, a stuck `cancelled` would silently swallow every later reply.
        this.cancelled = false;
        this.showTyping();
        break;
      case 'input_audio_buffer.speech_started':
        // TWO interrupt paths exist and both have to obey the same switch.
        // The server cancels the generation (turn_detection.interrupt_response,
        // set on connect); this one destroys the playback locally. Gating only
        // the server left the answer produced and the audio thrown away — the
        // same lost reply, a different cause, and a switch that looked set
        // while an acknowledgement still cut the assistant off mid-sentence.
        if (this.speaking && config.interruptResponse) {
          log.info('  voice: barge-in — stopping playback');
          // Must destroy the stream too: stopping the player alone leaves it
          // open, and the next chunk would resume the abandoned reply.
          this.stopAudio();
        }
        break;
      // The mic turn's clock starts here, and this is the only event that can
      // start it: `response.created` is suppressed on this path (see
      // `answering` in the constructor), and `speech_started` fires while the
      // user is still mid-sentence. Speech END is the first moment an answer
      // is owed, so it is the first moment a listener can be waiting.
      //
      // Armed on EVERY utterance, addressed or not — the server emits this
      // unconditionally (`handlers/audio.py:150`) and the bot cannot yet tell
      // whether this one was for it. That verdict arrives seconds later with
      // the transcription, which disarms the clock when the answer is silence.
      case 'input_audio_buffer.speech_stopped':
        this.startStallClock();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (e.transcript) log.info(`  voice YOU: ${e.transcript}`);
        // The mic turn's "an answer is coming" signal — the user has finished
        // an utterance and it has been transcribed. This is where the spoken
        // path raises the dots, because `response.created` never arrives for
        // it (see `answering` in the constructor).
        //
        // Only when the utterance was actually ADDRESSED to the bot. An
        // unaddressed one is answered with silence by the endpoint, so nothing
        // ever arrives to clear the flag: the dots hung until the five-minute
        // cap, and — worse than cosmetic — `speak()` refuses typed turns as
        // `busy` for exactly as long. Every sentence spoken to a colleague
        // would have wedged the typed path.
        // ASSIGNED, never only set. A turn that produces nothing — the endpoint
        // declining, or speech-to-speech hanging up mid-answer ("listener
        // gone") — sends no `response.done`, so the flag that was raised for it
        // is never lowered: the dots run to the cap and `speak()` refuses typed
        // turns as busy for the same period. Observed live at 12:39.
        //
        // A new utterance is the natural end of the previous turn, so
        // re-evaluating here bounds any stuck state to "until you speak again"
        // instead of "until the cap". The `response.done` reset still exists;
        // this is the backstop for turns that never reach it.
        // `this.solo` mirrors what the shim was last told. Both sides evaluate
        // the wake rule — the shim decides what is answered, the bot needs the
        // same verdict seconds earlier to raise the dots — so a drift between
        // them costs a typing indicator with no answer behind it. One source
        // (the room) posted to the shim and kept here is what keeps them level.
        this.answering = this.solo || config.isAddressed(e.transcript);
        // Not addressed → the endpoint answers with silence → there is no wait
        // to narrate. Disarmed HERE rather than at `response.done`, which such
        // a turn never sends (see the flag notes below).
        if (!this.answering) this.clearStallClock();
        // The other half of the stall gate. A wait that already crossed the
        // threshold while the verdict was unknown is narrated NOW, which is
        // the earliest moment the bot can know an answer is actually owed.
        if (this.answering && this.stallDetected) this.speakStallClip();
        if (this.answering) this.showTyping();
        else log.debug('  voice: not addressed, no typing indicator');
        break;
      // NOTE: response.output_audio.delta — NOT response.audio.delta, which is
      // what OpenAI's hosted Realtime uses and what most write-ups quote.
      case 'response.output_audio.delta':
        if (e.delta) this.pushAudio(Buffer.from(e.delta, 'base64'));
        break;
      // Deltas are logged only to settle where a missing separator comes from.
      // A transcript once read "Won't be long.No — I didn't send anything
      // anywhere": a holding line and an answer with nothing between them. The
      // endpoint demonstrably ends every SSE chunk with a trailing space, and
      // speech-to-speech joins sentence batches with a space, so the loss is
      // somewhere between — and unquoted logging cannot show it, because the
      // whole question is whitespace.
      case 'response.output_audio_transcript.delta':
        if (e.delta) log.debug('  voice BOT delta', { raw: JSON.stringify(e.delta) });
        break;
      case 'response.output_audio_transcript.done':
        if (e.transcript) {
          // Fires only on the defect, so it costs nothing until it happens and
          // needs no log level raised to catch it — the failure is rare, comes
          // from a live call, and is invisible in unquoted output.
          if (RUN_ON.test(e.transcript)) {
            log.warn('transcript run-on: sentence end with no separator', {
              raw: JSON.stringify(e.transcript.slice(0, 200)),
            });
          }
          log.info(`  voice BOT: ${e.transcript}`);
          // The bot's own speech never returns through Discord, so without this
          // the transcript is one-sided: questions with no answers. A reply
          // triggered by speak() (a typed turn) is marked distinctly from an
          // ordinary spoken reply — same write path, but the record still has
          // to show WHICH surface asked, matching the "(typed) " marker
          // already put on the user's turn.
          this.transcript?.writeText(
            config.assistantLabel,
            this.typedReplyPending ? `(typed→spoken) ${e.transcript}` : e.transcript,
          );
          this.typedReplyPending = false;
        }
        break;
      case 'response.output_audio.done':
      case 'response.done':
        // Defensive: a response that ends with no transcript (empty/failed
        // synthesis) must not leave a stale flag marking the NEXT unrelated
        // reply as typed-originated. Same for inResponse — a stuck `true`
        // here would wedge every future speak() as permanently busy.
        this.typedReplyPending = false;
        this.inResponse = false;
        this.answering = false;
        // The cancelled turn is over, so its audio suppression ends here —
        // otherwise a stuck flag would mute the next reply. Primary clear;
        // response.created is the backstop.
        this.cancelled = false;
        // A no-op once audio played (reportStall already cleared it) — this is
        // the backstop for a response that ends without ever producing a frame.
        this.clearStallClock();
        this.endAudio();
        break;
      case 'error': {
        log.error('  voice: s2s event error', JSON.stringify(e).slice(0, 200));
        // speech-to-speech has exactly ONE session slot machine-wide. When
        // another process already holds it, the connection still opens fully
        // in Discord — this bot subscribes to audio, joins the channel — but
        // the socket is refused at the protocol level with this error, and
        // then closed. Left unhandled, `connectS2S()`'s close handler retries
        // every 2s forever: a perfectly healthy-looking process that answers
        // nothing, observed live as "s2s closed, retrying in 2s" on loop.
        //
        // Leaving on the very FIRST refusal (as this used to) is just as
        // wrong the other way: last-joiner-wins handover asks the previous
        // holder to yield before this bot even tries to connect, and the
        // first refusal can arrive while that yield is still in flight — the
        // handover then frees a slot nobody is left waiting for. So this
        // rides out the existing 2s retry cadence (`connectS2S()`'s close
        // handler, untouched) for a bounded deadline before giving up loudly,
        // exactly as before. The deadline is mandatory, never infinite — see
        // config.voiceSlotRetryDeadlineMs.
        if (
          /session slots are in use|disconnect an existing client/i.test(e.error?.message || '')
        ) {
          const reason = reasonLine(e.error?.message || e.error?.type);
          const now = Date.now();
          if (!this.slotWaitStartedAt) {
            this.slotWaitStartedAt = now;
            log.info('  voice: slot in use, waiting — a handover may be in flight', {
              reason,
              deadlineMs: config.voiceSlotRetryDeadlineMs,
            });
            break;
          }
          const waitedMs = now - this.slotWaitStartedAt;
          if (waitedMs < config.voiceSlotRetryDeadlineMs) {
            log.info('  voice: still waiting for slot to free', { reason, waitedMs });
            break;
          }
          log.error('  voice: s2s slot still in use after deadline, leaving instead of retrying', {
            reason,
            waitedMs,
          });
          this.channel
            ?.send(`Voice slot is already in use by another identity — leaving (${reason}).`)
            .catch(() => {});
          this.transcript?.writeText(
            config.assistantLabel,
            `(voice: left — slot in use elsewhere: ${reason})`,
          );
          leave(this.guildId, 'slot-in-use');
          break;
        }
        // ONLY `response_failed` — the type `_on_response_failed` sends — is a
        // turn that died with no other reporter. The other error types must not
        // reach the code below:
        //   - `conversation_already_has_active_response` arrives BY DEFINITION
        //     while a response is in flight, so clearing the flags and calling
        //     endAudio() would cut off the answer being spoken.
        //   - every error on a typed turn is already answered by speak()'s own
        //     onAck listener, which text.js turns into exactly the notice and
        //     transcript line written below — handling it here too would post
        //     the same failure twice.
        if (e.error?.type !== 'response_failed') break;
        const reason = reasonLine(e.error?.message || e.error?.type);
        // A turn that fails before any assistant text emits NO `response.done`,
        // so the flags that event normally clears stay raised — `answering`
        // then wedges every later speak() as permanently busy. That is the
        // observed follow-on symptom of a silent failure, not a separate
        // defect: a typed turn during the 2026-08-11 outage was refused with
        // reason `busy` while nothing was actually in flight.
        this.typedReplyPending = false;
        this.inResponse = false;
        this.answering = false;
        // Same reason as the response.done clear: this path exists precisely
        // because a failed turn emits no response.done, so a cancelled turn
        // that then failed would otherwise leave the flag stuck and mute every
        // later reply.
        this.cancelled = false;
        this.clearStallClock();
        this.endAudio();
        // From inside Discord, a failed answer and an utterance the wake gate
        // ignored are the same event: silence. Both surfaces the busy path
        // already writes to (src/text.js) get the reason, so whichever one a
        // reader looks at says why nothing was spoken.
        this.transcript?.writeText(config.assistantLabel, `(voice reply failed: ${reason})`);
        this.channel?.send(`Could not answer that out loud (${reason}).`).catch(() => {});
        break;
      }
    }
  }

  /**
   * Start the mic turn's stall clock — the user has stopped speaking and an
   * answer is now owed.
   *
   * Re-armed per utterance, never accumulated: a second utterance while the
   * first is still unanswered restarts the wait, because that is what the
   * listener experiences (they spoke again, and are waiting from there).
   */
  startStallClock() {
    this.clearStallClock();
    // Refresh the speech posture here, not at the threshold: the answer is not
    // needed for another `voiceStallThresholdMs`, so the probe rides along with
    // a wait that is already happening and costs the turn nothing. Fired and
    // forgotten deliberately — a probe that is slow enough to miss the
    // threshold leaves the previous answer in place, which is the same value
    // the default would have been.
    llm
      .getVoiceState(llm.voiceKeyFor(this.guildId))
      .then((s) => {
        this.speechOff = s.ok && s.speech === false;
      })
      .catch(() => {
        this.speechOff = false;
      });
    this.stallStartedAt = Date.now();
    // The DETECTOR, distinct from the measurement in reportStall(). unref'd so
    // a pending stall can never hold the process open through a teardown.
    this.stallTimer = setTimeout(() => this.onStallThreshold(), config.voiceStallThresholdMs);
    this.stallTimer.unref?.();
  }

  /**
   * The wait crossed the threshold with no audio yet — record it, and narrate
   * it only if an answer is already known to be owed.
   *
   * Crossing the threshold is NOT sufficient on its own. The addressing
   * verdict arrives with the transcription, and on a stalled turn that lands
   * well after this fires — the STT stage is the largest single component of
   * the wait (11.34s of a 25.6s turn), so at an 8s threshold the verdict is
   * reliably still unknown. Narrating unconditionally here would speak a
   * filler for every unaddressed remark made during a stall, promising an
   * answer that is never coming — worse than the silence it replaced, and the
   * same failure the `answering` flag exists to prevent on the typed path.
   *
   * A wait that crosses the threshold while the verdict is still unknown is
   * not lost: the transcription case in onEvent plays it as soon as the
   * verdict lands as addressed. Late, never never.
   */
  onStallThreshold() {
    this.stallTimer = null;
    this.stallDetected = true;
    log.info('  voice: stall — no audio yet', {
      waitedMs: Date.now() - this.stallStartedAt,
      thresholdMs: config.voiceStallThresholdMs,
      // text-only: no audio is ever coming, so this crossing is the mode
      // working rather than a fault. Reported rather than suppressed — it is
      // the one place the log shows a turn produced no speech on purpose — but
      // read the flag before reading the line as a problem.
      speechOff: this.speechOff,
    });
    if (this.answering) this.speakStallClip();
  }

  /**
   * Disarm the stall clock without reporting it — the wait ended for a reason
   * that is not an answer (unaddressed utterance, failed response, teardown).
   */
  clearStallClock() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
    this.stallStartedAt = null;
    this.stallDetected = false;
  }

  /**
   * Report the mic turn's wait, end-of-utterance to first audio frame.
   *
   * Logged on EVERY mic turn, not only the stalled ones. A threshold with no
   * distribution behind it cannot be reviewed, and the premise of this change
   * is that the fast turn is the normal one — so the fast turn has to be in
   * the log for the slow one to mean anything. `gapMs` is the number SC1 asks
   * for; `detected` says whether it also crossed the threshold.
   */
  reportStall() {
    if (!this.stallStartedAt) return;
    const gapMs = Date.now() - this.stallStartedAt;
    const detected = this.stallDetected;
    this.clearStallClock();
    log.info('  voice: mic turn start-to-audio', {
      gapMs,
      thresholdMs: config.voiceStallThresholdMs,
      detected,
    });
  }

  /**
   * Speak the cached filler while the stall is still in progress.
   *
   * Written straight into the same pump real audio uses, so it bypasses the
   * LLM and the TTS — the two stages that are slow. Nothing here calls a model,
   * and that is the point: routing the filler through `speak()` would put a
   * generation round-trip in front of a turn that is already late, and its
   * output would then queue behind the same stalled TTS it was meant to cover.
   *
   * The clip is enqueued AHEAD of any answer, so an answer arriving mid-clip
   * waits for it — bounded by the clip's own length (~2.8s), and zero on the
   * long stalls this exists for, where the clip finished long before audio
   * arrived. Cutting it off instead would remove that bound but land mid-word,
   * which reads as a fault rather than as a courtesy.
   */
  speakStallClip() {
    // Playback is already live, so the wait this was going to fill is over.
    if (this.audio || !STALL_CLIP.length) return;
    // text-only: the shim will never send audio, so the stall this clip exists
    // to cover never ends — it is the mode, not a slow turn. Speaking into it
    // would put the only sound of the call into a conversation that asked for
    // none, and it lands AFTER the answer has already been posted to the
    // channel, so the listener hears a filler for a reply they have read.
    // Gated here rather than at the two call sites: this is the one function
    // both of them reach, so a third caller cannot reintroduce the leak.
    if (this.speechOff) return;
    // Same reason as the gate in pushAudio(): this is the OTHER path that opens
    // a playback stream, so a cancelled turn whose stall clock fires would
    // otherwise re-open the player and speak the filler into a reply the
    // listener just cancelled.
    if (this.cancelled) return;
    this.audio = new PassThrough();
    this.ending = false;
    this.speaking = true;
    this.outQueue = Buffer.concat([this.outQueue, STALL_CLIP]);
    this.player.play(createAudioResource(this.audio, { inputType: StreamType.Raw }));
    this.outTick = setInterval(() => this.pumpOut(), TICK_MS);
    // Recorded under the assistant's own label, exactly as a spoken reply is —
    // the listener heard the assistant say it, so the transcript should read
    // that way. Written at play time rather than when the stall was detected,
    // because this is the moment the words are actually in the call, and the
    // segment filename carries the timestamp that places it in the wait.
    if (STALL_CLIP_TEXT) this.transcript?.writeText(config.assistantLabel, STALL_CLIP_TEXT);
    log.info('  voice: stall clip playing', {
      clipMs: Math.round(STALL_CLIP.length / ((DISCORD_RATE * DISCORD_CH * 2) / 1000)),
      waitedMs: Date.now() - this.stallStartedAt,
    });
  }

  /**
   * Start playback on the FIRST audio chunk, not when the response completes.
   *
   * Waiting for `response.output_audio.done` buffers the whole reply and plays
   * it in one go — measured: 211 deltas held, then 33.6s of audio at once. The
   * shim emits its "checking that now" at 0.16s and speech-to-speech synthesises
   * it separately, but the listener still heard it immediately before the
   * answer, because nothing reached the speaker until the answer existed. Every
   * upstream latency fix was being discarded here.
   *
   * A PassThrough lets the player consume audio while more is still arriving:
   * the stream stays open between chunks rather than ending, so a gap in
   * synthesis pauses playback instead of finishing it.
   */
  pushAudio(chunk) {
    // A cancelled response keeps synthesising server-side; every further chunk
    // is discarded here rather than queued. Checked before the queue concat and
    // before reportStall() so a cancelled turn neither refills the buffer
    // stopAudio() just cleared nor re-arms the stall clock for audio nobody
    // will hear. Cleared on response.done / response.created (see below), so
    // the next genuine reply plays normally.
    if (this.cancelled) return;
    this.outQueue = Buffer.concat([this.outQueue, up(chunk)]);

    // First frame of the turn: the wait is over. Reported BEFORE the guard
    // below, not after it — once the stall clip has started the pump,
    // `this.audio` is already non-null, so a guard-first ordering would skip
    // the measurement on exactly the stalled turns it exists to record.
    // Reported before the playback bookkeeping too, so the number is when audio
    // ARRIVED rather than when the player got around to starting.
    this.reportStall();

    if (this.audio) return;

    this.audio = new PassThrough();
    this.ending = false;
    this.speaking = true;
    log.debug('  voice: playback started');
    this.player.play(createAudioResource(this.audio, { inputType: StreamType.Raw }));
    // Paced writer, mirroring the input pump above. Writing chunks straight
    // through as they arrive underruns: a turn speaks a one-second filler, then
    // synthesises nothing for four seconds while tools run. The player drains
    // the stream, finds it empty, treats that as the end of the resource and
    // goes idle — after which every later write lands in a stream nobody reads.
    // Measured: the filler was heard, the answer never was, though both were
    // synthesised. Silence between utterances keeps the resource alive.
    this.outTick = setInterval(() => this.pumpOut(), TICK_MS);
  }

  /** One 20ms frame out: real audio if we have it, silence if we do not. */
  pumpOut() {
    if (!this.audio) return;
    if (this.outQueue.length >= OUT_FRAME) {
      this.audio.write(this.outQueue.subarray(0, OUT_FRAME));
      this.outQueue = this.outQueue.subarray(OUT_FRAME);
      return;
    }
    // Nothing queued. Once the turn has ended, drain the tail and close;
    // otherwise hold the resource open with silence.
    //
    // The silence is also load-bearing for the UI, which is easy to miss: while
    // a resource is live Discord shows the bot's speaking ring, so the ring
    // stays lit for the whole turn — through the pauses while tools run, not
    // only while words are coming out. That is a free "still working" signal,
    // and it is the same signal that keeps the audio alive. An optimisation
    // that skips silence during long gaps would remove both.
    if (this.ending) {
      if (this.outQueue.length) {
        this.audio.write(this.outQueue);
        this.outQueue = Buffer.alloc(0);
        return;
      }
      return this.finishAudio();
    }
    this.audio.write(SILENCE);
  }

  /** Turn is over: drain whatever is queued, then let the player go idle. */
  endAudio() {
    if (!this.audio) return;
    this.ending = true;
  }

  finishAudio() {
    clearInterval(this.outTick);
    this.outTick = null;
    try {
      this.audio?.end();
    } catch {}
    this.audio = null;
    this.ending = false;
    log.debug('  voice: playback finished');
  }

  /** Abandon playback mid-stream — barge-in, or teardown. */
  stopAudio() {
    // Barge-in and teardown both land here: either way the turn being measured
    // is over, and a clock left armed would report the next turn's audio
    // against the abandoned utterance's start.
    this.clearStallClock();
    clearInterval(this.outTick);
    this.outTick = null;
    this.outQueue = Buffer.alloc(0);
    if (this.audio) {
      this.audio.destroy();
      this.audio = null;
    }
    this.ending = false;
    try {
      this.player.stop(true);
    } catch {}
    this.speaking = false;
  }

  /**
   * Stop the reply being spoken and keep it stopped — the /cancel command.
   *
   * Deliberately separate from stopAudio() rather than a flag inside it.
   * stopAudio() means "this playback is over" and has a caller that must NOT
   * suppress the rest of the turn: barge-in reaches it from `speech_started`,
   * where the server is cancelling the generation too, and teardown reaches it
   * on the way out. Folding the flag in would make both of those swallow
   * audio they are entitled to.
   *
   * The suppression is the part that makes cancel real. `stopAudio()` alone
   * only drops what has already arrived; the response is still being
   * synthesised, and the next chunk re-opens playback (pushAudio) and resumes
   * the abandoned answer mid-sentence. `cancelled` is cleared when the server
   * reports the turn over, so the NEXT reply is unaffected.
   *
   * @returns {boolean} whether anything was actually playing.
   */
  cancelPlayback() {
    if (!this.speaking) return false;
    this.cancelled = true;
    this.stopAudio();
    return true;
  }

  /**
   * Release the session after the idle grace window, if the channel is STILL
   * empty. Called from noteVoiceState when the last human leaves; the timer is
   * cleared by cancelIdleRelease() on any rejoin or teardown. The re-check
   * at fire time is defensive — a channel that became unreadable (null) or
   * repopulated without a voiceStateUpdate reaching us must keep the session.
   */
  scheduleIdleRelease() {
    if (this.idleReleaseTimer) return; // already armed
    this.idleReleaseTimer = setTimeout(() => {
      this.idleReleaseTimer = null;
      if (this.closed || humansIn(this.channel) !== 0) return;
      log.info('voice: idle grace expired, releasing session', {
        guildId: this.guildId,
        channel: this.channelId,
        waitedMs: config.voiceIdleReleaseMs,
      });
      leave(this.guildId, 'idle');
    }, config.voiceIdleReleaseMs);
    this.idleReleaseTimer.unref?.();
  }

  cancelIdleRelease() {
    if (this.idleReleaseTimer) {
      clearTimeout(this.idleReleaseTimer);
      this.idleReleaseTimer = null;
    }
  }

  destroy() {
    // Flush in-flight utterances before tearing down, or the last thing anyone
    // said is silently lost.
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    this.cancelIdleRelease();
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    for (const userId of [...this.utterance.keys()]) this.flush(userId);
    this.closed = true;
    // Same fail-fast as connectS2S()'s reconnect hook: a pending speak() has
    // no socket to hear an ack on once the session is torn down, so it must
    // not sit out the full ack timeout for a reply that can never arrive.
    if (this.pendingSpeakFinish) this.pendingSpeakFinish({ ok: false, reason: 'no-socket' });
    clearInterval(this.pump);
    this.stopAudio(); // also destroys an open playback stream, not just the player
    try {
      this.ws?.close();
    } catch {}
    try {
      this.conn.destroy();
    } catch {}
  }
}

const sessions = new Map(); // guildId -> Session

async function join(channel) {
  leave(channel.guild.id, 'pre-join');
  const conn = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // MUST be false — the default deafens the bot and it hears nothing
    selfMute: false,
  });
  conn.on('stateChange', (o, n) => {
    log.info(`  voice: ${o.status} -> ${n.status}`);
    if (n.status !== VoiceConnectionStatus.Disconnected) return;

    // The reason is the one fact that separates a drop worth repairing from a
    // removal we cannot repair, and it was discarded here until 2026-09-25 —
    // which is why the 07:35:56Z incident could not be diagnosed after the
    // fact: "removed", "moved" and a bare socket close are indistinguishable
    // without it.
    log.info('voice: disconnected', { reason: n.reason, closeCode: n.closeCode ?? null });

    // A superseded connection must not drive anything — the same guard the s2s
    // `close` handler uses. A rejoin replaces `conn`, and the old socket's
    // teardown arrives after the new session is already live. `!session` also
    // covers the join window before the session is registered.
    const session = sessions.get(channel.guild.id);
    if (!session || session.conn !== conn) return;
    // No `leaveReason` means nobody asked to leave. That is the whole test:
    // /leave, the idle timeout and a yield all go through `leave()` and are
    // therefore exempt, and every other disconnect rejoins.
    //
    // This replaces the previous behaviour, which released the session on
    // EndpointRemoved and ignored every other reason. A server-side removal is
    // now treated like any other disconnect: the operator's contract is that
    // the assistant is present in the call unless they said otherwise, and a
    // kick or a move is not them saying so. If the channel is gone the rejoin
    // fails and is bounded by voiceRejoinMaxAttempts.
    if (session.leaveReason) return;
    scheduleRejoin(channel.guild.id, channel);
  });
  await entersState(conn, VoiceConnectionStatus.Ready, 30000);

  // Claim voice for THIS guild's conversation before the socket exists, so the
  // first utterance cannot land in whichever server was bound last. Binding is
  // deliberately not undone on leave: nothing generates spoken turns while no
  // call is live, so the only effect of reverting would be a race against the
  // `leave()` that `join()` itself performs. Leaving it pointed at the call that
  // just ended also fails in the safe direction — a straggling turn lands in the
  // conversation it was actually spoken into.
  const voiceKey = llm.voiceKeyFor(channel.guild.id);
  let bind = await llm.bindVoiceKey(voiceKey);
  // One retry, because the failure that matters here is a momentarily
  // unreachable endpoint between join and the first utterance — and the cost of
  // losing that race is spoken turns landing in another server's conversation.
  if (bind.retryable) bind = await llm.bindVoiceKey(voiceKey);

  if (bind.error) {
    log.warn('voice: session key not bound — spoken turns may reach another conversation', {
      key: voiceKey,
      error: bind.error,
    });
  } else if (bind.unsupported) {
    log.info('voice: endpoint has no /voice/bind — one shared conversation for all voice', {
      key: voiceKey,
    });
  }

  const session = new Session(
    conn,
    channel.guild.id,
    channel.guild.name,
    channel.name,
    channel.id,
    channel,
  );
  // Carried on the session so `status` can report it: a call whose key never
  // bound still works, it just answers into the wrong conversation, and that is
  // invisible from inside Discord.
  session.voiceKey = voiceKey;
  session.voiceKeyBound = !bind.error;

  // Resolve display names once so the transcript reads with names, not ids.
  for (const [id, member] of channel.members) {
    session.names.set(id, member.displayName ?? member.user.username);
  }
  sessions.set(channel.guild.id, session);
  // A voice key outlives the call it was used in, so the shim can still hold a
  // /wakephrase override an admin set in a PREVIOUS call on this guild while this
  // fresh Session starts at `wakeOverride = null`. Clearing it here is what
  // makes "no persistence across calls" true on BOTH sides rather than only the
  // bot's: without it the two disagree from the first utterance, and the
  // visible symptom is the bot showing typing dots for a turn the shim then
  // answers with silence.
  const cleared = await llm.setVoiceWake(null, voiceKey);
  if (!cleared.ok && !cleared.unsupported) {
    // Not fatal — but it is the one case where a stale override survives into
    // this call, so it must not be silent. `unsupported` is excluded on
    // purpose: a shim with no /voice/wake route has no override to clear.
    log.warn('voice: could not clear a previous call’s wake override', {
      error: cleared.error,
      voiceKey,
    });
  }
  // Same deal for transcription: the fresh Session above already starts from
  // the TRANSCRIBE env default, and clearing the shim's per-key store here is
  // what keeps the two sides from disagreeing — without it, a bare
  // `/transcribe` query in this call would report the previous call's posture
  // while the bot is writing (or not) per the env default.
  const transcribeCleared = await llm.setTranscribe(null, voiceKey);
  if (!transcribeCleared.ok && !transcribeCleared.unsupported) {
    log.warn('voice: could not clear a previous call’s transcription override', {
      error: transcribeCleared.error,
      voiceKey,
    });
  }
  // Awaited, unlike the voiceStateUpdate path: this must land BEFORE the first
  // utterance, or the opening question of a private call is judged against a
  // gate that is still armed from whatever the last call left behind.
  await syncSolo(session, channel);
  // The call is live, so any rejoin sequence that led here is finished and its
  // attempt counter must not carry into the next disconnect.
  cancelRejoin(channel.guild.id);
  // The call is live, so write it down: if this process dies from here, the
  // next one restores the call from this record (see restoreCall).
  rememberCall(channel.guild.id, channel.id);
  log.info('voice: joined', { channel: channel.name, transcribing: Boolean(session.transcript) });
  return session;
}

/**
 * Auto-rejoin sequences, one per guild: `{ attempts, timer }`. Module-level
 * rather than per-Session on purpose — a rejoin tears the session down and
 * builds a new one, so a counter living on the old Session would restart at
 * zero on every attempt and the bound would never be reached.
 *
 * Module-level mutable state is not the injected-dependency shape
 * `node/architecture/inject-dependencies` prefers, and it is kept deliberately:
 * `join`, `leave` and `scheduleRejoin` are plain module functions rather than a
 * factory, so there is no seam to inject through — and `sessions` directly
 * above already sets this pattern, with the same export-for-tests contract.
 * Threading a Map through all three would refactor the module's whole surface
 * for no test that cannot already be written: the suite clears this in
 * `beforeEach`, exactly as it does `sessions`.
 */
const rejoins = new Map();

/** End a guild's rejoin sequence. `join()` calls this once the call is live. */
function cancelRejoin(guildId) {
  const state = rejoins.get(guildId);
  if (state?.timer) clearTimeout(state.timer);
  rejoins.delete(guildId);
}

/**
 * Documented defaults for the auto-rejoin knobs, used when the env parse
 * produced something that is not a finite number. Kept here rather than in
 * config.js so that module stays pure data.
 */
const REJOIN_DEFAULTS = { baseMs: 2000, maxDelayMs: 60000, maxAttempts: 5 };

/**
 * Read a numeric config value, falling back to its default when it is not a
 * finite number.
 *
 * `parseInt('abc')` is `NaN`, and NaN propagates into BOTH halves of the retry
 * loop: `setTimeout(fn, NaN)` fires immediately, and `attempts > NaN` is always
 * false so the budget is never spent. Together those are an unbounded
 * immediate-retry loop hammering Discord — the exact class of bug this module's
 * `voiceSlotRetryDeadlineMs` comment already warns must not come back, so the
 * parse is guarded rather than trusted.
 */
function rejoinNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Backoff for the Nth rejoin attempt (1-based): doubling from
 * `voiceRejoinBaseMs`, capped at `voiceRejoinMaxDelayMs`. Split out and
 * exported so the sequence is assertable without waiting on real timers.
 */
function rejoinDelayMs(attempt) {
  const base = rejoinNumber(config.voiceRejoinBaseMs, REJOIN_DEFAULTS.baseMs);
  const cap = rejoinNumber(config.voiceRejoinMaxDelayMs, REJOIN_DEFAULTS.maxDelayMs);
  return Math.min(base * 2 ** (attempt - 1), cap);
}

/**
 * Rejoin a call after a disconnect nobody asked for.
 *
 * The operator's contract (2026-09-25): the bot leaves a voice channel only on
 * `/leave`, an idle timeout, or a yield to another identity — every other
 * disconnect rejoins the same channel. Before this, `stateChange` acted on
 * exactly one reason (`EndpointRemoved`) and released the session, and every
 * other disconnect was logged and ignored, so a dropped call stayed dropped
 * until somebody typed `/join`. That is the 2026-09-25 07:35:56Z incident: the
 * bot left, nothing rejoined, and the operator found out by speaking into a
 * channel with no bot in it.
 *
 * Backoff doubles from `voiceRejoinBaseMs`, capped at `voiceRejoinMaxDelayMs`,
 * for at most `voiceRejoinMaxAttempts` attempts. On exhaustion the session is
 * destroyed and `voice: rejoin abandoned` is logged at ERROR — a bot silently
 * absent from a call is the exact symptom this exists to remove, so giving up
 * has to be loud.
 */
function scheduleRejoin(guildId, channel) {
  const state = rejoins.get(guildId) ?? { attempts: 0, timer: null };
  rejoins.set(guildId, state);
  if (state.timer) return; // one sequence at a time
  state.attempts += 1;
  const maxAttempts = rejoinNumber(config.voiceRejoinMaxAttempts, REJOIN_DEFAULTS.maxAttempts);
  if (state.attempts > maxAttempts) {
    log.error('voice: rejoin abandoned', { guildId, attempts: state.attempts - 1 });
    rejoins.delete(guildId);
    leave(guildId, 'rejoin-abandoned');
    return;
  }
  const delayMs = rejoinDelayMs(state.attempts);
  log.info('voice: rejoining after an unrequested disconnect', {
    guildId,
    channelId: channel?.id,
    attempt: state.attempts,
    delayMs,
  });
  state.timer = setTimeout(() => {
    state.timer = null;
    // Re-resolve from the cache: the channel object captured at join time can
    // be stale after a drop, and a deleted channel must fail loudly rather than
    // rejoin something that no longer exists.
    const target = channel?.guild?.channels?.cache?.get(channel.id) ?? channel;
    if (!target) {
      log.error('voice: rejoin abandoned — channel no longer exists', {
        guildId,
        channelId: channel?.id,
      });
      rejoins.delete(guildId);
      leave(guildId, 'rejoin-abandoned');
      return;
    }
    // A rejoin is a full `join()`, deliberately: it is exactly what the
    // operator's manual `/join` did before this existed, so it rebuilds the
    // voice connection AND the s2s socket, starts a fresh transcript session,
    // and clears the per-call wake/transcribe overrides. That is heavier than
    // repairing the voice leg alone, but it reuses the one path that is known
    // to work end to end, and it is strictly better than the call staying
    // dropped. If the transcript split ever matters, that is a separate change.
    join(target).catch((e) => {
      log.error('  voice: rejoin attempt failed', { attempt: state.attempts, error: e.message });
      scheduleRejoin(guildId, target);
    });
  }, delayMs);
  state.timer.unref?.();
}

/**
 * The default location of the restart record.
 *
 * Resolved here rather than in config.js so that module stays data-only (see
 * the repo's coding guidelines). The identity is part of the filename because
 * this machine runs several identities from sibling checkouts that all share
 * `$HOME`: one shared filename would let the boss bot read the personal bot's
 * record and join a call it was never in — and then fight it for the single
 * s2s slot.
 */
function defaultVoiceStatePath(identity = config.identity) {
  const suffix = identity ? `-${identity}` : '';
  return path.join(os.homedir(), '.local', 'state', 'discord-assistant', `live-call${suffix}.json`);
}

const VOICE_STATE_PATH = config.voiceStatePath || defaultVoiceStatePath();

/**
 * The leave reasons that end a call for good: the operator asked, the channel
 * went idle, or another identity took the single s2s slot.
 *
 * Only these clear the remembered call. Every other reason PRESERVES it, and
 * `shutdown` is the load-bearing one — index.js's SIGTERM handler leaves with
 * exactly that reason, so clearing here would wipe the record on the very
 * restart this feature exists to survive. `pre-join` must also preserve it:
 * it fires at the top of every `join()`, including a rejoin, so clearing there
 * would erase the record mid-rejoin. `slot-in-use` is in the clearing set for
 * the same reason as `yield`: it is contention for the one s2s slot, and a
 * boot-time rejoin would fight the identity that won it.
 */
const CALL_ENDING_REASONS = new Set(['command', 'idle', 'yield', 'slot-in-use']);

/**
 * Write down which call this process is in, so a restart can restore it.
 *
 * A restart is not a disconnect the running code can act on — the process is
 * gone before `stateChange` can fire, and the replacement process has no memory
 * of the call. So honouring "the bot leaves only on /leave, an idle timeout, or
 * a yield" across a restart means persisting the call and rejoining from it at
 * boot (see `restoreCall`). On 2026-09-25 a `launchctl kickstart -k` deploy
 * dropped the operator's call and nothing brought it back.
 *
 * Best-effort on purpose: a failed write costs the restore, never the call.
 */
function rememberCall(guildId, channelId) {
  try {
    fs.mkdirSync(path.dirname(VOICE_STATE_PATH), { recursive: true });
    fs.writeFileSync(VOICE_STATE_PATH, JSON.stringify({ guildId, channelId }));
  } catch (e) {
    log.warn('voice: could not persist the live call, a restart will not restore it', {
      error: e.message,
    });
  }
}

/** Forget the call. Called only for the reasons in CALL_ENDING_REASONS. */
function forgetCall() {
  try {
    fs.rmSync(VOICE_STATE_PATH, { force: true });
  } catch (e) {
    log.warn('voice: could not clear the persisted call', { error: e.message });
  }
}

/** The remembered call, or null when there is none or it is unreadable. */
function readRememberedCall() {
  try {
    const parsed = JSON.parse(fs.readFileSync(VOICE_STATE_PATH, 'utf8'));
    if (!parsed?.guildId || !parsed?.channelId) return null;
    return parsed;
  } catch {
    // Absent is the normal case on a clean start, and unreadable means the same
    // thing: nothing to restore. Neither is worth a warning on every boot.
    return null;
  }
}

/**
 * Rejoin the call this bot was in when the previous process stopped.
 *
 * Called once from index.js at clientReady, deliberately AFTER the leftover
 * voice connections are evicted: that eviction removes the dead process's ghost
 * from the channel, so joining here replaces it instead of racing it.
 *
 * Never throws. A restore that cannot complete must not stop the bot from
 * starting — that would trade a missing call for a missing bot.
 *
 * The record is cleared only when the target is permanently gone. A join that
 * merely failed is left in place so the next restart can try again.
 */
async function restoreCall(client) {
  const remembered = readRememberedCall();
  if (!remembered) return null;
  const { guildId, channelId } = remembered;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels?.cache?.get(channelId);
  if (!guild || !channel) {
    log.warn('voice: not restoring the call — its guild or channel no longer exists', {
      guildId,
      channelId,
    });
    forgetCall();
    return null;
  }
  // A record outlives the call it describes whenever the process died and was
  // not restarted for a while — a laptop shut overnight, a crash left for a
  // day. Rejoining an empty channel would park the bot there holding the single
  // s2s slot until the idle timeout released it an hour later, which is exactly
  // the squatter shape that release exists to prevent. Only a definite 0 skips
  // the restore: `humansIn` returns null for an unreadable channel, and
  // skipping on unknown would let a cache that is not warm at clientReady
  // silently disable the whole feature.
  if (humansIn(channel) === 0) {
    log.info('voice: not restoring the call — the channel is empty', { guildId, channelId });
    forgetCall();
    return null;
  }
  try {
    await join(channel);
    log.info('voice: restored the call after a restart', {
      guild: guild.name,
      channel: channel.name,
    });
    return channel.name;
  } catch (e) {
    log.error('voice: could not restore the call after a restart', {
      guildId,
      channelId,
      error: e.message,
    });
    return null;
  }
}

/**
 * Leave a call. `reason` is diagnostics, not a branch: what decides whether a
 * disconnect is repaired is simply whether `leave()` was called at all. Every
 * intentional path — `/leave`, the idle timeout, a yield, shutdown — goes
 * through here, and the `stateChange` handler rejoins only when no
 * `leaveReason` was ever set.
 *
 * `pre-join` is deliberately exempt from `cancelRejoin`: `join()` performs its
 * own cleanup leave as the first step of a rejoin, and clearing the sequence
 * there would reset the attempt counter on every retry and let a
 * permanently-failing rejoin loop forever at attempt 1.
 */
function leave(guildId, reason = 'unspecified') {
  if (reason !== 'pre-join') cancelRejoin(guildId);
  // Only a call-ending reason forgets the call. Everything else keeps the
  // record so a restart can restore it — see CALL_ENDING_REASONS.
  if (CALL_ENDING_REASONS.has(reason)) forgetCall();
  const s = sessions.get(guildId);
  if (s) {
    // Set before `destroy()`: if that emits `stateChange` synchronously, the
    // handler reads this while the session is still in `sessions`.
    s.leaveReason = reason;
    s.destroy();
    sessions.delete(guildId);
    return true;
  }
  const stray = getVoiceConnection(guildId);
  if (stray) {
    stray.destroy();
    return true;
  }
  return false;
}

/**
 * Evict a voice connection left behind by a previous process.
 *
 * If the bot is killed while in a voice channel, Discord keeps showing it as a
 * participant. A fresh process has no session for it, and `getVoiceConnection`
 * only sees connections *this* process opened — so /leave reports "not in a
 * voice channel" while the bot is visibly sitting in one. Disconnecting via the
 * gateway voice state works regardless of which process opened it.
 */
async function evictGhost(guild) {
  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) return null;

  // members.me.voice reads a cache that may not be populated yet at
  // clientReady, so fall back to the guild's voice-state cache directly. A
  // ghost that is invisible to one of these is usually visible to the other.
  const channelId = me.voice?.channelId ?? guild.voiceStates?.cache?.get(me.id)?.channelId ?? null;
  if (!channelId) return null;

  const name = guild.channels.cache.get(channelId)?.name ?? channelId;
  // disconnect() goes through the gateway voice state, so it works regardless
  // of which process opened the connection.
  await me.voice.disconnect().catch(() => {});
  return name;
}

/**
 * The live transcript for a channel, if that channel's voice session is running.
 *
 * A voice channel's text chat shares the voice channel's id, so a message posted
 * there belongs in the same record as the speech — that is what lets someone
 * paste a link and then ask about it out loud.
 */
/**
 * Record arrivals and departures in the transcript.
 *
 * Two reasons beyond tidiness. A reader — human or the assistant — cannot tell
 * from speech alone who was present, so a gap in someone's contributions is
 * ambiguous between "said nothing" and "was not there". And it makes SSRC churn
 * self-evidencing: a rejoin appears in the record, so whether audio survived it
 * is visible in the file rather than only in a debug log.
 *
 * Also the moment to refresh display names. They are resolved once at join
 * (see `join` below), so anyone arriving later was previously written down as a
 * raw user id.
 */
function noteVoiceState(oldState, newState) {
  const guildId = newState.guild?.id ?? oldState.guild?.id;
  const session = guildId ? sessions.get(guildId) : null;
  if (!session) return;

  const here = session.channelId;
  const was = oldState.channelId === here;
  const is = newState.channelId === here;
  if (was === is) return; // mute/deafen/camera — not an arrival or departure

  // BEFORE the transcript guard below, and before the arrival is announced.
  // Someone walking into a private conversation must re-arm the gate on their
  // first breath, not on the first turn after it — and transcription is a
  // separate setting, so a call with `TRANSCRIBE` off still has to notice the
  // room changed. Fire-and-forget: the local flag is already correct, and
  // blocking a Discord event handler on an HTTP round-trip would delay every
  // other listener.
  const channel = (is ? newState : oldState).guild?.channels?.cache?.get(here);
  void syncSolo(session, channel);

  const member = newState.member ?? oldState.member;
  const userId = member?.id ?? newState.id ?? oldState.id;
  const name = member?.displayName ?? member?.user?.username ?? userId;

  // The call is over when the last human leaves the channel — but not at once.
  // The session (and its s2s slot) survives a brief absence for
  // `voiceIdleReleaseMs` (default 1h) so stepping away does not cost the
  // conversation, then releases if the channel is still empty — the exact
  // shape of the 2026-08-22 outage, where an idle bot starved an active one
  // for 3+ hours. A joining bot does NOT wait this out: the handover (shim
  // yield) evicts an idle holder immediately. Runs before the transcript guard
  // so it holds for calls with transcription off too; an unreadable channel
  // (humansIn null) leaves the session where it is. The departing member's
  // line is written first, while the session still exists.
  if (humansIn(channel) === 0 && !is) {
    if (userId && name) session.names.set(userId, name);
    session.transcript?.writeText(name, '(left the channel)');
    log.info('voice: left', { user: name });
    session.scheduleIdleRelease();
    log.info('voice: channel empty, scheduling idle release', {
      guildId,
      channel: here,
      graceMs: config.voiceIdleReleaseMs,
    });
    return;
  }
  // Someone rejoined (or a new human arrived) — the idle release is moot.
  if (is) {
    session.cancelIdleRelease();
    log.debug('voice: arrival, cancelling idle release', { guildId, channel: here });
  }

  // A channel MOVE is not a disconnect: discord.js follows it, so the
  // connection goes `ready -> connecting -> ready` and the `stateChange`
  // handler never sees a Disconnected it could act on. Measured live
  // 2026-09-25 — the bot sat in the channel it was moved to and nothing
  // brought it back, which the operator reads as the same defect this module
  // exists to fix. So a move out of its own channel is treated as an
  // unrequested leave and repaired by the same bounded rejoin.
  //
  // Placed AFTER the empty-channel block so a bot moved out of an EMPTY
  // channel still follows the idle-release path — nobody is there to serve,
  // and it matches `restoreCall`'s `humansIn === 0` skip. Placed BEFORE the
  // transcript guard so a call with TRANSCRIBE off is repaired too.
  //
  // `was` is implied by `!is` (line 1788 returns when they are equal). The
  // `leaveReason` check is belt-and-braces: an intentional leave deletes the
  // session, so `sessions.get` above has normally already returned.
  const botId = channel?.guild?.members?.me?.id;
  if (!is && botId && userId === botId && !session.leaveReason) {
    log.info('voice: moved out of its channel, returning', {
      guildId,
      channelId: here,
      movedTo: newState.channelId ?? null,
    });
    scheduleRejoin(guildId, channel);
  }

  if (!session.transcript) return;
  if (userId && name) session.names.set(userId, name);

  session.transcript.writeText(name, is ? '(joined the channel)' : '(left the channel)');
  log.info(`voice: ${is ? 'joined' : 'left'}`, { user: name });
}

/**
 * Count the humans in a voice channel. Bots do not count — the assistant is
 * itself a member of the channel it is listening to, so counting naively makes
 * "alone" impossible to reach.
 *
 * Returns null when the channel cannot be read, which is NOT the same as zero:
 * an unreadable room must leave the gate where it is rather than assert privacy
 * it cannot see.
 */
function humansIn(channel) {
  const members = channel?.members;
  if (!members?.filter) return null;
  return members.filter((m) => !m.user?.bot).size;
}

/**
 * Recompute whether the operator is alone and tell the endpoint what we know.
 *
 * ALWAYS POSTs, even when the channel is unreadable (`humans === null`) or the
 * new value matches `session.solo`. Pre-fix this skipped both cases, and that
 * let the previous call's solo state leak into the shim — a private call
 * ending with solo=True was still True when the next call (often a team
 * channel) joined, and the wake gate answered whatever that call's first
 * utterance said (the 2026-08-18 Brogrammers incident). Per-key state on the
 * shim makes the cross-call leak impossible; always posting here is the
 * belt-and-braces half, so the bot and the shim agree on the armed state on
 * entry to a new call, never relying on a previous call's residue.
 */
async function syncSolo(session, channel) {
  const humans = humansIn(channel);
  const unreadable = humans === null;
  // `unreadable` is treated as NOT solo, so the gate arms. The shim's per-key
  // lookup already defaults unknown keys to False, so even a missed POST would
  // fail closed; the POST here just makes sure the shim has a record of THIS
  // key being not-solo rather than relying on the default.
  // VOICE_ALWAYS_WAKE forces the armed state: solo auto-answer is the personal
  // instance's convenience, and an instance that opts out must tell the shim
  // (and its own local mirror) that the room is never solo — the shim enforces
  // the same flag independently, so a stale per-key True cannot disarm it.
  // The override replaces ONLY the always-wake term — `humans === 1` still has
  // to hold, so relaxing it can never make the bot answer unaddressed speech in
  // a room with other people. The shim applies the identical rule to its own
  // copy (`effective_always_wake`), which is what keeps the two sides agreeing.
  const alwaysWake = session.wakeOverride ?? config.voiceAlwaysWake;
  const solo = humans === 1 && !alwaysWake;
  const res = await llm.setVoiceSolo(solo, session.voiceKey);
  if (res.unsupported) {
    // The gate stays armed on an endpoint that never heard of the route, so
    // this is a note about capability, not a failure.
    log.info('voice: endpoint has no /voice/solo — wake phrase always required', {
      voiceKey: session.voiceKey,
    });
    session.solo = false;
    return;
  }
  if (res.error) {
    // The shim still holds whatever it was told last, so the two sides have now
    // drifted. Assume the armed state locally — matching what a shim that never
    // got the message is doing — rather than answering unaddressed speech.
    log.warn('voice: could not sync solo state, wake phrase stays required', {
      error: res.error,
      voiceKey: session.voiceKey,
    });
    session.solo = false;
    return;
  }
  if (unreadable) {
    // Channel.members wasn't readable at this moment (typical on /join, before
    // discord.js populates the cache). The POST still happened; the shim's
    // per-key state is correctly armed, the bot is logging the asymmetry.
    log.info('voice: channel unreadable on syncSolo — gate explicitly armed', {
      voiceKey: session.voiceKey,
    });
  }
  if (solo !== session.solo) {
    session.solo = solo;
    log.info(
      alwaysWake
        ? `voice: wake phrase forced (${session.wakeOverride === null ? 'VOICE_ALWAYS_WAKE' : '/wakephrase override'})`
        : `voice: ${solo ? 'alone — wake phrase not required' : 'not alone — wake phrase required'}`,
      {
        humans,
        voiceKey: session.voiceKey,
      },
    );
  }
}

/**
 * Set (or clear, with null) the wake-phrase override for a guild's live call.
 *
 * Both processes have to be reached, and the shim is the one that matters: the
 * bot's copy only decides whether it POSTs solo, while the shim's own
 * `effective_always_wake` is what the gate actually reads. A bot-side-only
 * change would be silently re-armed there — the "typing dots, no answer" shape.
 *
 * Order is deliberate: tell the shim FIRST, and only adopt the value locally if
 * it took. A failed POST leaves both sides on the previous value rather than
 * drifting apart, which is the same failure posture `syncSolo` takes.
 *
 * Returns `{ ok, unsupported?, error?, solo?, alwaysWake? }` — the caller turns
 * that into what the admin sees.
 */
async function setWakeOverride(guildId, value) {
  const session = sessions.get(guildId);
  if (!session || session.closed) return { ok: false, error: 'no live call' };

  const res = await llm.setVoiceWake(value, session.voiceKey);
  if (!res.ok) {
    log.warn('voice: wake override not applied', {
      error: res.error || (res.unsupported ? 'endpoint has no /voice/wake' : 'unknown'),
      voiceKey: session.voiceKey,
    });
    return res;
  }

  const previous = session.wakeOverride;
  session.wakeOverride = value;
  // Re-derive `session.solo` under the new posture and re-POST it, so the two
  // sides agree on BOTH terms of the gate and not just the one that changed.
  await syncSolo(session, session.channel);
  log.info('voice: wake override set', {
    previous,
    value,
    solo: session.solo,
    voiceKey: session.voiceKey,
  });
  return { ok: true, solo: session.solo, alwaysWake: value ?? config.voiceAlwaysWake };
}

function transcriptFor(guildId, channelId) {
  const s = guildId ? sessions.get(guildId) : null;
  return s && s.channelId === channelId ? s.transcript : null;
}

/**
 * The live `Session` whose call this channel IS, if any.
 *
 * A voice channel's integrated text chat shares the voice channel's id (see
 * `transcriptFor` above), so this is the same match used to route a typed
 * message that arrived DURING that call into it — see `Session.speak` and
 * [[Typed messages cannot be answered aloud]]. `null` for every other
 * channel (DM, thread, guild channel with no live call), which is what keeps
 * ordinary text answering unaffected.
 */
function liveSessionFor(guildId, channelId) {
  const s = guildId ? sessions.get(guildId) : null;
  return s && !s.closed && s.channelId === channelId ? s : null;
}

/**
 * Post the shim's full answer into the live voice call's channel.
 *
 * The payload that reaches here carries no channel id on purpose (see the
 * shim's `post_chat_message`) — speech-to-speech owns the voice HTTP call and
 * cannot set one, so the shim cannot know which call is live even in
 * principle. This bot can: `sessions` holds exactly the calls it is actually
 * in. Two concurrent calls is therefore ambiguous by construction rather than
 * by a missing feature, and is dropped rather than guessed at (see the task's
 * Out of Scope).
 */
async function postToChannel(text, { voiceOnly = false } = {}) {
  const live = [...sessions.values()].filter((s) => !s.closed);
  if (live.length === 0) {
    log.warn('chat bridge: no live voice session, dropping', { chars: text.length });
    return { posted: false, reason: 'no-live-session' };
  }
  if (live.length > 1) {
    log.warn('chat bridge: multiple live voice sessions, dropping (ambiguous)', {
      count: live.length,
    });
    return { posted: false, reason: 'ambiguous-multiple-sessions' };
  }
  const session = live[0];
  try {
    if (voiceOnly) {
      // Voice-only conversation (the shim's switch): the transcript keeps the
      // full answer — same write postToChannel always does — but the channel
      // stays quiet. The write and the post are deliberately NOT entangled
      // here: silencing one surface must not silence the record.
      session.transcript?.writeText(config.assistantLabel, text);
      log.info('chat bridge: wrote transcript, channel silenced (voice-only)', {
        channel: session.channelId,
        chars: text.length,
      });
      return { posted: false, reason: 'voice-only', channel: session.channelId };
    }
    for (const part of chunk(text)) await session.channel.send(part);
    session.transcript?.writeText(config.assistantLabel, text);
    log.info('chat bridge: posted to channel', { channel: session.channelId, chars: text.length });
    return { posted: true, channel: session.channelId };
  } catch (e) {
    log.error('chat bridge: post failed', { error: e.message });
    return { posted: false, reason: 'send-failed' };
  }
}

/**
 * LAST JOINER WINS: leave whatever call this process holds, on request from
 * another identity that is taking the shared speech-to-speech slot.
 *
 * Mirrors `postToChannel` deliberately — same "no channel id in the payload"
 * shape, because the caller (the shim, via this process's own chat-bridge
 * token) knows WHO is taking over, never WHICH channel. A guild with no live
 * session is success, not failure: nothing to yield is not an error, and the
 * caller must not have to know in advance whether this identity is even in a
 * call right now.
 */
async function yieldVoice(newIdentity) {
  const live = [...sessions.values()].filter((s) => !s.closed);
  if (live.length === 0) {
    log.info('voice: yield requested, holding no call — nothing to do', { newIdentity });
    return { yielded: false, reason: 'no-live-session' };
  }
  const left = [];
  for (const session of live) {
    const { guildId, channelId } = session;
    const notice = newIdentity
      ? `${newIdentity} is taking over voice here — stepping aside.`
      : 'Another identity is taking over voice here — stepping aside.';
    await session.channel?.send(notice).catch(() => {});
    session.transcript?.writeText(
      config.assistantLabel,
      `(voice: yielded to ${newIdentity || 'another identity'})`,
    );
    leave(guildId, 'yield');
    left.push(channelId);
    log.info('voice: yielded call to another identity', { newIdentity, guildId, channelId });
  }
  return { yielded: true, channels: left };
}

/**
 * Re-announce the voice binding for every live call, on request from the
 * shim that it just restarted and lost its in-memory `/voice/bind` pointer.
 *
 * The shim knows it restarted; only the bot knows which calls are live, so
 * the shim asks and the bot answers with a fresh bind per live session.
 * Mirrors `yieldVoice` deliberately — same "the caller knows WHAT happened,
 * never WHICH channel" shape, same "a guild with no live session is success,
 * not failure" contract. Idempotent: a session whose key is already bound
 * re-binds to the same key, so a shim that pings on every startup costs
 * nothing on a healthy day.
 *
 * Solo state is re-synced too: the shim's per-key solo flags live in the
 * same memory the restart cleared, so they are exactly as stale as the bind.
 */
async function rebindVoice() {
  const live = [...sessions.values()].filter((s) => !s.closed);
  if (live.length === 0) {
    log.info('voice: rebind requested, holding no call — nothing to do');
    return { rebound: false, reason: 'no-live-session' };
  }
  const rebound = [];
  for (const session of live) {
    // Same one-retry shape as `join()`: the failure that matters is a
    // momentarily unreachable endpoint racing the re-announce.
    let bind = await llm.bindVoiceKey(session.voiceKey);
    if (bind.retryable) bind = await llm.bindVoiceKey(session.voiceKey);
    session.voiceKeyBound = !bind.error;
    if (bind.error) {
      log.warn('voice: rebind failed — spoken turns may reach another conversation', {
        guildId: session.guildId,
        key: session.voiceKey,
        error: bind.error,
      });
      continue;
    }
    if (bind.unsupported) {
      log.info(
        'voice: rebind — endpoint has no /voice/bind — one shared conversation for all voice',
        {
          key: session.voiceKey,
        },
      );
    }
    await syncSolo(session, session.channel);
    rebound.push(session.guildId);
    log.info('voice: rebound live call after shim restart', {
      guildId: session.guildId,
      key: session.voiceKey,
    });
  }
  return { rebound: true, guilds: rebound };
}

module.exports = {
  join,
  leave,
  evictGhost,
  sessions,
  transcriptFor,
  liveSessionFor,
  noteVoiceState,
  syncSolo,
  setWakeOverride,
  // Exported for unit tests: "who is in the room" is the whole input to the
  // wake-gate decision, and the bot-is-a-member case is exactly the one that
  // makes "alone" unreachable if counted naively.
  humansIn,
  postToChannel,
  yieldVoice,
  rebindVoice,
  // Exported for unit tests: the leave-reason contract and the auto-rejoin
  // backoff are pure logic over `sessions`/`rejoins`, and the real triggers
  // (a Discord socket dropping) cannot be produced in a unit test — see
  // CLAUDE.md's "Verifying Voice Changes" for what still needs a live call.
  scheduleRejoin,
  cancelRejoin,
  rejoinDelayMs,
  rejoins,
  // Exported for index.js's boot path and for unit tests: the restart-restore
  // record is file I/O over a path, so exercising it needs no Discord
  // connection.
  restoreCall,
  rememberCall,
  forgetCall,
  readRememberedCall,
  defaultVoiceStatePath,
  // Exported for unit tests to exercise Session.prototype.speak against a
  // fake ws (no real audio pipeline needed) — see test/voice.test.js.
  Session,
};
