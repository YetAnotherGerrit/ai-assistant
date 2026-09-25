# ai-assistant

[![CI](https://github.com/bborbe/ai-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/bborbe/ai-assistant/actions/workflows/ci.yml)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/bborbe/ai-assistant)

One assistant that reaches an **OpenAI-compatible endpoint** from multiple surfaces — Discord (text and voice) and Google Chat — so the backend behind it can be swapped without touching the bot.

```
Discord (cloud)
   |  outbound gateway — no ingress, no tunnel
discord-assistant  (single Node service, single bot identity)
   |-- text    DM / thread    ------------------> OpenAI-compatible endpoint
   \-- voice   /join, /leave, /cancel  -> speech-to-speech -> same endpoint
```

Today that endpoint is MiniMax. Later it is a wrapper around a Claude Code session, and neither surface changes — only `OPENAI_BASE_URL`.

## Why one service

One Discord bot identity permits one gateway connection, so text and voice must live in one process. Splitting them across runtimes would need two bot _applications_ — two names, two invites — defeating the point of a single assistant. They also share the sender allowlist, which should be one list rather than two that drift.

## Status

Both surfaces work, verified end to end against a real Claude Code session:

- **Text** — DM, or `@mention` in a guild channel. A mention opens a **thread** and the conversation continues there, so follow-ups need no `@` and history stays scoped to the thread rather than to whatever else the channel was discussing. DMs stay flat — Discord has no threads in DMs.
- **Voice** — `/join` from a voice channel, talk, hear the reply. Barge-in supported.
- **Sender allowlist** on both surfaces, failing closed.
- **One conversation per surface** — each thread, DM and channel keeps its own Claude Code session. A voice channel is a single conversation covering both what is spoken and what is typed in its chat; a DM is a different one. See [Sessions](#sessions).
- **Session control** — `new`, `sessions`, `switch <id>`: start fresh, see what is bound where, or pick up a session started at the desk.

Not built yet: proactive outbound (the bot speaking unprompted, e.g. reporting a finished job), automatic session expiry, and Telegram as a second transport.

## Requirements

- Node 22+
- A running [speech-to-speech](https://github.com/huggingface/speech-to-speech) in realtime mode for the voice surface
- An OpenAI-compatible endpoint
- A Discord bot token — kept in TeamVault, never on disk

## Run

```bash
make install
cp local.env.example local.env      # gitignored; holds the TeamVault key, not the token

# text only — no speech-to-speech needed
DISCORD_TOKEN=$(teamvault-cli password <secret-id>) \
ALLOWED_USER_IDS=<your-discord-user-id> \
  make run

# add voice: speech-to-speech in realtime mode, LLM slot pointed at the same endpoint
S2S_MODE=realtime ~/Documents/workspaces/scripts/s2s-minimax
```

DM the bot to use text. `/join` from a voice channel to use voice, `/leave` to stop. `/cancel` stops the reply currently being spoken without speaking over it — it works whether or not barge-in is enabled, and replies `Nothing is playing right now.` when idle. It stops playback only: the reply is still generated server-side and still reaches the transcript.

With `SLASH_COMMAND_MODE=single` every slash command is a subcommand of one `/ben` instead — `/ben join`, `/ben status`, `/ben mode` — and `/ben` is visible to every member of the guild. Who may _use_ it is unchanged: `ADMIN_USER_IDS` is checked on every invocation in both modes.

To put Claude Code behind it instead of a hosted model, run `make shim` and point `OPENAI_BASE_URL` at it.

| Env                       | Default                           | Meaning                                                                                                                   |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`           | —                                 | Bot token (required)                                                                                                      |
| `ALLOWED_USER_IDS`        | —                                 | Comma-separated Discord user IDs. **Empty means nobody** — it fails closed on purpose                                     |
| `ADMIN_USER_IDS`          | —                                 | Comma-separated Discord user IDs allowed to use slash commands. A subset of the allowlist; **empty means no admins**      |
| `SLASH_COMMAND_GUILD_IDS` | —                                 | Guilds that get slash commands registered. **Empty means every guild**; listed guilds only, others are sent an empty list |
| `SLASH_COMMAND_MODE`      | `multi`                           | `multi`: each command top-level, Manage Server only. `single`: one `/ben` with subcommands, visible to all                |
| `OPENAI_BASE_URL`         | `http://127.0.0.1:8080/v1`        | The swappable endpoint                                                                                                    |
| `OPENAI_MODEL`            | `claude-code`                     | Model name passed through                                                                                                 |
| `S2S_URL`                 | `ws://127.0.0.1:8765/v1/realtime` | speech-to-speech realtime socket                                                                                          |
| `HEALTH_PORT`             | `8080`                            | `/healthz`, `/readiness`, `/version`                                                                                      |
| `HISTORY_LIMIT`           | `20`                              | Prior messages resent per text turn                                                                                       |

See `local.env.example` for the full set.

There is **no committed env file** on purpose. Make variables override the environment, so a committed `export DISCORD_TOKEN=` — even an empty one — silently clobbers whatever you exported in your shell. Config lives in gitignored `local.env`; `make run` fails with a pointer to the template if it is missing.

## The shim — Claude Code behind an OpenAI endpoint

`shim/claude_openai_shim.py` exposes **persistent, keyed Claude Code sessions** as `/v1/chat/completions` — one per conversation, so a turn continues where that conversation left off instead of starting cold.

### Configuring it

Optional YAML at `~/.config/discord-assistant/config.yaml` (`DISCORD_ASSISTANT_CONFIG` to move it) — see `config.example.yaml`. Precedence is **environment > file > default**, so a k8s ConfigMap or a one-off `SHIM_*` var still wins and an instance with no file behaves as it always did.

One instance, one config — no profiles. Two configurations means two deployments, which is what k8s is for. **No secrets**: this file is not gitignored, so it names TeamVault key _ids_ and the launcher resolves them.

The setting worth knowing is `claude_script`:

```yaml
claude_script: ~/Documents/workspaces/scripts/cc-personal
```

Without it the shim spawns a bare `claude`, which sees nothing outside `cwd` — so the bot could read the vault and nothing else, while a desk session launched by the same wrapper could read every repo. That gap is invisible until `switch` picks up a desk session and it can no longer open a file its own history shows it reading. Naming the launcher instead of restating its flags is how `vault-cli` avoids the same drift.

⚠️ It widens blast radius on purpose: the launcher's `--add-dir` set becomes readable by everyone on the Discord allowlist, and `cc-personal` adds `~/Documents/workspaces`. Unset by default.

### The contract

It is OpenAI-**shaped but stateful**, a deliberate deviation:

| Role            | Handling     | Why                                                        |
| --------------- | ------------ | ---------------------------------------------------------- |
| `system`        | pass through | per-request output rules (voice clients send speech rules) |
| latest `user`   | the turn     | the actual new input                                       |
| everything else | **discard**  | the session already has the history                        |

Clients resend full history per the spec; appending it to a session that already has it would double context every turn and fork into a second, divergent history. Dropping it is what lets a _stateful_ endpoint slot in under a bot written for a stateless one, with only a base-URL change.

For voice it additionally **enforces** speakable output — a session with a personal `CLAUDE.md` follows its own formatting rules (status panels, markdown, bullet lists), which are unusable as speech and which the voice prompt alone does not override.

### Sessions

The bot sends an extra-spec `X-Session-Key`; the shim maps it to a Claude Code session uuid, persisted in `~/.claude/shim-sessions.json` so the mapping outlives both processes. Locks are per key, so two threads answer at once rather than queueing.

| Surface                              | Key                   |
| ------------------------------------ | --------------------- |
| Guild thread                         | `thread:<channelId>`  |
| DM                                   | `dm:<userId>`         |
| Guild channel, un-threaded           | `channel:<channelId>` |
| Voice — spoken **and** its text chat | `default`             |

**A voice channel is one conversation.** Speech reaches the endpoint through speech-to-speech, which owns the HTTP call and cannot set a header, so every spoken turn lands on `default`; messages typed in that channel's chat are mapped to the same key deliberately. Talking and typing during a call therefore reach one session — and the session commands, which take their key from the channel they are typed in, reach the spoken conversation rather than an unused one beside it.

**Text elsewhere is separate.** A DM or a thread is its own conversation with its own history; saying something aloud and then DMing it reaches two different sessions.

Note that `default` is a single key for **all** voice, because speech-to-speech has no notion of which channel a turn came from. Two voice channels share one conversation.

Each thread is likewise its own conversation, not a view onto a shared one. An endpoint that ignores the header (any hosted model) treats every turn as stateless and relies on the resent history instead — the bot behaves the same either way.

Threading requires **Create Public Threads** and **Send Messages in Threads**. Without them the bot logs a warning and answers in the channel instead of losing the reply.

Three commands manage them, as slash commands or typed words:

| Command       | Effect                                                                            |
| ------------- | --------------------------------------------------------------------------------- |
| `new`         | Fresh session here. The old one stays on disk and the reply quotes its id         |
| `sessions`    | What is bound where, plus this cwd's recent transcripts, labelled by first prompt |
| `switch <id>` | Point this conversation at an existing session, from any working directory        |

Typed in a **voice channel's chat**, all three act on the spoken conversation — so `switch <id>` there picks up a session you started at the desk and lets you continue it by talking.

`switch` refuses three things, each with its own message: an id with no transcript anywhere under `~/.claude/projects` (otherwise `--resume` fails on the _next_ turn, far from the cause), a transcript that records no working directory (the resume cwd would be unknown, failing the same late way), and an id already bound to another key (two keys on one session file defeats per-key locking). It cannot see a session open in an interactive `claude` at the desk, since that is not in the shim's mapping — binding to one puts two writers on a single transcript.

A session started under a **different working directory** is resumed under that directory, so it continues with the `CLAUDE.md` its own history ran under rather than this identity's. That is what makes the line above true for a desk session: `--resume` resolves the transcript from the cwd it is spawned in, so the lookup has to find the file _and_ the spawn has to land where it lives.

Inspect with `status` in Discord, or `curl -s localhost:8080/v1/sessions`. The `id` is an ordinary Claude Code session id: `claude --resume <id>` opens the same conversation at the desk. Resetting is safe only because the session is a cache — the vault is the record.

## `status` — checking the legs live

`/status`, or a typed `status` / `selfcheck`. Every leg is probed rather than reported from config: "the endpoint is configured at :8080" is a different claim from "the endpoint answers", and only the second is worth reading when something is broken. Available over both transports on purpose — a diagnostic sharing a transport with the thing it diagnoses is useless exactly when it is needed.

It also names the **Claude Code session** answering the current channel:

```
🧠 claude sessions — 3 known
   • here `dm:2657…` — `b64cfb24-fa1f-4f1e-9903-48568e30d9f3`, warm, 12 turn(s), 41m
```

The id is what `claude --resume <id>` takes, so the conversation the bot has been holding can be opened at the desk. `warm` / `cold` says whether a live process is behind it — the key/id mapping is persisted and outlives the process, so a cold session answers correctly but pays a spawn first.

Against an endpoint with no `/sessions` route the line says so and the rest still works.

## Service endpoints

`/healthz` (liveness), `/readiness` (gateway connected — 503 while draining), `/version`.

Liveness deliberately ignores Discord: an outage there should drain traffic, not restart every pod into a reconnect storm.

## Three things the bridge has to get right

Each of these was found the hard way; none is obvious from the docs.

1. **Inject silence during gaps.** Discord emits audio _only while someone speaks_, but speech-to-speech's VAD closes a turn _on silence_. Without a fixed-rate ticker sending silence between utterances the turn never ends and no reply is ever generated. This is the single thing that makes the bridge work.

2. **Never send `input_audio_buffer.commit` or `response.create`.** They race the VAD-driven response and show up server-side as `speech during pending response: cancelled`.

3. **Audio arrives as `response.output_audio.delta`**, not `response.audio.delta`. The latter is what OpenAI's hosted Realtime uses and what most write-ups quote — a bot written to it receives nothing and fails silently.

## Audio conversion

Discord is 48 kHz stereo interleaved; speech-to-speech is 16 kHz mono (`PIPELINE_SAMPLE_RATE`). Note this is **not** the 24 kHz that OpenAI's hosted Realtime uses.

Naive `pcm[::3]` is wrong twice over: it walks alternating channels on an interleaved stream, and decimating without a low-pass filter aliases. The bridge mixes to mono first, then averages groups of 3 (box low-pass) going down, and linearly interpolates going up. Crude but correct in shape, and adequate for speech — no ffmpeg required.

## Gotchas

- **`selfDeaf: false` is mandatory** on `joinVoiceChannel`. The default deafens the bot and it receives nothing, silently.
- **A connection stuck in `signalling` means permissions** — even when `permissionsFor(me)` reports `Connect`/`Speak`/`ViewChannel`/`UseVAD` all `true`. Trust the state machine over the permission API, and always log `conn.on('stateChange')`; otherwise the failure surfaces as an unhandled `AbortError` with no cause.
- **Run `generateDependencyReport()` first** on any voice problem — it rules out the whole Opus/encryption class in one command.
- **Discord's portal blocks auto-generated install links for private apps.** Set Installation → Install Link → None and hand-build the OAuth2 URL; keep Public Bot off.

## Deployment

- **[docs/deploy-local.md](docs/deploy-local.md)** — macOS, launchd. Unattended: starts at login, survives sleep/wake, no terminal.
- **[docs/deploy-kubernetes.md](docs/deploy-kubernetes.md)** — coming soon. The image and manifests exist and have never been applied; that page records what is actually built and what still blocks it.

**Never scale beyond one replica** — a Discord bot identity permits exactly one gateway connection, which is why `k8s/` pins `replicas: 1` with `strategy: Recreate`. The same constraint means a cluster instance and a laptop instance cannot run at once on one identity.

## Running it

```bash
make dev                     # shim + speech-to-speech + transcriber + bot
SKIP_VOICE=1 make dev        # text surface only — starts in seconds
SKIP_TRANSCRIBER=1 make dev  # no voice transcription
```

`make dev` reuses anything already listening rather than fighting it, and waits for each port instead of sleeping a fixed time (model load is variable). Individually: `make shim`, `make run`.

| Process          | Port | Needed for                        |
| ---------------- | ---- | --------------------------------- |
| shim             | 8080 | both surfaces                     |
| speech-to-speech | 8765 | voice only (~60 s to load models) |
| transcriber      | —    | per-speaker transcripts           |
| bot              | 8081 | both                              |

The transcriber has no port, so nothing fails loudly when it is missing — the transcript file just stops growing.

## patches/

`speech-to-speech` needs one change for MiniMax (see `patches/README.md`). It lives here because that repo is a third-party clone — a `git pull` silently discards it, and the voice surface then fails in a way that looks unrelated.

## tools/

Diagnostics from the spikes that proved each leg, kept because they isolate faults the full bridge can't:

- `capture.js` — join a channel, capture one speaker, write raw 48 kHz stereo WAV. Proves voice receive with no endpoint involved.
- `to16k.py` — mono mix + `soxr` HQ resample to 16 kHz.
- `transcriber.py` — watches for voice segments and appends the speaker-labelled transcript. Dependencies are declared inline (PEP 723), so `uv run` resolves them and no speech-to-speech checkout is needed.
- `realtime_probe.py` — send a WAV to the speech-to-speech realtime socket and report every event type it emits. Proves the endpoint with no Discord involved; the reference for the protocol handling in `src/voice.js`.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
