# The transport / conversation seam

One conversation core, and every channel plugs into it. A new channel should cost an
adapter file, not a second bot.

Today the conversation is entangled with the channels: the Discord message path lives in
`src/text.js`, the Google Chat path in `src/gchat.js`, and each carries its own keying,
its own prompt assembly and its own model call. A third channel today means writing a
third copy of all three.

This note names the seam that removes the copies. It is the design half of the
extraction; the code follows it.

## What each side owns

**The core** (`src/llm.js`) owns the conversation:

- **conversation keying** — the key _scheme_: `<namespace>:<id>[:<identity>]`, and the
  `IDENTITY` rules that ride along in it
- **history assembly** — the system directive, the ordering of prior turns and the
  inbound message, and the history limit
- **the model call** — `chat()`, `X-Session-Key`, `X-Output-Mode`
- **the reply** — the assistant's answer text, returned to the caller

**A transport** (`src/index.js` + `src/text.js` for Discord, `src/gchat.js` for Google
Chat) owns only its channel:

- **receiving an event** — a gateway message, a Pub/Sub envelope, an interaction
- **resolving a conversation key** — choosing the namespace and id from its own channel
  context, using the core's scheme
- **supplying the history it can read** — a Discord channel's messages, a Chat thread's
  messages, or nothing at all
- **sending a reply** — chunking, threading, in-thread posting, and any channel-specific
  behaviour such as routing a typed turn in a live call to `speak()`

The test of the seam: **a new transport imports the core and writes no keying, no prompt
assembly and no model call.**

## The interface

```js
// src/llm.js — the conversation core
async function converse({ sessionKey, history = [], text, signal }) -> string
```

- `sessionKey` — resolved by the transport, from its own channel context
- `history` — prior turns the transport could read from its channel; `[]` when it can
  read none (Google Chat sends none today)
- `text` — the inbound message
- returns the reply text, which the transport sends

The core applies the system directive, assembles the prompt, calls `chat()` with the
session key, and returns the answer. It never learns which channel it is serving.

Resolving the key stays the transport's job, but the _scheme_ moves into the core:

```js
// src/llm.js — the key scheme, one implementation
function conversationKey(namespace, id) -> `${namespace}:${id}[:${config.identity}]`
```

Discord resolves `thread:`/`dm:`/`channel:` from its channel object and `voice:` from its
guild; Google Chat resolves `gchat:<spaceId>_<threadId>`. Both call the core's constructor
rather than building the string themselves.

## What must not change

The extraction is behaviour-preserving. In particular:

- **The keyspaces stay exactly as they are, and stay disjoint.** Discord's
  `thread:`/`dm:`/`channel:`/`voice:` and Google Chat's `gchat:` must not collide, and
  the `IDENTITY` suffix rules must reproduce today's keys byte for byte — a changed key
  is a different conversation, and every existing session is lost silently. Note the
  asymmetry to preserve: `textKeyFor`/`voiceKeyFor` omit the identity segment when
  `IDENTITY` is unset, while `gchatSessionKey` always emits three segments
  (`gchat:<spaceId>_<threadId>:<identity>`, identity possibly empty).
- **The backend stays swappable.** Nothing in the core may depend on which backend is
  behind `OPENAI_BASE_URL`.
- **Google Chat stays off unless enabled.** `GCHAT_ENABLED` still gates the transport; a
  Discord-only process must behave exactly as before.
- **The live-call routing stays in the transport.** Whether a typed turn is answered in
  text or routed to `speak()` is channel behaviour, not conversation behaviour.

## Where each piece moves

| Today                                                                 | After                                                                                                                             |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/text.js` — `sessionKeyFor`, `history()`, `chat()`                | transport keeps the message handler, chunking and the speak routing; keying, history assembly and the model call move to the core |
| `src/gchat.js` — `gchatSessionKey`, `chat()`, inline system directive | transport keeps the Pub/Sub pull, envelope parse and `postChatReply`; keying and the model call move to the core                  |
| `src/index.js` — five `sessionKeyFor` calls in slash-command handlers | handlers call the core's key scheme; no conversation logic in the wiring                                                          |
| `src/llm.js` — `chat()`, `sessionKeyFor()`, `voiceKeyFor()`           | grows into the core: `converse()` and `conversationKey()` join the engine it already holds                                        |
