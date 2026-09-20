# Changelog

All notable changes to this project will be documented in this file.

Please choose versions by [Semantic Versioning](http://semver.org/).

- MAJOR version when you make incompatible API changes,
- MINOR version when you add functionality in a backwards-compatible manner, and
- PATCH version when you make backwards-compatible bug fixes.

## Unreleased

- feat: an authenticating gateway (nginx, launchd component `gateway`) now fronts speech-to-speech, and is the only `0.0.0.0` bind in the stack. s2s has no incoming-client auth of its own — `create_app()` in `websocket_router.py` takes only `pool`, `stop_event`, `llm_proxy_config`, no auth parameter and no middleware, leaving five routes unauthenticated (`/v1/realtime`, `/v1/usage`, `/v1/pool`, `POST /v1/realtime/calls`, `DELETE /v1/realtime/calls/{id}`); upstream's own `llm_proxy.py` docstring names the fix ("designed to run on a trusted network or behind a gateway that owns access control"). The gateway listens on `0.0.0.0:8766`, proxies to `127.0.0.1:8765`, and refuses with 403 unless the `?token=` query param matches. A query param rather than a header because `src/voice.js:469` opens the socket as `new WebSocket(config.s2sUrl, { maxPayload: 0 })` with no headers option, so a URL token is the one channel available without editing the bot's connection code — `config.js:70` already reads `S2S_URL` from the environment, making this a config change rather than a code change. The token resolves from `S2S_GATEWAY_TOKEN_KEY` in TeamVault, independently in both the gateway and the bot, so neither component can read the other's copy. `proxy_buffering off` is load-bearing, not tuning: nginx buffers proxied responses by default, and buffering holds audio until a turn completes, silently discarding every upstream latency win — the same failure already measured at 211 deltas held then 33.6s dumped at once.
- feat: the gateway fails closed at three layers, because a gateway that starts without a token is worse than one that does not start. The launcher refuses to start when `S2S_GATEWAY_TOKEN_KEY` is unset (via `die_config`, so launchd's `KeepAlive/SuccessfulExit=false` leaves the job stopped rather than respawn-looping); the rendered config is verified to contain the token before nginx is started, and the render is checked for unsubstituted placeholders — `envsubst` is restricted to an explicit `$RUNTIME_DIR $S2S_GATEWAY_TOKEN` list, since a bare `envsubst` would also consume nginx's own `$arg_token`, `$http_upgrade` and `$remote_addr` and silently render them empty; and the `map` resolves to `deny` for every request when the expected token is empty, because no real request carries an empty token. The rendered config embeds the secret, so it is written `0600` to `~/.local/share/discord-assistant/` — a runtime artifact outside the repo, never a tracked file.

## v0.46.1

- fix: a `~/…` path in the config is now expanded, so the peer relay's inbox is actually found. `relay_dir` was read straight from the config, and `Path("~/x")` is a RELATIVE path naming a directory literally called `~` — so the relay shipped in v0.46.0 was silently inert for anyone writing the path the way `config.example.yaml` writes every path. Found at deploy, reading the live config back, not by any test: every relay test injects a real temp path, so none of them could fail on it. `TRANSCRIPT_DIR` had the same latent bug and is fixed with it. The fix also preserves empty as empty — `Path("").expanduser()` is `"."`, so expanding unconditionally would turn an unset transcript dir into the current directory and arm the transcript directive with a bogus path.

## v0.46.0

- feat: a peer session's answer can now reach a voice call as a FILE, because a peer message cannot reach it at all. A shim session registers as `entrypoint: sdk-cli` — the only such session in a 28-session fleet, measured 2026-09-20 — and every `SendMessage` to it fails with a bare "Failed to send" while its socket, its process and its registry entry all read healthy; the socket even accepts a raw write. The failure therefore misdiagnoses itself as a wedged peer, and did: in a live call the assistant said "Asked — it'll come back with a yes or no", the peer answered four times, and the human heard nothing for two hours. Both sides already share a filesystem, so `relay_dir` gives a peer somewhere to write: the shim claims every `<relay_dir>/inbox/*.answer.json` at the next turn and puts it at the FRONT of that turn's prompt, which is what makes the answer speakable — prefixed to the user's turn rather than injected as its own message, since a peer turn is exactly what the mute gate suppresses. Claiming is an atomic rename to `*.answer.json.done`, so two readers cannot both take one reply; an unparseable file is left in place rather than deleted, because silently dropping a peer's message is the failure this path exists to prevent. The assistant is told the inbox path and that a relay promise with nowhere for the answer to land is one it cannot keep. Voice-only, like the transcript directive, and inert when `relay_dir` is empty.

## v0.45.7

- fix: `switch` now finds a session started under a different working directory, and resumes it there. `bind_session` gated on a transcript in the key's OWN project directory — the one `transcript_dir()` derives from the identity's cwd — so an id from anywhere else read as "no transcript" while the file sat one directory over. Observed 2026-09-12: `switch be8fae09-…` refused mid-call against a transcript written two minutes earlier; the personal identity's cwd had moved to `PersonalAssistant` on 2026-09-03, which orphaned 1349 desk transcripts from the switch path against 6 in the new directory. Widening the lookup alone would have been worse than the bug: `claude --resume` resolves the transcript from the cwd it is spawned in, so a bind that merely found the file would pass the gate and fail on the NEXT turn — exactly the late failure the gate exists to prevent. The session record therefore carries the owning cwd — read out of the transcript rather than decoded from the project directory name, since the slug replaces separators with dashes and a real path containing one cannot be decoded back — and the spawn resumes under it. Three refusals now name three different causes: absent everywhere, present but with no readable cwd, and already bound to another key.

## v0.45.6

- fix: the peer-turn gate is now anchored at the point the turn began, so it no longer mutes every turn. v0.45.5 started the transcript scan at byte 0, so the FIRST turn read the whole history and tripped on any origin entry already in the file — one `task-notification` from days earlier was enough — and the gate then muted every turn for the life of the process. Observed live 2026-09-19: the assistant went completely silent mid-call, every turn logging `non-voice turn appeared in the transcript — muting the rest of this turn`. An entry written before the turn is history, not interference; only one written DURING the turn can be a peer message injected into it. Two tests pin it: history must not mute the turn, and a genuine mid-turn injection must still be caught.

## v0.45.5

- fix: a cross-session message injected into a live call is no longer spoken as the answer to the human's question. The shim drives one long-lived `claude` process per session key and reads ONE stream from it, so a peer turn injected mid-turn lands interleaved with the spoken turn's events — the peer's reply was voiced, and the human's own answer arrived late, as if replying to whatever was said next. Observed 2026-09-13 14:27Z: a peer's nuke-status reply was spoken into a call in place of the user's open-tasks question. The origin marker exists only on the USER entry in the session transcript (`origin.kind` is `peer` for a cross-session message, `task-notification` for an internal notice, absent for a turn the human spoke) — the stream carries nothing, and `--replay-user-messages` cannot help because it echoes only what the shim writes to stdin. The shim now watches that transcript for the duration of a turn and mutes the rest of the turn when a non-voice turn appears, re-reading synchronously before the turn's first utterance so the watcher's polling window cannot leak text. The muted reply still reaches the chat bridge and the transcript; only the speaker is gated. The transcript is read in binary mode with byte offsets — the real transcript holds raw UTF-8 (1942 literal em-dashes in one 1.5 MB session), and seeking a byte offset on a text-mode handle snaps to a character boundary and accumulates a corrupt offset that runs past the end of the file, after which every poll sees nothing and the gate silently never arms. Caught in review by a test that asserts the offset is a real byte position, not just that detection succeeded.

## v0.45.4

- fix: a session whose transcript already exists is now treated as started, so a first turn that times out no longer wedges the key into re-issuing `--session-id` against an existing transcript and dying on every retry
- fix: a dead claude's stderr is kept and reported, so the failure carries the real cause instead of a bare `claude process ended`

## v0.45.3

- fix: the shim's no-tool filler now fires at 5.0s instead of 8.0s, so it reaches the wire before the bot's own stall clip. Both timers defaulted to 8.0s in separate processes; on a turn where the agent took >8s to emit its first tool_use they fired together and the BOT's clip won the tie — telling the user the assistant was "still getting the audio ready" while it was in fact working. Measured live 2026-09-17: four of six turns reached the no-tool path, so it is not the rare case the old comment assumed. A test now pins the cross-process invariant — `shim.HOLD_MAX` must stay below the bot's `voiceStallThresholdMs` — which nothing in either file expressed before.

## v0.45.2

- chore: the shim's per-turn line now carries a wall-clock UTC stamp — `  [voice:…] 2026-09-16T21:40:08.345Z 4.0s, 344 chars`. Its duration is measured on `time.monotonic()`, which shares no origin with the ISO timestamps the bot writes, so the duration existed but could not be placed on a turn; that is what left a stalled turn unattributable to a stage. `start + duration` now brackets the LLM stage against the bot's `mic turn start-to-audio` line, leaving VAD+STT and TTS+transport as the two remainders. A test pins the stamp's shape against the one the bot writes and asserts `ask_claude` actually emits it — a stamp that is computed and never printed correlates nothing.

## v0.45.1

- docs: the `Verifying Voice Changes` section now covers the shim's spoken-output path (`shim/claude_openai_shim.py` — truncation, fillers, the `_MORE_LINE` tail) and says to check the running config before diagnosing spoken output: `voice.spoken_max: 0` in `~/.config/discord-assistant/config.yaml` disables truncation outright, so a missing tail line is config, not a code regression.

## v0.45.0

- feat: `/cancel` slash command — stops the reply currently being spoken without speaking over the assistant. Unlike the barge-in path it is not gated on `INTERRUPT_RESPONSE`, so it works with barge-in turned off; it stops playback only, so the reply is still generated server-side and still reaches the transcript.

## v0.44.0

- fix: `/mode` drops the `on`/`off`/`default` aliases — its three named states (`voice-only`, `voice-text`, `text-only`) are the whole value space. An `off` was ambiguous on a command that sets a pair of flags (stop posting? stop speaking?), and the default is reachable by naming `voice-text`. The bare query form stays.

## v0.43.0

- fix: `/wakephrase auto` is removed — `default` is the only clear spelling. The legacy `auto` value is rejected by the handler and every shim route (`/voice/wake`, `/voice/barge`, `/voice/transcribe`, `/chat/posting`, `/mode`); `default` (and the `clear` header synonym) clears the per-key override.

## v0.42.0

- feat: the four per-conversation flag toggles now speak one uniform on/off/default contract — `/wakephrase`, `/interrupt` and `/transcribe` offer `on`/`off`/`default` (the old `/wakephrase auto` stays accepted as a legacy spelling), and `/mode` gains `on`/`off`/`default` aliases on top of its `voice-only`/`voice-text`/`text-only` states, plus a bare query form that reports the current mode. `default` CLEARS the per-key override on every route (`/voice/wake`, `/voice/barge`, `/voice/transcribe`, `/chat/posting`, `/mode`) so the configured default is in force again — previously `/interrupt off` and `/transcribe off` were sticky until restart. The shim setters pop on a clear value (mirroring `/voice/wake`), and the `/voice/state` back-edge shows the cleared field restored.

## v0.41.2

- fix: `/mode text-only` still spoke, through two paths the v0.41.0 gate did not cover. The bot's stall filler fired on EVERY text-only turn — the shim never sends audio in this mode, so the 8s "no audio yet" threshold always crossed, and the 2.7s clip played AFTER the answer had already been posted to the channel (observed live 2026-09-11: chat post 15:38:22, clip 15:38:26). It is now gated on the shim's speech posture, re-read per utterance at stall-clock start so a `/mode` flip lands without the bot keeping a second copy of the mode; a failed probe fails open, leaving the filler speaking rather than silently muting it in every mode. Separately, the shim's holding and progress fillers called `on_text` DIRECTLY, bypassing the `push()` guard, so any slow or tool-using turn still said "checking that now" aloud — the guard now sits in `on_text` itself, the function that writes the wire, so a filler added later cannot reintroduce the leak. `voice: stall — no audio yet` now carries `speechOff`, so a text-only crossing reads as the mode working rather than as a fault.

## v0.41.1

- fix: `tools/make-stall-clip.py` no longer re-scales the TTS output — the Qwen3 handler already converts to int16 before yielding, so the script's extra `clip(-1, 1) * 32767` clamped every sample to full scale and rendered a harsh, ~5×-too-loud square wave. Heard in a live call before it was caught; the giveaway was in the first measurement, where the peak read _exactly_ 1.000 full scale. The clip is regenerated (crest factor 15.8 dB, no samples at full scale) and the script now refuses a non-integer chunk dtype and prints the peak on every run.
- fix: the stall filler is now written to the call transcript, under the assistant's label — the clip is raw PCM written straight to the audio pump, so it never passes through the TTS path and nothing wrote it down. The shim's `_PROGRESS_LINES` fillers reach the transcript by riding `response.output_audio_transcript.done`; without this the stall filler was the one thing said in a call that the record omitted. The text is read from `src/stall-clip.txt`, which `tools/make-stall-clip.py` writes beside the PCM, so the spoken line and the recorded line cannot drift apart.

## v0.41.0

- feat: `/mode text-only` — a third mode that posts the full answer to the channel and never speaks. The mode is a PAIR of per-key shim flags written together by one `POST /mode` route, because `text-only` is chat-on + speech-off and two independent setters would make (chat off, speech off) reachable — the state where the user gets nothing at all, and nothing in Discord shows it. Spoken output is gated at the shim's single text-to-wire choke point, so the chat post is untouched; the front-tier filler is suppressed under the same flag. In text-only the chat post is forced unconditionally: the four bridge triggers all infer from a spoken reply that no longer exists, so a short plain question would otherwise be answered nowhere. The spoken "don't write in the chat" instruction is refused in text-only (it would reach the illegal pair) and "write in the chat again" clears the mode. `/status` reports the mode by name, and reads an older shim without the new field as voice-text rather than text-only.
- feat: measure and log the mic turn's stall — the bot now handles `input_audio_buffer.speech_stopped`, the earliest signal it receives that an answer is owed, and logs the gap from there to the first audio frame on every spoken turn (`voice: mic turn start-to-audio`), flagging it `detected` once it crosses `VOICE_STALL_THRESHOLD_MS` (default 8000). Warm turns run ~5.7s end-to-end and the cold-start-after-idle stall measured 25.6s, so the threshold sits between them; an unaddressed utterance is disarmed at the transcription verdict rather than narrated.
- feat: speak a cached filler into a stalled turn — once the gap crosses the threshold the bot plays `src/stall-clip.pcm` (rendered by `tools/make-stall-clip.py` from the same Qwen3 CustomVoice "Aiden" model the launcher resolves to) straight into its raw-audio pump, bypassing the LLM and the TTS entirely, because those are the stages that are slow. The clip is queued ahead of the answer, so the answer waits for it only when it arrives mid-clip (~2.8s bound) and not at all on the long stalls this exists for; a missing clip logs a warning and leaves stalls silent rather than failing the boot.

## v0.40.1

- fix: `/status` drops the per-flag ✅/❌ from the three toggle lines, leaving the label icon as the only glyph — `👂 wake: off (default)` rather than `👂 ❌ wake: off (default)`. The tick was doing work the name and value already did, and it made these three lines a different shape from every other line in the report. The split into one line per toggle, and the icons themselves, are unchanged.

## v0.40.0

- feat: `/status` gives each shim-owned toggle its own line, prefixed by an icon naming what it governs — `👂 ✅ wake: …`, `💬 ✅ posting: …`, `✋ ❌ interrupt: …` replace the single `⚙️ … · … · …` run-on line, so each state is scannable without parsing a joined string and `interrupt: off` reads as the effect it names rather than a bare flag. The per-flag ✅/❌ ticks are unchanged. The degraded `⚙️ toggles — shim state unavailable` line keeps its group icon, there being no per-toggle states to prefix.

## v0.39.1

- fix: `/status` toggle line gives each flag its own ✅/❌ tick — the grouped `⚙️ wake/posting/interrupt` line previously carried no per-flag icon and read differently from every other ticked status line (transcription, gateway, endpoint).

## v0.39.0

- feat: `/status` shows the state of every runtime per-conversation toggle, not just transcription — a new `⚙️ wake: … · posting: voice-text|voice-only · interrupt: on|off` line reads the shim's per-key stores via a new unauthenticated GET `/voice/state` (observe-only, matching the control-auth rule), so a mid-call `/interrupt off` or `/mode voice-only` is visible at a glance; idle, the shim answers an unknown key with its defaults, what the next call starts with. Also adds the first `status.test.js` smoke tests.

## v0.38.0

- feat: `/status` replaces the `transcripts — writable` line with the transcription state — `transcription: enabled|disabled` (live posture during a call, `TRANSCRIBE` default marked `(default)` when idle), so "are we being written down?" is answerable from the status line; the writable check survives only as a failure suffix so a broken transcript dir stays diagnosable.

## v0.37.0

- feat: `/status` names the transcription posture for each live voice session — `(transcribing)` when the call is written down, `(transcription off)` when the `TRANSCRIBE` default was off at join or an admin ran `/transcribe off` mid-call, so the toggle's effect is readable in the status line without a separate bare `/transcribe` query.

## v0.36.1

- fix: shim control-route refusals are now logged, not silent — an unset `CHAT_BRIDGE_TOKEN` prints `control route: CHAT_BRIDGE_TOKEN not set — refusing every mutating route` and a wrong/missing token prints `control route: missing or wrong token — refused` (mirroring the chat-bridge guard's "not set — skipping post"), so a fail-closed shim is diagnosable from `shim.log` instead of indistinguishable from a broken route.

## v0.36.0

- feat: add `/transcribe on|off` slash command to toggle transcription mid-call, per conversation, without restarting the bot — the last env-only knob in the runtime-toggle family. The shim holds a per-key store behind an authenticated `/voice/transcribe` route (bare invocation is the query form); the bot mirrors the state into the live call's session, where it gates every transcript write. A fresh call falls back to the `TRANSCRIBE` env default.

## v0.35.3

- fix: require `CHAT_BRIDGE_TOKEN` on every shim route that mutates state — `sessions/reset`, `sessions/bind`, `voice/bind`, `voice/solo`, `turns/typed`, `chat/completions` (and the three already-guarded admin routes `/voice/wake`, `/chat/posting`, `/voice/barge`) now share one fail-closed check at the top of `do_POST`. GET routes stay open. The bot sends the control token on all mutating routes (was `OPENAI_API_KEY`, whose default is the literal `not-needed`), and the launchd launcher resolves the token for the s2s component too, since `speech-to-speech` reaches the shim's `/chat/completions` directly.

## v0.35.2

- fix: transcript speaker label for the bot's own lines is now the `IDENTITY` when set (e.g. `personal`/`sc`/`boss`), so two identities sharing one channel are distinguishable from the transcript alone; falls back to `BOT_NAME`/`Assistant` unchanged when no `IDENTITY` is set.

## v0.35.1

- fix: `scripts/s2s-minimax` realtime mode passes `--host`/`--port` instead of the removed `--ws_host`/`--ws_port` — upstream speech-to-speech renamed the websocket bind args in `RealtimeServerArguments`, and the old names made s2s fail to start after a fork/main merge.

## v0.35.0

- feat: log progress-line emission in the shim with a monotonic timestamp — `shim.log` now shows when a spoken filler was actually handed to the voice path, so "generated but swallowed" and "never generated" are distinguishable on a slow turn (was indistinguishable before; the emission is keyed like the other `[key]` lines).

## v0.34.1

- fix: when the gateway reaches `ready` with zero guilds cached, log a warning (previously registration silently skipped) and report readiness 503 until the bot holds a guild — the hardening for the stale slash-command list that hid for a week behind a rejected gateway intent.

## v0.34.0

- feat: document the `bro` identity in `config.example.yaml` (cwd BrogrammersAssistant runtime vault, cc-discord-assistant-bro launcher, chat bridge on :8131) — the 5th laptop-hosted discord-assistant identity.

## v0.33.0

- feat: the runtime barge-in toggle is now `/interrupt` (renamed from `/bargein`, v0.32.0) — same per-conversation `on|off` semantics and `/voice/barge` back-end, same bare-query form; user-facing log lines now read `-> INTERRUPT [key] …` and `listener gone — interrupt OFF, answer continues`.

## v0.32.1

- fix: in voice-only mode a truncated reply no longer says "The details are in the chat." — the shim's `_MORE_LINE` pointed the listener at a channel that was deliberately silenced, so the spoken tail now names the transcript instead (`The details are in the transcript.`), driven by the same per-conversation `chat_off` flag the chat bridge already reads. Chat-posting mode is unchanged.

## v0.32.0

- feat: `/bargein` toggles barge-in cancellation at runtime per conversation — with it off, the listener speaking mid-turn no longer ends the in-flight answer (`listener gone — interrupting turn` → `0 chars`); the turn runs to completion and the full answer still reaches the chat bridge/transcript. The flag lives on the shim (`/voice/barge`, keyed per conversation like the voice-only switch), is flipped from Discord via the new admin slash command, logs on flip (`-> BARGE IN [key] …`), and defaults to `on` (today's cancellation) until a smarter heuristic has a baseline. Voice-only: the command is not registered on text-only instances.
- feat: supervised memory ceiling in the launchd launcher — `scripts/launchd-run.sh` now samples each component's `phys_footprint` (never `ps` RSS, which reads ~20× low for MPS/MLX) on an interval, TERMs a component past its per-component cap so launchd restarts it fresh, and pushes every sample to the nukeprod pushgateway (`ai_assistant_phys_footprint_bytes`). Defaults: s2s 12 GB, transcriber 4 GB, shim/bot 2 GB; override via `MEMORY_CAP_MB_<component>` in `local.env`. Telemetry is off unless `PUSHGATEWAY_PASSWORD_KEY` is set and never takes the ceiling down. The cap cannot be a plist key — `ResidentSetSize`/`RLIMIT_RSS` is a documented no-op on macOS — so the bound lives in the supervisor.

## v0.31.2

- fix: the `sc-assistant` ServiceAccount now sets `imagePullSecrets: [docker]` — its pods pull from `docker.prod.nuke` and carried no pull credentials at all, which works only while that registry allows anonymous pulls. The `docker` secret is already present in the `star-citizen` namespace in both clusters (replicated by kubernetes-reflector), so this references an existing secret rather than creating a dangling one

## v0.31.1

- fix: a failed voice-command reply no longer crashes the bot — a Discord rejection (e.g. missing Read Message History) previously escaped the text handler, hit the unhandledRejection exit, and the launchd restart's ghost-eviction dropped the voice connection, making `/join` appear to work while `/leave` always failed

## v0.31.0

- Add optional Google Chat transport — Pub/Sub subscriber + Chat API in-thread replies behind the `GCHAT_ENABLED` gate, sharing the shim session engine with Discord (`gchat:` session keys, disjoint from Discord's)

## v0.30.1

- chore: `make apply` renders secrets through `teamvault-cli config parse --cache`, so a TeamVault outage no longer blocks a deploy — the disk fallback (`~/.teamvault-cache`) serves the last-cached value on remote error instead of failing the render.

## v0.30.0

- chore: repo renamed `bborbe/discord-assistant` → `bborbe/ai-assistant` (Google Chat transport made it multi-surface; old URL redirects). Docker image name unchanged.
- fix: the `discord-assistant` k8s Secret manifest now lists ALL five keys (`DISCORD_TOKEN`, `VAULT_GIT_KEY`, `ADMIN_USER_IDS`, `ALLOWED_USER_IDS` + `ROUTER_API_KEY`), each resolved from TeamVault at `make apply` time. The v0.29.2 ROUTER-only version was destructive: `kubectl apply` on an apply-owned Secret deletes data keys absent from the new config, so applying it wiped the other four keys from both live clusters (shims stuck in `Init:0/1` until the Secret was restored). A partial secret manifest is now rejected by design — every live key must be in the file.

## v0.29.2

- chore: create the `discord-assistant` k8s Secret from a committed templated manifest — `ROUTER_API_KEY` now resolves from TeamVault (deploy env files hold only the lookup key), so the Secret is reproducible instead of hand-applied out-of-repo.

## v0.29.1

- fix: the voice-only mode change now reaches the model as in-context FACT, not only as a swapped directive. A directive alone loses to in-context precedent (the hub page's documented lesson) — observed live: after the flip the model kept saying "the details are in the chat" into a silenced channel. The shim now prepends a mode note to the prompt on every silenced turn (and announces the return on the turn that flips back), so the statement sits in the session history the model reads, without resetting the conversation.

## v0.29.0

- feat: `/mode` slash command as a second surface for the voice-only switch — `/mode voice-only` silences chat posting for this conversation, `/mode voice-text` turns it back on (the default). Same per-key flag the spoken "don't write in the chat" instruction flips, set via a new bot→shim `/chat/posting` route mirroring `/voice/solo`; both surfaces drive one state, so a mode set by voice shows up in `/mode` and vice versa.

## v0.28.0

- feat: admin `/wakephrase on|off|auto` toggles the wake-phrase requirement for the live call at runtime, no restart. `VOICE_ALWAYS_WAKE` stays the default; the command overrides it per voice key. Reaches both processes — a new sticky `/v1/voice/wake` route sets a tri-state override on the shim (`effective_always_wake`), and the bot re-derives `session.solo` under the new posture — so the shim's own always-wake term cannot silently re-arm what the bot just relaxed. `auto` clears the override back to the env default; the override is in-memory and per-key, so a restart falls back to the configured default and nothing leaks across calls. Invoking `/wakephrase` bare reports the current posture without changing it. Admin-gated by `config.isAdmin`, not by command hiding.

## v0.27.1

- fix: the shim's startup rebind notify now runs after its HTTP server is constructed (from a daemon thread), not before it serves. Notifying first made the very first restart after deploy race the fix: a bot with a live call received the ping and immediately POSTed its re-bind back to `/voice/bind` while the shim was still in the notify loop and not yet listening — `fetch failed`, and the call stayed deaf. Found by live verification of v0.26.1 (bot log `voice: rebind failed — ... fetch failed` on a real call).

## v0.27.0

- feat: voice-only mode — saying "don't write in the chat" silences chat posting for the rest of that conversation (per session key, never global); the opposite instruction turns it back on. The full answer still reaches the transcript either way, so silencing the channel loses nothing. The switch is recognized code-side in the shim (`_apply_chat_switch`, mirroring the existing chat-request regex) and carried to the bot as a `voiceOnly` flag on the bridge payload; the bot writes the transcript and skips `channel.send`. The model's chat-bridge directive is swapped for a voice-only inverse so it stops claiming the details are in the chat while the channel is silenced.

## v0.26.1

- fix: a shim restart no longer silently kills a live Discord voice call. The shim's in-memory `/voice/bind` pointer reset to `default` on every restart, so the first spoken turn of any call that survived the restart classified against the wrong key and the wake gate rejected it — the bot looked healthy, `/readiness` stayed 200, and the only cure was leaving and rejoining. The shim now POSTs `/voice/rebind` to each bot it serves at startup (same chat-bridge auth as `/voice/yield`), and the bot re-announces the bind for every live call — no polling, one push per restart, idempotent.

## v0.26.0

- chore: `CHAT_BRIDGE_TOKEN` is resolved from TeamVault like every other secret, via a new `CHAT_BRIDGE_TOKEN_KEY` key id. It was the one documented exception to "local.env holds no secrets, only key ids" — which meant a real shared secret sat in every checkout of a public repo. The per-component split is unchanged in effect and stronger in mechanism: `bot` and `shim` resolve it (they authenticate to each other with it), while `s2s` and `transcriber` never fetch it at all rather than receiving it and having it unset afterwards. The launcher unsets any inherited value first, so a literal left in a shell or a stale `local.env` cannot silently defeat either rule. `scripts/dev.sh` resolves it once up front — without that, a dev run would quietly stop posting spoken replies to the channel, since the bridge fails closed on an empty token. A half-migrated `local.env` (literal still present, key id missing) warns loudly on start instead of disabling the bridge in silence.

## v0.25.1

- chore: widen the `local.env` ignore rule to `local.env*`. Only the exact name was ignored, so sibling env files an operator creates alongside it — `local.env.prod`, a `local.env.<something>.bak` — were untracked but stageable in a public repo, and they carry the real `CHAT_BRIDGE_TOKEN` and `ROUTER_API_KEY` rather than TeamVault key ids. Nothing had been committed (the tracked `local.env.example` holds a placeholder); this closes the path before it is.

## v0.25.0

- feat: two-tier access for the Discord surface. `ADMIN_USER_IDS` gates the slash commands (`/status`, `/new`, `/sessions`, `/switch`, and `/join`/`/leave` when voice is on) while `ALLOWED_USER_IDS` keeps gating the @mention surface, so guests can talk to the bot without reaching session control. Every command is registered with `setDefaultMemberPermissions(ManageGuild)` so Discord hides it from ordinary members, with an `isAdmin` check behind it because hiding is a client affordance and not authorisation. New `SLASH_COMMAND_GUILD_IDS` withholds commands from named guilds entirely — needed where the operator is an ordinary member and permission-gating would hide the commands from them too. An unset `ADMIN_USER_IDS` inherits `ALLOWED_USER_IDS`, so existing deployments keep their slash commands; set it explicitly to opt into the tighter tier, or empty to mean no admins.

## v0.24.0

- feat: Star Citizen deployment manifests — dedicated `star-citizen` namespace with default-deny NetworkPolicy (DNS, Discord gateway, same-namespace, shared router only), ServiceAccount, private-registry image pull, and a vault mount (PVC + git clone init + vault-sync sidecar) for the SC assistant. Dockerfile adds `git` for the vault sidecar.

## v0.23.0

- feat: `/sessions` now lists every conversation active in the last two days (not just the newest eight), labels each entry with its session name when one is set (falling back to the first prompt), and caps the list by Discord's 2000-char message limit instead of a hard count. The shim's `/sessions/available` raises its transcript limit to 200 and filters by the same two-day window.

## v0.22.0

- fix: front-tier capability refusals now defer to Claude instead of being spoken verbatim. `_HEDGE` recognizes "cannot" and capability-style prose ("I do not have the capability to …", "I cannot (write|create|update|provide|…)"), `_FACTUAL` gained a travel cluster (bus/train/route/timetable/…) plus skills/runbooks/slash-commands so plain-statement asks bypass the front tier, and `FRONT_SYSTEM` carries few-shot refusal examples telling the model a separate system answers what it refuses. Root cause: 2026-08-28 bus-ride transcript showed "I do not have the capability to ask Lord Gurk" and "I cannot write or update a runbook or create a skill or slash command" swallowed by the front tier — `_HEDGE` covered only `can'?t` and access/context phrasings, so the denial was spoken and the request never reached Claude.

## v0.21.0

- feat: containerise the Claude Code shim — the Dockerfile now carries `python3` + the `claude` CLI and copies `shim/`; the shim deploys as a second Deployment (`discord-assistant-shim`) behind a real `claude-shim` Service, reaching the backend through the in-cluster claude-code-router (`ANTHROPIC_BASE_URL` + router `x-api-key`, no provider credential in the pod). Bot manifest: `VOICE_ENABLED=0` text-only baseline, dead `speech-to-speech:8765` wiring dropped.

## v0.20.2

- fix: empty voice channels now release the s2s slot after a configurable idle grace (`VOICE_IDLE_RELEASE_MS`, default 1h) instead of immediately — a brief absence keeps the session and its conversation, while a squatter still releases once the window passes. A joining bot never waits this out: the handover evicts an idle holder immediately via the shim's yield, so the new bot still gets the slot at once.

## v0.20.1

- fix: release the speech-to-speech pipeline slot when a call ends — the bot now leaves (and tears down its session) when the last human departs the voice channel, and when the server removes it from voice (kicked, channel deleted), so an idle bot no longer squats the single slot and starves an active identity. The handover "completed" claim now fires on the server's `session.created` acceptance instead of on WebSocket open, so a `session_limit_reached` rejection surfaces as a failure rather than being masked by a false success log.

## v0.20.0

- feat: new `VOICE_ALWAYS_WAKE` env flag forces the wake phrase even in a solo call — an instance that sets it never auto-answers unaddressed voice, while every instance without it keeps the current behavior (solo calls answer unprompted). Read by both processes: the bot stops POSTing `solo=True` to `/v1/voice/solo`, and the shim's gate treats every room as not-solo when the flag is set, so a stale per-key solo state cannot disarm it. Default off; the Star Citizen Assistant instance uses it on the Liga server.

## v0.19.3

- fix: `zai_matrix.py` ran its entire network benchmark at import time. The
  execution body sat at module level with no `main()` / `__main__` guard, so
  any `import zai_matrix` (or a smoke test importing all four scripts)
  triggered a full surface × thinking-mode matrix against z.ai — hanging the
  import. Wrapped the body in `def main()` behind the standard guard, matching
  the other three scripts. Caught by the import smoke test this release adds.

## v0.19.2

- fix: the shim's wake-gate solo state is now keyed by voice session, not a process-wide global. A previous call ending with `solo=True` no longer leaks into the next call (e.g. a team channel that joined right after a private one) — `is_solo(<unknown key>)` returns False (gate armed), the safe direction. `/v1/voice/solo` now requires `X-Session-Key`; a missing one is a 400. The bot's `syncSolo()` always POSTs on join and on every arrival or departure, including when `channel.members` is unreadable at `/join` time (the actual race that triggered the 2026-08-18 Brogrammers false-trigger), so the bot and shim agree on the armed state from the very first turn of a new call.

## v0.19.1

- fix: a losing bot's very first "session slots are in use" refusal no longer leaves voice immediately — it raced v0.19.0's own last-joiner-wins handover, walking away from a slot that was about to free while the yield it triggered was still in flight. Now retries at the existing 2s cadence for a bounded, configurable window (`VOICE_SLOT_RETRY_DEADLINE_MS`, default 10s) before giving up loudly exactly as before; a successful handover within the window is silent in the channel, only the deadline expiring posts the notice and leaves.

## v0.19.0

- feat: three Discord identities sharing one speech-to-speech slot no longer silently wedge the loser. Adds `POST /voice/yield` (bot side, same `CHAT_BRIDGE_TOKEN` auth as `/chat`), called by the shim's `/voice/bind` handler whenever a bind changes which identity spoken turns belong to — the previous holder leaves its call and posts who took over, machine-wide, never per-guild. Independently, a speech-to-speech session refused with the "session slots are in use" error now leaves voice immediately instead of retrying every 2s forever, which is the behavior that made a lost race look like a perfectly healthy, silently unresponsive process.

## v0.18.0

- feat: identity fallback is now visible and, optionally, refusable. An unresolved session key (no identity segment, or an identity absent from `identities:`) has always fallen back to the top-level default persona — the MOST PRIVILEGED one on the instance (Personal vault cwd, `cc-personal`'s `--add-dir` over every repo under `~/Documents/workspaces`), and that fallback fired silently. It now logs a `WARNING` (once per key/reason) whenever `identities:` is configured and a turn still lands on the default, and the `spawned claude` log line now names the resolved `identity=` alongside `cwd=`. New opt-in `identities.strict: true` (`SHIM_IDENTITIES_STRICT`, default off) refuses such a turn outright (HTTP 403, no process spawned) instead of serving it with the default persona; a fresh single-identity install with no `identities:` block keeps behaving exactly as before either way.

## v0.17.1

- fix: bridged voice replies posted to a single global `CHAT_BRIDGE_URL`, so with three identities sharing one shim (personal, sc, boss) every identity's spoken answer posted to whichever bot owned that global default — the identity that actually spoke never received its own text, and the bot with no live voice session dropped it silently (`chat bridge: no live voice session, dropping`). Adds `chat_bridge_url` to each entry in `identities:`, resolved per turn through `identity_for()` the same way persona already is; unconfigured identities fall back to the existing global default unchanged.

## v0.17.0

- feat: text session keys carry persona the same way voice already does — `thread:<channelId>:<identity>` / `channel:<channelId>:<identity>` / `dm:<userId>:<identity>` when `IDENTITY` is set, unchanged 2-segment forms when unset. Multiple Discord identities can now share one guild: without the identity segment, two identities typing in the same channel collided on one `thread:`/`channel:`/`dm:` key and shared one Claude Code session, so a text turn from any identity resumed whichever identity's conversation was there and spawned it under the wrong cwd. `identity_for()` in the shim resolves the identity from the LAST segment of any prefix, falling back to the 2-segment guild-id lookup for voice only and to the instance default otherwise — mirroring the `v0.16.1` voice fix. Existing 2-segment text sessions stay reachable for a bot with no `IDENTITY` set; a bot that gains `IDENTITY` starts fresh conversations rather than silently adopting whatever the 2-segment key already held — that is intended, not a bug.

## v0.16.1

- fix: voice session/persona routing keyed by the wrong axis — `identity_for(key)` resolved persona from the GUILD id, so two identities sharing a guild collided on one `voice:<guildId>` session and one identity serving several guilds fragmented into several personas. `IDENTITY` (bot env) now names the identity; when set, the bound key becomes `voice:<guildId>:<identity>` and the shim resolves persona from the identity segment, keeping the guild segment only to keep sessions apart. Unset reproduces `v0.16.0` exactly; a `v0.16.0` guild-id-keyed `identities:` config still resolves for any bot that has no `IDENTITY` set.

## v0.16.0

- feat: per-guild persona/cwd routing in the shim (`identities:` in `config.yaml`) — a voice turn's session key (`voice:<guildId>`) now resolves its own `cwd`/`claude_script`/`mcp_config`/`allowed_tools`, so multiple Discord identities can share the one shim `speech-to-speech` is wired to without a spoken turn ever answering with another identity's persona, session store or vault. Unconfigured guilds keep behaving exactly as before.

## v0.15.1

- fix: route infrastructure questions to Claude — `_FACTUAL` covered the user's work (tasks, notes, repos) but not their own setup, so "can we run the benchmark against the router?" reached the front tier, which answered with an invented claim about the router. Adds router/benchmark/model/endpoint/config/subscription and similar nouns, pinned by tests.

## v0.15.0

- feat: send `reasoning_effort: none` on front-tier requests, so a local reasoning model reached over an OpenAI-compatible endpoint cannot spend the whole token budget thinking and return empty content — which ended the turn silently instead of falling through to Claude.

## v0.14.1

- chore: repo is public — add BSD-3-Clause LICENSE, set `package.json` license (was `UNLICENSED`), add README License section.

## v0.14.0

- fix: mentioning the bot's ROLE now addresses it, like mentioning the bot user does.
  Discord's autocomplete offers both as visually identical entries — same name, same
  avatar, one blue pill — and picking the role produces `<@&roleId>`, which lands in
  `mentions.roles` and never in `mentions.users`. The message was then dropped with no
  reply and no log line, so choosing the wrong one of two indistinguishable entries looked
  exactly like the bot ignoring you. Scoped to roles the bot actually holds, so mentioning
  an unrelated group still does nothing. `@everyone` is excluded explicitly: it IS a role
  the bot holds, and although discord.js reports it via `mentions.everyone` rather than
  `mentions.roles`, "every server-wide ping summons the assistant" is too large a failure
  to rest on a library detail nothing here asserts. The address is stripped in both forms
  before the model sees it — left in, the question arrives with a literal `<@&…>` on the
  front.
- An unaddressed message now logs at debug why it was ignored. Four separate "the bot
  ignored me" hunts this month ended at a filter that returned without saying so; from
  outside, an unaddressed message and a misrouted one are the same event.

## v0.14.0

- fix: a message typed into a live call's text chat is answered again. `speak()` sent the
  typed-turn hint on `DEFAULT_SESSION_KEY` with a comment claiming "voice always lands on
  the default session key" — true until `v0.10.0` keyed voice as `voice:<guildId>`. After
  it, the hint was written to `default` and read from `voice:<guildId>`, so it never
  matched: `typed_turn` stayed false and every typed message in a call was judged by the
  WAKE PHRASE as if spoken. Anything not opening with "hey bot" was dropped as unaddressed,
  with no error and nothing in the log but `QUIET`. The retraction on a failed turn had the
  same mismatch, so a dead turn left its hint standing. Second instance of the `v0.9.x`
  key-prefix regression — same release, different consumer.
- feat: the wake phrase is no longer required when you are the only human in the voice
  channel. It exists because "a missed trigger costs one repeat; a false trigger interrupts
  a room" — alone there is no room to interrupt, so the cost side of that trade is empty
  and a one-to-one conversation no longer needs "hey bot" on every turn. This reverses only
  the `always on rather than switching on head count` clause of the original design; how the
  phrase MATCHES (prefix-anchored, fixed variant list, filler-word skipping) is untouched,
  and a phrase said out of habit is still stripped before the model sees it.
- The bot posts the room state to `POST /v1/voice/solo` on join and on every arrival or
  departure — sticky, like `/voice/bind` and unlike the one-shot typed hint, because it
  describes a standing state rather than one utterance. Bots are not counted, or the
  assistant's own membership would make "alone" unreachable.
- Every failure path leaves the gate ARMED: the shim defaults to not-solo, a 404 from an
  endpoint without the route logs a capability note, and a failed post resets the bot's own
  flag so the two sides cannot drift into answering unaddressed speech. An unreadable
  channel is distinguished from an empty one and changes nothing.
- Someone joining re-arms the gate on arrival rather than on the next turn, and does so
  ahead of the transcript guard so it still happens with `TRANSCRIBE` off.

## v0.13.2

- fix: a failed voice turn now says so in the channel and the transcript instead of going
  silent. `case 'error'` only called `log.error`, so from inside Discord a failed answer
  and an utterance the wake gate ignored were the same event — silence. On 2026-08-11 a
  missing NLTK `punkt_tab` made every spoken answer die before synthesis for ~30 hours
  while `/readiness` returned 200, all four launchd jobs were up and TTS warmup logged
  success; diagnosis needed three log files. The reason now reaches both surfaces the
  typed-turn busy path already writes to, and multi-line server errors are compacted to
  one readable line (the NLTK error is ~20 lines of searched paths).
- fix: a `response_failed` error now clears `answering` / `inResponse` / `typedReplyPending`.
  A turn that fails before any assistant text emits no `response.done`, so those flags
  stayed raised and wedged every later `speak()` as permanently busy — visible during the
  same outage as a typed turn refused with reason `busy` while nothing was in flight. Both
  behaviours are scoped to `response_failed` deliberately: a
  `conversation_already_has_active_response` arrives while a response is in flight, so
  treating it the same way would stop playback mid-answer, and every error on a typed turn
  is already reported by `speak()`'s own listener via `src/text.js`.

## v0.13.1

- fix: the LaunchAgent `Label` now derives from `LAUNCHD_LABEL` instead of being hardcoded
  to `com.github.bborbe.discord-assistant-<component>`. `v0.12.0` moved the log directory
  and launcher path onto the variable but left the label inside the plist a literal, so
  `make launchd-install LAUNCHD_LABEL=…` wrote a correctly-named _file_ whose Label still
  claimed the first instance's service. `launchctl bootstrap` then failed with
  `Input/output error` — and that error was the lucky case: with the first instance
  stopped it would have loaded, binding the original label to the second checkout, which
  is precisely the silent takeover `v0.12.0` set out to prevent. Rendering for the default
  label is unchanged; verified by diffing against an installed plist.
- test: cover the plist template — Label follows the variable, two identities never
  collide, and no `__PLACEHOLDER__` survives rendering. The template had no coverage at
  all, and it fails only on a machine at install time, never in CI.

## v0.13.0

- feat: `VOICE_ENABLED=0` runs the bot text-only — `join`/`leave` are not registered as
  slash commands, no socket is opened to `S2S_URL`, and `status` says voice is disabled
  instead of reporting a red cross against a service the instance was never meant to
  reach. Defaults to true, so an existing deployment behaves identically with nothing
  set. This is what makes a cluster deployment possible at all: speech-to-speech needs a
  GPU and there is none on any node, so text-only is the only shape that can run off the
  laptop. Unregistering rather than stubbing is deliberate — a command in the guild's
  list is a promise the instance can do the thing. The typed `join`/`leave` still answer
  with a reason, since someone who tries anyway deserves better than silence.
  Distinct from `SKIP_VOICE` in `scripts/dev.sh`, which only skips launching
  speech-to-speech locally and says nothing about what the bot advertises.

## v0.12.0

- feat: Derive the log directory and launcher path from `LAUNCHD_LABEL`, so a second
  identity installs beside the first instead of on top of it:
  `make launchd-install LAUNCHD_LABEL=com.github.bborbe.team-assistant`. The label was
  already overridable; the log directory and the launcher path were not. The launcher was
  the dangerous one — `launchd-install` re-copies it on every run, so installing from a
  second checkout silently replaced the binary the first instance was running: harmless
  while both sat on the same commit, a silent downgrade of a live service the moment they
  did not, with nothing logging it. Logs would also have interleaved into one set of four
  files. Defaults are byte-identical — the generated plist was diffed against the
  installed one and matches exactly, so a single-instance setup needs no migration.

## v0.11.1

- fix: Restart a component that is killed, instead of leaving it stopped. The launcher
  `exec`ed each component, so launchd judged the job by whatever the program reported —
  and `uv run` exits **0** when signalled directly, while propagating `143` when its
  child is signalled. With `KeepAlive`/`SuccessfulExit: false`, a killed
  `speech-to-speech` therefore looked like a job that had finished successfully and
  launchd correctly declined to restart it. Voice stayed down until someone noticed it
  was gone — the same silent outage the TeamVault classification fix in `v0.8.0` exists
  to prevent, arriving from the opposite direction: there a transient failure was treated
  as fatal, here a fatal one was treated as success.

  Components now run under `run_server()` rather than `exec`, which translates **any**
  exit of theirs into `75`, because a long-running server that returns has failed
  whatever status it reports. `exit 0` is reachable only through `die_config`, which is
  what makes "bad config stops the job" a contract rather than a side effect of what the
  runtime happens to report. A `TERM`/`INT` trap forwards signals to the child, since
  launchd now signals this wrapper instead of the server and would otherwise orphan it.

  Verified end to end, both directions: `kill <job pid>` → `last exit 75` → launchd
  restarts with a new PID and the full `uv` → `python` tree; a missing repo and an
  unknown component still exit `0` and stay stopped.

## v0.11.0

- fix: Release MLX's buffer cache per segment in `tools/transcriber.py`, and cap it
  (`TRANSCRIBER_CACHE_LIMIT_MB`, default 512). MLX keeps freed Metal buffers in a
  reusable pool rather than returning them to the OS, and reclamation otherwise happens
  only when the process goes idle. That is harmless at conversational pace and dangerous
  under sustained load: on 2026-08-10 the laptop reached 65.8 GB of 66.5 GB swap with a
  load average of 28. Root cause was **not** a leak — measured across two bursts, the
  footprint returns to within 23 MB of its cold baseline — but the `v0.9.x` wake-phrase
  regression pushed every utterance from five speakers through the full pipeline for two
  and a half hours, so it never went idle and ~2.4 GB of per-turn transient allocation
  stacked instead of being reclaimed. Clearing per turn bounds the peak to one turn
  rather than to sustained load. Upstream already does exactly this after every local-LLM
  generation; the STT path never does and TTS only does at shutdown.
- feat: Log MLX active/cache memory per processed batch in the transcriber. Nothing in
  the stack reported its own footprint, which is why unbounded growth surfaced as the
  machine falling over rather than as a log line.

## v0.10.0

- feat: Key voice conversations per guild instead of globally. `speech-to-speech` owns
  the HTTP call to the endpoint and cannot set `X-Session-Key`, so every spoken turn —
  from any server — fell through to one `default` conversation: joining a call in a
  second Discord server resumed the first server's conversation, which is a boundary
  between contexts rather than a papercut. The bot now names the conversation out of
  band on join (`POST /v1/voice/bind`, the same shape as the existing `/v1/turns/typed`
  hint) and the endpoint routes headerless requests to that key. A voice channel's text
  chat follows the same key, so a call stays ONE conversation whether a turn was spoken
  or typed. Two voice channels in the same server still share a conversation — s2s
  cannot say which channel a turn came from, and that part is unchanged.
- fix: Keep the voice wake phrase working under per-guild keys. The shim decided a turn
  was spoken by testing `":" not in key` — which silently meant "the key is `default`".
  Per-guild keys gave every spoken turn a colon, so all of them classified as text, and
  the wake-phrase gate (`if voice and not typed_turn`) stopped running: the assistant
  answered every sentence said in a live meeting rather than only those addressed to it.
  Nothing errored, `/readiness` stayed 200 and precommit stayed green. The classifier is
  now the named `is_voice_turn()` and matches the voice keyspace explicitly, so the shape
  of a key is never load-bearing again.
- test: Add `test/test_shim.py` — the **first tests for the shim**, which had none. `npm test`
  is `node --test`, so ~2000 lines of Python were never executed by any check, and that is
  where the wake-phrase regression lived. `make test` now runs both runtimes (`test-node` +
  `test-shim`, stdlib `unittest`, no venv). Ten cases covering turn classification and voice-key
  routing; verified to fail against the previous classifier rather than assumed to.
- test: Fix a Node fixture that hid the same change. `a voice channel shares the spoken
conversation` asserted the old `default` key and kept passing after the behaviour flipped,
  because its fixture had `guild: {}` — no id to key on, so the code fell into the fallback
  branch. An underspecified fixture is a green test asserting nothing.
- fix: Deliberately do NOT unbind on leave. No spoken turn exists while no call is live,
  so reverting would only race the `leave()` that `join()` itself performs, and leaving
  the pointer where it is means a straggling turn lands in the conversation it was
  actually spoken into.

## v0.9.0

- feat: Add `tools/llm-bench`, a hand-run chat-shaped LLM benchmark for choosing the
  shim's front-tier model. Existing benchmarks — public boards and `coding/bench`
  alike — score agentic tool loops, where turn count dominates wall time; a chat
  surface is short-turn, where time to first _visible_ token dominates. The rankings
  do not transfer: MiniMax-M2.7 beats M3 on a code-review fixture and loses to it
  here. Four scripts (broad screen, full fixture + fabrication test, per-family
  matrix, surface × thinking matrix) plus a README recording the traps — GLM returns
  zero visible text under a token cap unless thinking is explicitly disabled,
  `MiniMax-M3-highspeed` does not exist and silently resolves to `MiniMax-M3`, and
  the fastest model measured fabricated 17 of 24 live-data prompts. Diagnostics only:
  nothing here is imported by the bot, and tokens are read at runtime from the
  claude-code-router config, never stored. Parked here as a stopgap; the intended
  home is `coding/bench` as a second fixture.

## v0.8.1

- fix: Route the voice surface to the shim instead of MiniMax. `v0.8.0` started
  `scripts/s2s-minimax` with no arguments, and that launcher hardcodes
  `--responses_api_base_url https://api.minimax.io/v1`, reaching Claude Code
  only when trailing `"$@"` args override it. So voice silently answered from a
  hosted model with no vault access, leaking MiniMax's own `<tool_call>` markup
  into replies and claiming it "can't access external documents" — while every
  process reported healthy and every check stayed green. The launcher now
  passes `OPENAI_BASE_URL` / `OPENAI_MODEL` from `local.env`, so voice and text
  cannot drift onto different endpoints, and refuses to start if either is
  unset rather than falling back silently.

## v0.8.0

- feat: Run the local stack under launchd. `scripts/launchd-run.sh` starts one
  component and resolves its secret at launch, so nothing lands in a plist;
  `deploy/launchd/discord-assistant.plist.template` plus `make launchd-install`
  / `launchd-uninstall` / `launchd-status` generate and manage the four agents.
  The plists use `KeepAlive`/`SuccessfulExit` rather than `KeepAlive: true` and
  the launcher exits **0** on an unrecoverable config error, so a revoked token
  stops the job instead of retrying forever — the behaviour `supervise.sh`
  approximated with its exit-2 rule. Secrets are isolated per component: the
  bot never holds the shim's key, and neither reaches s2s or the transcriber.
- fix: Distinguish an unreachable TeamVault from a bad key. A request that timed
  out during verification was classified as an unrecoverable config error, so
  the bot stopped and stayed stopped — recreating the silent outage this whole
  change exists to prevent. Only `401`/`403`/`404` and an empty value now stop
  the job; timeouts, `5xx`, `429` and anything unrecognised retry. Unknown
  errors retry on purpose: a job retrying too often is visible in the log, a job
  that stopped when it should not have is invisible.
- fix: Wait for a label to actually leave `launchctl list` between `bootout` and
  `bootstrap` in `launchd-install`. `bootout` returns before the job is gone, so
  the pair raced itself, failed with a bootstrap I/O error, and aborted the loop
  with half the agents still on the previous launcher.
- docs: Add `docs/` with a deployment page per target. `deploy-local.md` covers
  the macOS/launchd setup — why LaunchAgents rather than LaunchDaemons (Keychain,
  TCC on `~/Documents`, no GUI session), one job per process, credentials resolved
  at launch instead of stored in a plist, and the `KeepAlive`/`SuccessfulExit`
  form that stops a job on bad config instead of retrying a dead credential
  forever. `deploy-kubernetes.md` is a placeholder that records the real state:
  image and manifests exist, have never been applied, and are blocked on three
  named unknowns rather than on effort.
- docs: Correct the process table in `README.md` — the local stack is four
  processes, not three. The transcriber has no port, so its absence is silent.

## v0.7.2

- fix: Treat `ooh` as a hesitation before the wake phrase. `oh` was already on
  the list and `ooh` was not, so a one-letter difference in what speech-to-text
  produced left a real question unanswered — found on the ninth attempt of a
  reliability run. Third variant added this way after `hey bought` and
  `hi bot`: every miss this feature has had is a transcription spelling, never
  the matching logic.

## v0.7.1

- fix: Do not leave the typing indicator stuck when a turn produces nothing.
  `answering` was raised for an addressed utterance and lowered on
  `response.done`; a turn that died first — the endpoint declining, or
  speech-to-speech hanging up mid-answer ("listener gone") — never sent one, so
  the dots ran to the cap and `speak()` refused typed turns as `busy` for the
  same period. The flag is now re-evaluated on every transcription, so any new
  utterance ends a stranded state, and the last-resort cap drops from five
  minutes to two.
- fix: Accept `hi bot` as a wake phrase. Speech-to-text rendered a real
  question as "Ah hi bot. Can you check for a task?" and the gate correctly
  declined it — which is exactly the mishearing the variant list exists to
  absorb. Added because it was OBSERVED, not guessed: variants are deliberate
  entries, and every one is a false-trigger risk taken on purpose.

## v0.7.0

- feat: Wait to be addressed. In a call the assistant hears every word an
  allowlisted speaker says — the allowlist decides WHO may drive it, never
  whether a given sentence was meant for it — so in company it answered
  conversations addressed to other people. A voice turn now needs to open with
  a wake phrase (`SHIM_WAKE_PHRASES` / `voice.wake_phrases`, default
  `hey bot` plus two of its likely mishearings), and reaches the model with the
  address stripped. Unaddressed speech takes the same silent path as filler:
  empty content, so nothing is synthesised and no holding line is spoken.
  Deliberately: prefix-matched not anywhere-matched, a fixed variant list not
  fuzzy matching, always on rather than switching on head count, and no
  follow-up window — every ambiguous case resolves to silence, because a missed
  trigger costs one repeat while a false one interrupts a room. Typed turns are
  never gated; an `@mention` already addressed the bot.
- fix: Do not raise the typing indicator for an utterance that was not
  addressed to the bot. Found in the first live test of the gate above: the
  dots appeared and then nothing came, because the bot raises them on the
  transcription event while the endpoint decides addressing seconds later.
  Worse than cosmetic — the endpoint answers an unaddressed turn with silence,
  so nothing ever arrived to clear `answering`, hanging the dots until the
  five-minute cap and making `speak()` refuse typed turns as `busy` for the
  same period. Every sentence spoken to a colleague would have wedged the typed
  path. The bot now applies the same prefix rule to the transcript it already
  receives; the endpoint remains the authority on what is answered.
- fix: Strip closer panels from what the chat bridge posts. `strip_panels`
  says it applies to both surfaces; the bridge was the one path that skipped
  it, so "🔵 READY", "👤 You:" and "⏰ Next:" lines were landing in the Discord
  channel verbatim. Present since the bridge shipped in v0.5.0.
- fix: Strip the 📌 / 🎯 anchor lines too. The panel matcher covered the state
  line but not the two lines that introduce it, so half a panel was removed and
  half posted — visible on both surfaces, not only through the bridge.
- fix: Skip leading disfluencies before the wake phrase. People do not start a
  sentence on the phrase, they start on a hesitation — three consecutive live
  failures were "Uh hey bot, can you check my free disk space?", "Uh hey hey
  bot, did you hear me?" and a filler-led retry. Requiring the phrase at the
  literal sentence start made the feature unusable in ordinary speech while
  passing every test written from imagined utterances. Only NOISE may precede
  it (the existing `_FILLER_WORDS`, plus "hey"), so "so, hey bot" still does
  not count — the phrase must still be the first real word.
- fix: Make `INTERRUPT_RESPONSE` govern BOTH interrupt paths. There are two:
  the server cancels the generation (`turn_detection.interrupt_response`) and
  the bot destroys the playback stream on `speech_started`. Only the first was
  gated, so with the switch reading off an acknowledgement still cut the
  assistant off mid-sentence — the same lost answer, a different cause, and a
  switch that looked set while the behaviour it names carried on.
- fix: Anchor the wake phrase to the start of a SENTENCE, not the start of the
  utterance. speech-to-speech grows one turn across progressive finals, so a
  transcript becomes "Uh can you check my disk space? Hey bot, can you check my
  disk space?" — the phrase is present but never at position zero, and three
  consecutive properly-addressed attempts were all rejected. Still anchored: "I
  told him the bot was broken" and "so, hey bot, …" stay quiet, because the
  phrase must OPEN a sentence rather than merely appear. Everything before the
  phrase is now dropped along with it — on an accumulated turn that text is
  what was said to the room, and feeding it to the model asks the wrong
  question.
- fix: Send `session.update` in a shape the server accepts. Both `type`
  discriminators are required (`session.type: realtime`,
  `turn_detection.type: server_vad`); without them the whole update is rejected
  as `Unknown or invalid event: session.update` — a message that reads like the
  event is unsupported when it is really a validation failure, so the
  interrupt switch below silently did nothing on every connect.
- feat: Make barge-in a switch, `INTERRUPT_RESPONSE`, and default it OFF.
  Speaking while the assistant was answering cancelled that answer — observed
  live, an "okay" nine seconds into a lookup threw the reply away silently and
  it never arrived. Not filterable where it happens: the cancel fires on the
  VAD's `speech_started`, pure acoustics, before any words exist, so "okay" and
  "stop, wrong question" are the same event and speech-to-speech offers no
  threshold or content filter — only the boolean. Off costs little because
  spoken replies are capped at a couple of sentences; `INTERRUPT_RESPONSE=1`
  restores the old behaviour. Sent as a PARTIAL `session.update` so the
  launcher's VAD tuning is deep-merged rather than reset.
- fix: Boolean settings now accept `1/true/yes/on` and `0/false/no/off`, on
  both sides, case-insensitively and with surrounding quotes stripped.
  `INTERRUPT_RESPONSE=true` previously did nothing at all — the bot tested for
  the literal `"1"` — and the two processes disagreed on the rest: `off` read
  as TRUE in the shim (its false-list lacked it) and false in the bot, while a
  Make-quoted `"0"` read as TRUE in both. A switch that looks set and isn't is
  worse than no switch, because it fails quietly in the safe-looking direction.
  `TRANSCRIBE` and `ANNOUNCE_TRANSCRIPTION` go through the same parser now.
- fix: Tolerate surrounding quotes on `SHIM_WAKE_PHRASES`. The Makefile's
  `-include local.env` parses with Make semantics, so `export X="a,b"` reaches
  the process with the quotes still in the value and the first phrase becomes
  `"hey bot`, matching nothing. Third instance of this family after `$HOME` and
  the secret-in-argv case.

## v0.6.0

- feat: In a live call, an answer to a typed question is now BOTH spoken and
  written to the channel. Speaking already got you a short spoken answer plus
  the full text (v0.5.0); typing got speech and nothing written — so the typed
  question, the precise one, was the only kind whose answer evaporated. The
  bot now tells the endpoint out of band that a turn came from the keyboard
  (`POST /v1/turns/typed`, one-shot per key, consumed at the top of the turn),
  and that becomes a fourth chat-bridge trigger. Deliberately not symmetric:
  spoken turns keep the three inference-based triggers, so a spoken "hello"
  still does not litter the channel.
- feat: Ask for a complete, front-loaded answer instead of a short one. The
  machinery for "short spoken, detailed written" already existed — speech is
  capped at `SHIM_SPOKEN_MAX` sentences and the full text is what the chat
  bridge posts — but the voice directive also told the model to stop at two
  sentences, so there was rarely anything extra to post, and the written copy
  was the same brief answer untruncated. Length is enforced in code, so the
  directive now shapes ORDER instead: answer first (that part is heard),
  detail after (that part is read). Identifiers, paths and markdown flip the
  same way — forbidden in the spoken opening, wanted in the written half.
  Also resolves a contradiction introduced with the chat bridge, which told
  the model to answer in full while the length rule told it to stop at two
  sentences.
- fix: The truncation line now says "the details are in the chat" rather than
  offering more — the rest has already been posted by the time it is heard,
  so "if you want it" invited the listener to ask for what they already had.
- fix: Show the typing indicator for EVERY answer produced during a call,
  spoken or typed. The text path has always shown Discord's "…is typing"
  dots; the voice path never did, so text could arrive in the channel with no
  sign it was coming — indistinguishable from having been ignored. Raised
  from two signals, because no single event covers both surfaces:
  `response.created` for a client-requested (typed) turn, and the user's
  utterance being transcribed for a mic turn — which never emits
  `response.created` at all, since assistant text calls `_ensure_response`
  first and the audio path then skips the event. Accepted cost: a spoken turn
  that produces no written copy now flashes the dots briefly and posts
  nothing.

- feat: Answer a typed message aloud when it lands in a live call's own text
  chat. Pushes the typed turn into the s2s socket the call already holds
  (`conversation.item.create` + `response.create`) and lets the existing
  playback path speak the reply — no second TTS path. The rule is
  content-blind: any typed turn that would be answered at all, in the text
  chat of a channel with a live voice session, is spoken; everywhere else
  keeps answering in text via `X-Output-Mode: text`, unchanged. A server-side
  refusal (`conversation_already_has_active_response`, one response at a
  time) is reported to the channel and recorded in the transcript rather than
  silently dropped or answered a second way. The transcript marks a
  typed-then-spoken reply distinctly (`(typed→spoken) `) from an ordinary
  spoken reply, matching the existing `(typed) ` marker on the question.
- fix: Correct a comment in the chat-bridge auth check that described a
  `!==` short-circuit while the code actually used
  `crypto.timingSafeEqual` — the implementation was already
  constant-time, only the comment was wrong.

## v0.5.0

- feat: Bridge spoken answers into the channel as text. The shim already computes
  the full answer and discards everything past `SHIM_SPOKEN_MAX` — it now
  POSTs that full text to a new authenticated `POST /chat` route on the bot's
  health server (no channel id in the payload; the bot routes to whichever
  voice session is actually live). Triggers on either truncation or a
  content-shape heuristic (URL, path, identifier, multi-item list, or a
  capitalized-word run), so a short answer that is pure payload — e.g. a
  station name — is posted even when never truncated. Also: a reply to a
  message typed during a live call is now written into the session
  transcript, matching the question side that was already captured.
- fix: Honour an explicit request to write something down. Found on a live call:
  "write it to the chat" produced a two-sentence plain-prose answer, so
  neither the truncation nor the content-shape trigger fired and nothing was
  posted — correct by the letter of both, and exactly wrong. Intent lives in
  the user's turn, where no inspection of the answer can see it, so it is now
  a third trigger read off the prompt. Still code-side: an unmatched phrasing
  falls back to the other two rather than asking the model to decide.
- fix: Stop the assistant claiming it cannot type. With no tool and no knowledge of
  the bridge it truthfully reported the old limitation — "I can only speak,
  not type into the channel" — while the bridge was armed. A voice-only
  directive now states that the full written answer reaches the channel. It
  corrects a belief; it does not ask the model to decide anything.
- feat: Log every chat-bridge decision with its reason, including the decision not
  to post. Without it a declined trigger and a broken bridge are
  indistinguishable from outside — the blindness that made the 2026-08-04
  Discord outage take four restarts to diagnose.

## v0.4.3

- docs: Add `CLAUDE.md` — coding-guideline pointers, non-obvious invariants (fail-closed allowlist, transcription/consent separation, health transport), the non-code surfaces (patches, Python shim, tools), the real-voice-session verification requirement, and the two known deviations from the Node service guide

## v0.4.2

- Catch the transcript run-on in flight instead of reconstructing it afterwards.
  A holding line and an answer once arrived welded together, a full stop
  immediately followed by the next capital, and every layer that can be
  inspected preserves the space:
  the endpoint ends each SSE chunk with one (verified on a live turn), and
  speech-to-speech strips each sentence and joins batches with one. So the
  defect is now detected where it lands: a sentence end followed directly by a
  capital logs a warning with the raw text quoted.

  Warning rather than debug on purpose. It fires only on the defect, so it costs
  nothing until it happens, and needs no log level raised to catch something
  that only occurs on a live call. Requiring a capital keeps `e.g`, `3.5` and
  `example.com` out; checked against both.

- Stop losing a transcript line when two are written in the same millisecond.
  The segment name was `${Date.now()}-<speaker>-000000`, so a second write
  inside one millisecond produced the same filename and `writeFileSync`
  overwrote the first — a line gone, nothing logged. Not a rare race: a holding
  line and the first sentence of the answer arrive together, which is exactly
  when the record is worth having. A per-session counter replaces the fixed
  `000000`, which also makes same-millisecond lines sort in insertion order
  rather than arbitrarily. Covered by a test.

  Found while chasing a different symptom: a holding line and an answer run
  together in a transcript with no separator between them. That one is **not**
  fixed and does not appear to be ours — the endpoint's SSE
  deltas each end with a trailing space (verified against a live turn), and
  speech-to-speech strips each sentence and joins batches with a space, so the
  missing separator arises downstream and could not be reproduced here.

## v0.4.1

- Survive a gateway network fault instead of dying of it, and restart if the
  process does die. On 2026-08-05 the laptop slept; "Opening handshake has timed
  out" was thrown from inside `ws` with no listener to catch it, reached
  `uncaughtException`, and killed a bot that had run fine for eight hours.
  `make run` exited and nothing brought it back, so the first sign was `/join`
  doing nothing — the endpoint and speech-to-speech were still up, which made it
  look like Discord's problem.

  Network faults are now survived, but **only after the gateway has connected
  once**. That condition is the design: past login, discord.js reconnects on its
  own and swallowing the throw lets it, while before login there is nothing to
  reconnect to and surviving would leave a process that is alive, passing
  liveness, and permanently disconnected — worse than exiting, because a crash
  is at least visible. Readiness drops so traffic drains meanwhile.

  `scripts/supervise.sh` restarts the bot on exit with exponential backoff,
  giving up on exit 2 (bad config, which restarting cannot fix) and on a clean
  exit. It is the local stand-in for what a k8s Deployment does for free.

## v0.4.0

- Configure the endpoint from a file, and let it launch Claude the way
  everything else does. `~/.config/discord-assistant/config.yaml` (optional,
  `config.example.yaml` documents it) resolves **environment > file > default**,
  so a k8s ConfigMap or a one-off `SHIM_*` var still wins and an instance with
  no file behaves exactly as before. Single flat config, no profiles: two
  configurations means two deployments.

  The setting that matters is `claude_script`. The shim spawned a bare `claude`
  with its own flag list while every other entry point goes through a wrapper
  (`cc-personal`), so the bot's Claude quietly had no `--add-dir`, no router,
  no model or effort pinning — it could read the vault and nothing else. That
  gap is invisible until `switch` picks up a desk session and it can no longer
  open a file its own history shows it reading. Naming the launcher rather than
  restating its flags is how `vault-cli` avoids the same drift, via
  `claude_script` per vault.

  Verified: through the launcher the endpoint read a file under
  `~/Documents/workspaces` that the bare spawn had no access to. Left unset by
  default on purpose — a launcher's `--add-dir` set becomes readable by everyone
  on the Discord allowlist, and `cc-personal` adds every repo on the machine.

  `SHIM_FRONT_API_KEY` stays environment-only. The config file is not gitignored
  the way `local.env` is, so it names TeamVault key ids and never values.

## v0.3.2

- Accept a session-id **prefix** in `switch`, check the shape first, and stop
  answering with a filesystem path. A slash-command option takes any text, so
  `/switch speech to speech` was handed straight to the endpoint and came back
  as "no transcript for speech to speech in /Users/…" — an absolute host path in
  a chat window, in answer to what was plainly a typo. Free text is now refused
  in front of the endpoint with the shape it wanted, an unknown prefix says so,
  an ambiguous one lists the candidates rather than guessing, and the remaining
  refusals have the path stripped.

  The prefix matters more than it looks: a uuid is 36 characters and this is a
  phone-first surface. `switch b1f506b0` is a thing you will actually do.

## v0.3.1

- Decide spoken-vs-written output from the **transport**, not the session key.
  The shim treated a keyless session as voice, which was sound while only
  speech-to-speech omitted the key — and wrong the moment a voice channel's text
  chat began sharing the spoken session. A typed `date` came back "It's the fifth
  of August, twenty twenty-six": numbers spelled out, capped at two sentences,
  because the session was a voice one. The bot now states `X-Output-Mode: text`
  on every HTTP turn it makes, and the header wins in both directions; the
  keyless default survives only as the speech-to-speech case, which owns its own
  request and can set no headers. Verified on one session: typed gives
  "2026-08-05 (Wednesday)", spoken gives "the fifth of August, twenty
  twenty-six".

  Unifying a conversation quietly unified its output style too — the second
  property was riding on the first without anything naming the dependency.

## v0.3.0

- Make a voice channel ONE conversation: messages typed in its integrated text
  chat now use the same session as what is spoken there. Discord treats that
  chat as an ordinary text channel, so it was getting its own `channel:` session
  — a link pasted mid-call went to a Claude session the voice conversation could
  not see.

  This also repairs a claim shipped an hour earlier. The session commands derive
  their key from the channel they are typed in, so `switch` and `new` in a voice
  channel acted on a `channel:` session nothing was using, and the spoken
  conversation — the long one, the one worth switching — was unreachable from
  Discord. The README said otherwise. It is now true rather than corrected.

  Consequence worth knowing: `default` is one key for ALL voice, because
  speech-to-speech cannot say which channel a turn came from. Two voice channels
  share a conversation — already true of speech, now true of their chats too.

## v0.2.0

- Add `new`, `sessions` and `switch <id>` — over both transports, as usual.

  `new` and `sessions` had working handlers for weeks and were **unreachable**:
  neither was in the slash-command registration array. A handler is not a
  command until it is registered, and nothing failed loudly to say so.

  `switch` is new work: the shim could only ever _create_ a session id for a
  key, so `POST /v1/sessions/bind` now points a key at an existing one. Since
  voice always keys on `default`, switching from a voice channel repoints the
  spoken conversation — you can pick up a session started at the desk and
  continue it by talking.

  Two refusals, both learned rather than guessed. An id with no transcript is
  rejected at bind time, because `claude --resume` on an unknown id fails with
  "No conversation found" on the _next_ turn, long after the bind looked fine.
  And an id already held by another key is rejected outright: per-key locking is
  what makes concurrent turns safe, so two keys on one session file defeats it.
  `sessions` marks the taken ones rather than hiding them — seeing where a
  session already lives answers "which one is the voice one".

  Known hole: a session open in an interactive `claude` at the desk is not in
  the shim's mapping, so the collision guard cannot see it. Binding to one puts
  two writers on a single transcript.

## v0.1.2

- Always name the voice session in `status`, not only while the bot is sitting
  in a voice channel. It is the session most worth resuming — every spoken turn
  from every channel lands on `default`, so it is the long one — and it outlives
  the visit that created it. Found the same hour the feature shipped: `status`
  typed in a guild channel offered a 1-turn `channel:` id, which was resumed at
  the desk and found empty, while the real 93-turn conversation was never
  mentioned. A diagnostic that names only the conversation you are standing in
  is most misleading exactly when you are standing in the wrong one

## v0.1.1

- Name the Claude Code session in `status`: the key answering this channel, its
  session **id**, whether it is **warm** or **cold**, turn count and age.

  The id is the actionable part. Shim sessions are ordinary Claude Code
  sessions, so `claude --resume <id>` opens at the desk the same conversation
  the bot has been holding — previously that id existed only in shim logs, and
  the surface that could tell you it had no way to say it.

  `warm` / `cold` is new information rather than a restatement: the persisted
  key/id mapping outlives the process it named, so an id alone says nothing
  about whether the next turn answers immediately or pays a cold spawn. The
  shim's `/sessions` route now reports `live` per key, read from the live
  process table rather than the file.

  A backend without a `/sessions` route says so and the rest of the report is
  unaffected — the bot may not assume its endpoint is the shim.

- Correct the README on session scope. It claimed voice and text share one
  conversation, and that threads do not create separate ones. Both are the
  reverse of what the code does: text keys on `thread:` / `dm:` / `channel:`,
  while voice reaches the endpoint through speech-to-speech, which owns the HTTP
  call and cannot set a header — so all speech lands on `default`. Confirmed
  against the live shim: `default` at 84 turns beside single-digit text
  sessions. The README now carries the key table and says plainly that saying
  something aloud and typing it reach two different sessions

## v0.1.0

- Record arrivals and departures in the transcript, from a `voiceStateUpdate`
  handler that did not exist before. Speech alone cannot tell a reader who was
  present, so a gap in someone's contributions was ambiguous between "said
  nothing" and "was not there" — and an SSRC change left no trace at all, which
  made rejoin behaviour effectively untestable. It is now visible in the file:
  `(left the channel)` / `(joined the channel)` between the speech.

  That instrumentation immediately settled a real question. Predicted defect:
  `listen()` early-returns on `subscribed.has(userId)` and nothing clears that
  set, so a rejoining user should never be re-subscribed and their audio should
  vanish. Measured 2026-08-04 — audio survives, with no re-subscribe, because
  `@discordjs/voice` keys `receiver.subscribe()` by user id rather than SSRC and
  re-attaches on return. The prepared fix was deliberately withheld until after
  the test; applying it first would have made the bug disappear for the wrong
  reason and left the behaviour unrecorded

- Refresh display names on arrival. They were resolved once at join, so anyone
  entering later was written into the transcript as a raw user id

- Mark typed lines `(typed)` in the transcript. The two have different
  reliability — a spoken line is STT output and can be wrong (real speech once
  became "when they have something that's the young job"), a typed line is
  exact. A reader deciding whether to act on a pasted path or URL needs to know
  which one it is holding

## v0.0.4

- Tell the assistant that the transcript exists, and where. Capturing typed
  messages to disk achieved nothing on its own: a path pasted mid-call was
  written correctly, and "can you check the file I posted in the chat?" was
  answered "I can't see it — the bot has no attachment handling", after reading
  the bot's own source to check. Nothing had ever mentioned the file that
  contained it, and typed messages reach the model ONLY through that file — they
  are never in its context. The directive now names the directory, explains that
  it holds both speech and typed lines, and says that "posted" usually means a
  line in the transcript rather than an attachment. Voice turns only; a text
  thread already carries its own history

- Do not count a lead-in ending in a colon against the spoken-sentence cap. "Typed
  messages only reach me through the transcript." / "Let me read it:" exhausted
  the two-sentence budget before a word of the answer, so the caller heard the
  preamble followed by "there's more if you want it"

- Forbid narrating the work in spoken replies. The user already hears a filler
  while tools run and does not need a second account of what is about to happen

- Write messages posted in a voice channel's own text chat into that channel's
  transcript, alongside the speech. Previously only the bot's spoken replies were
  written as text, so a link pasted during a call was invisible to the session
  and "have a look at what I just posted" had nothing to look at. A voice channel
  and its integrated chat share an id, which is what links the two. Everyone is
  captured, matching the audio side: the allowlist governs who may DRIVE the bot,
  the transcript governs who gets WRITTEN DOWN. Verified live — typed "abc" and a
  spoken line landed interleaved in one record, ten seconds apart.

  Note that a server may have a text channel and a voice channel with the SAME
  NAME and different ids; only the voice channel's own chat is captured

## v0.0.3

- Cap how many sentences are spoken, rather than asking for it. The voice
  directive requests two and fresh sessions obey; a session with hundreds of
  turns behind it produced 741 characters, five or six sentences. In-context
  precedent beats an instruction — the model imitates its own earlier answers,
  and each long one makes the next likelier, so the directive loses ground the
  longer a session runs. Enforced in the shim instead (`SHIM_SPOKEN_MAX`, 0
  disables): 741 chars became 178-225. Past the cap it says "there's more if you
  want it" once and then stays quiet, since cutting off mid-answer with no
  acknowledgement sounds like a fault. The full text is still returned and
  written to the transcript

- Count suppressed sentences as speech for the progress watcher. Without it the
  watcher sees no output while the model is still producing and interjects
  "still on it" immediately after "there's more if you want it"

## v0.0.2

- Pace playback and fill the gaps with silence. Writing audio into the stream as
  it arrived underran: a turn speaks a one-second filler, then synthesises
  nothing for several seconds while tools run, so the player drained the stream,
  found it empty, treated that as the end of the resource and went idle — after
  which every later write landed in a stream nobody was reading. The filler was
  heard and the answer never was, although the log showed both synthesised, and
  Claude itself remarked "short version, since I keep getting cut off".

  The input side of the same file already solved the mirror image of this: a
  fixed-rate pump that emits silence because speech-to-speech closes a turn on
  silence. Output needed the same pump for the opposite reason — silence keeps
  the resource alive. Verified on a live call: one continuous playback session
  across a 33s turn, filler and answer both audible

- Add a health check reachable as `/status` AND as a typed `status`. Each leg is
  probed live — the endpoint answers, speech-to-speech accepts a connection, the
  transcript directory is writable, which voice channels are held, gateway ping —
  because "configured at :8080" is a different claim from "answers at :8080", and
  only the second is worth reading when something is broken. The slash form
  defers first, since the probes can outlast the 3s interaction deadline exactly
  when one of them is the thing that is down

- Accept `join` and `leave` as typed messages, not only slash commands. Slash
  commands arrive as INTERACTIONS, a different Discord subsystem from messages:
  during an API outage on 2026-08-04 the gateway stayed up and messages flowed
  normally while every interaction was silently dropped, leaving no way to start
  voice at all. A diagnostic or a control that shares a transport with the thing
  it controls is unavailable exactly when it is needed. Only the bare word
  triggers, so "join the meeting notes" is still a question for Claude

- Log every interaction and message before any filtering. When a command hangs,
  the only question that matters first is whether it reached the process — and
  an event that was filtered out is indistinguishable from one that never
  arrived. That distinction is what identified the outage as external

- Survive an undecryptable voice packet. "Failed to decrypt:
  DecryptionFailed(UnencryptedWhenPassthroughDisabled)" reached the
  `uncaughtException` handler and exited the process mid-conversation — the call
  simply stopped, with the last log line a perfectly normal transcript. Discord's
  decryption throws from a UDP callback with no listener, so it cannot be caught
  where it happens. Only this known-recoverable class is survived, still logged
  each time; anything else still exits, because an unknown exception leaves
  unknowable state

- Keep speaking during a long turn. One filler was sized for a 6-15s turn; a
  vault question measured 30.4s live, and the listener heard "I'll look that up"
  followed by half a minute of silence and reasonably concluded it had died. A
  progress line now goes out whenever nothing has been heard for 12s
  (`SHIM_PROGRESS_EVERY`, 0 disables), never repeating the previous line — random
  choice over four options repeats about a quarter of the time, and hearing the
  same sentence twice running sounds stuck rather than busy

- Measure silence from the last thing SPOKEN, not from whether anything has been
  spoken at all. A turn commonly says "let me take a look" and then works
  silently for another twenty seconds; an anything-yet test stops watching at the
  first word and leaves exactly the dead air it was added to prevent

- Do not treat a suppressed duplicate as speech. When the model produced its own
  holding sentence and we discarded it as a duplicate of the filler, the flag
  meaning "text reached the listener" was set anyway — so a 34s turn spoke once
  and then went quiet, the watcher believing a reply was in flight while the only
  thing produced had just been thrown away

- Route by an explicit refusal contract rather than a tool call. The front model
  is told to reply `{"cannot_answer": true}` when answering would need the user's
  notes, tasks, files or systems. Measured across 20 factual trials including
  deliberately subtle phrasings — "so what's left for today", "did that finish",
  "anything I should know about" — zero fabrications. The same model given an
  `ask_claude` tool instead invented a task name, count and due date for "can you
  list all active tasks?": it treats a tool as an action needing permission, but
  a refusal token as simply the honest reply. Same model, same questions; only
  the channel changed. Tools are no longer requested

- Route three ways instead of two: recognised chat answers locally (~1s), plainly
  factual skips the round trip and takes a locally-decided filler (0.14s), and
  everything else goes to the front model under the refusal contract. The third
  band is the point — a whitelist cannot enumerate every way of being
  conversational ("yo what's up" is chat, "did that finish" is not), and that
  band is exactly where an allowlist was blunt and a blocklist was unsafe

- Recognise a refusal written in prose. The model gets the judgement right and
  the format wrong often enough to matter: "I do not have any context about what
  finished" was spoken to the user as if it were an answer, because the filter
  only matched "don't have access". Any admission of missing information now
  becomes a consult

- Consult the front tier only for utterances positively recognised as
  conversation; send everything else to Claude without asking. Routing was the
  other way round — anything not matching a list of factual-looking patterns was
  offered to the front model — and that list had a typo: `\btask\b` cannot match
  "tasks", because `\b` requires a non-word character and "s" is not one. "Can
  you list all active tasks?" reached the front tier, which answered with an
  invented task name, an invented count and an invented due date, spoken as fact.
  No such task exists.

  Every other layer failed with it: the model did not call the tool, and a
  confident invention trips neither the hedge nor the leak filter — so a single
  regex was all that stood between a fabrication and the user. A blocklist must
  enumerate every way of asking about the user's world and is wrong the moment it
  misses one; an allowlist is wrong only by being slow, costing a couple of
  seconds when an unrecognised greeting wakes Claude. Verified: both
  fabrication-shaped prompts now route to Claude, greetings still do not

- Widen the factual patterns anyway, as defence in depth: plurals throughout,
  plus "list", "show", "summarise", "remind me", and session/project/ticket
  vocabulary

- Play audio as it arrives instead of when the response completes. The bot
  accumulated every `response.output_audio.delta` and started playback only on
  `response.output_audio.done` — measured on a live turn: 211 deltas held, then
  33.6s of audio released at once. So the early "checking that now", emitted by
  the shim at 0.16s and synthesised separately by speech-to-speech, still reached
  the listener immediately before the answer. Every latency fix upstream was
  being discarded at the last step. Playback now writes into an open PassThrough,
  which pauses on a gap in synthesis rather than ending, and barge-in destroys
  the stream as well as stopping the player

- Say what is happening when we know it. The filler was deliberately vague
  ("hang on") back when a blind timer fired it and "checking that" could be a
  lie in reply to "thank you". It now fires only once a lookup is established —
  the question was recognised as factual, or the model asked for the tool — so
  the informative wording is true, and it tells the user their request landed
  rather than merely that something is alive. Measured at 0.16s

- Filter the front model's words rather than trusting the prompt to govern them.
  Three rounds of prompt-tightening each surfaced a new phrasing: told to call
  `ask_claude` it said "want me to?" instead; told never to ask permission it
  complied on the call and asked permission in the filler; told never to describe
  its own machinery it announced "I have one tool available called ask_claude".
  A reply that hedges or names the machinery is now discarded, and a discarded
  reply becomes a consult — so the bad case costs a lookup rather than reaching
  the user. Verified with the heuristics switched OFF, the hardest configuration:
  7/7 routed correctly with nothing leaked

- Tell the front model that consulting is the normal path, not an escalation.
  The tool description read like a consequential action ("hand the question to
  the full assistant"), which is most of why it asked permission to use it

- Inject an `ask_claude` tool into the front model's request and run the tool in
  the proxy. The proxy owns the loop, so Claude's answer is returned verbatim
  rather than handed back to the front model to reword — an ordinary agent loop
  would let it restate facts about the user's vault in its own words. s2s needs
  no changes because it never learns tools exist

- Skip the front round trip when the question is plainly factual. Asking the
  model whether a lookup is needed costs ~3s to be told what the wording already
  says; the filler lands at 0.14s by deciding locally

- Supply the pause-filler ourselves when the front model returns a tool call with
  no text. Models commonly emit either content or tool calls, so a filler that
  depends on getting both arrives only sometimes

- Add `SHIM_FRONT_HEURISTICS=0` to take the whitelist and factual backstop out of
  the path, leaving routing entirely to the front model. Measured on voice, that
  model defers _verbally_ ("to get the list I'd have to ask the full assistant —
  want me to?") instead of calling the tool, answers about the user's world from
  its own knowledge, and introduces itself as Claude. It fails toward talking
  rather than checking, which is the expensive direction — so the heuristics stay
  on by default and the model's tool call is a second chance to defer, not the
  only one

- Leave exactly one live speech-to-speech socket behind on reconnect. Replacing
  `this.ws` did not silence the socket it replaced — the old object kept its
  message listener and went on feeding the player, so every reply was heard once
  per stale socket and the count grew with each reconnect. One s2s restart was
  enough to start it. Superseded sockets are now unbound and closed, at most one
  reconnect timer is outstanding, and a close from a replaced socket no longer
  schedules a second chain

- Answer pure small talk from a fast hosted model instead of waking Claude Code.
  Measured: "hello" 1.2s and "thank you" 0.8s, against ~2.6s before and 6s+ for a
  lookup. Voice only — a text surface has no latency problem worth a second model

- Route by a closed whitelist of conversational phrases, not by asking the front
  model to decide. A tool-call round trip costs ~0.6s to be told what the
  transcript already says, and it puts a safety-critical judgement inside a model
  that would answer "what did I decide about the deploy" from its own head. The
  match is whole-utterance: "hello" routes to the front tier, "hello, what is my
  most important task" does not. Anything unrecognised, and any front-tier
  failure, falls through to Claude

- Disable thinking on the front model and strip any that leaks. MiniMax emits
  reasoning inside `content` rather than `reasoning_content`, so the first
  version read its own deliberation aloud

- Feed Claude's answers back into the front model's history, or "say that again"
  reaches a model that never heard what it is being asked to repeat

- Lower the filler threshold to 0.5s and the silence floor to 400ms. Both were
  set to guard against problems since fixed — the filler now waits for a
  `tool_use` block rather than firing on any slow turn, and an abandoned turn is
  interrupted in ~0.1s instead of blocking the next one

- Hold the spoken filler until there is evidence of work. A plain timer fires on
  any slow turn, so "thank you" was answered with "Checking now. Won't be long.
  You're welcome." — three sentences of scaffolding around two words. The filler
  now waits for a `tool_use` block, with an 8s fallback for a turn that is slow
  without tools. Verified: a thank-you answers directly at 2.6s with no filler,
  while a lookup still gets its early sentence

- Say nothing about what is happening in the filler itself. "Checking now" and
  "let me look that up" are claims, and the timer that speaks them cannot see
  whether anything is being looked up; the lines are now purely neutral

- Send SSE keepalives so a long turn is not aborted mid-flight. speech-to-speech
  gives up after 20s without bytes and speaks "Wow I'm a bit slow today, could
  you repeat that?" — and because that is a gap between chunks rather than a
  total, any tool phase over 20s killed a turn that was progressing normally.
  The timeout is hardcoded upstream with no CLI flag, so the fix is on our side:
  an empty delta every 8s, which resets the client's read timer and produces no
  speech. A 30s turn that previously died now completes. Covers the wait for the
  per-key lock too, where a queued turn could time out before it even began

- Make the spoken length limit hard and put it last, where the directive is
  strongest. Asking for "one or two sentences" in passing produced six on a live
  call; stating it as a limit that holds however much was found, with an explicit
  alternative — one fact plus an offer of the rest — holds at two, including on
  "summarise everything", the prompt that produced six before. Note that a live
  process keeps the directive it launched with, so changes need a respawn

- Interrupt a voice turn when its listener hangs up, instead of running it to
  completion while holding the per-key lock. speech-to-speech drops its request
  every time it supersedes its own turn, which happens on any mid-sentence pause,
  so the request carrying the finished sentence queued behind one or two dead
  turns. Measured: a follow-up went from 61.8s to 2.5s

- Detect the disconnect by polling the socket, not by waiting for a failed write.
  A turn spends most of its life running tools with nothing to write, so a
  disconnect at second 5 went unnoticed until the answer at second 60. Verified
  that a `control_request` interrupt ends the turn in ~0.1s and the same process
  answers the next prompt normally, so the session is not desynchronised

- Speak the holding line as two sentences. speech-to-speech releases a sentence
  to TTS only once the NEXT one has started, so a lone holding line waited for
  the answer and was spoken immediately before it — emitted at 3s, heard at
  13.4s. The second sentence pushes the first out and lands just before the
  answer. Confirmed on a live call: spoken at 3.0s

- Set `--stream_batch_sentences 1`. Upstream buffers three sentences before
  synthesising anything, which silently defeated every streaming improvement:
  the first sentence could not be heard until the third existed

- Speak a holding line when a voice turn stays silent past 3s, so early speech no
  longer depends on the model choosing to produce it. Tuned to 3s because a warm
  no-tool turn reaches its first word at ~2.4s and a shorter threshold interjects
  in front of an answer that was already arriving; tool turns produce nothing for
  6s or more. When the model does say its own holding sentence, the duplicate is
  recognised and dropped. Override with `SHIM_HOLD_AFTER`, 0 disables

- Route all streamed model text through one emit path. The duplicate check lived
  only on the sentence-split branch, so a holding sentence that arrived without
  trailing punctuation went out via the end-of-block flush and was spoken twice

- Stream assistant text as it arrives instead of waiting for `result`, and run
  Claude Code on a PTY so it line-buffers. Off a pipe it block-buffers and a
  whole turn lands at once; on a PTY chunks arrive ~0.2s apart
- Correction to the caveat above: the model was not refusing to speak before its
  tools. Streaming was never reaching the client at all — `ask_claude` was called
  without an `on_text` callback, so the shim buffered the whole answer and only
  chunked it at send time. With the callback wired, a tool turn produces "Let me
  check that." at ~3s. A fast-LLM tier is therefore no longer the fix

- Stream token deltas via `--include-partial-messages`, split on sentence
  boundaries before handing text to TTS. Without the flag only complete
  `assistant` events arrive and there is nothing to stream; without the split,
  TTS synthesises one clipped utterance per token. Abbreviations, decimals and
  version numbers are guarded against false splits. First speech on a warm
  session: 6.5s to 2.4s

- Classify voice by session key rather than by sniffing the system prompt.
  speech-to-speech selects its voice prompt only when `wants_audio` is set, and
  with TTS as a separate stage it never is — so every real voice turn arrived
  carrying the TEXT prompt, was answered with the text directive, and got no
  live streaming. Text surfaces always carry a `thread:`/`dm:`/`channel:` prefix;
  voice uses the bare default key

- Do not emit assistant text twice. The `assistant` event arrives BEFORE
  `content_block_stop`, so emitting from both spoke each block a second time

- Keep a trailing space on each streamed sentence — deltas are concatenated
  verbatim by the client, so without it a reply reads as "here.That question"

- Raise the speech-to-speech silence floor to 700ms (upstream 64ms, shorter than
  the pause between two words). s2s can reopen a soft-ended turn, but refuses
  once the turn is committed — and streaming commits almost immediately, so
  every pause became a new turn with its own Claude invocation

- Pin STT to English. Auto-detect across 25 languages does not reject unclear
  audio, it transcribes it into fluent nonsense that Claude then answers in good
  faith. Override with `S2S_STT_LANGUAGE`

- Stop leaking the MiniMax API key into `ps`. It was passed as
  `--responses_api_api_key`, so it sat in world-readable argv; it now travels as
  `OPENAI_API_KEY`, which the SDK reads when the flag is absent

- Add `SHIM_CLAUDE_MODEL` to select the model Claude Code runs. Measured no
  latency benefit (sonnet 6.61s vs opus 6.48s warm), kept as a knob

- Log the speech-to-speech error as an object; a bare string was spread into
  `{"0":"c","1":"o",…}` and the message was unreadable

- Voice replies stop reciting identifiers. The directive now forbids ids,
  hashes, byte counts, paths and timestamps explicitly and asks for flowing
  conversational sentences rather than clipped fragments; a regex backstop
  rewrites anything that slips through, because asking a model is not the same
  as guaranteeing

- Client disconnects are handled as normal traffic, not errors.
  speech-to-speech cancels its in-flight request on barge-in and on a
  superseded turn, so the socket is routinely gone before the answer is
  written; that produced an unhandled `BrokenPipeError` traceback per
  cancelled turn

- Leave voice properly on shutdown. `client.destroy()` ran immediately after
  leaving, cutting the gateway before the voice-state update reached Discord —
  so the bot lingered in the channel as a ghost a later process had to evict.
  Now it leaves, evicts, and waits briefly before tearing down
- Ghost eviction falls back to the guild's voice-state cache. `members.me.voice`
  may not be populated at `clientReady`, so a ghost invisible to one cache is
  usually visible to the other

- Transcripts are UTC throughout. The folder date came from `toISOString()`
  (UTC) while the line timestamps were local, so a session just after local
  midnight landed in a folder dated the previous day. UTC is also stable across
  DST and travel; times are suffixed `Z` so it is unambiguous

- The transcriber no longer borrows the speech-to-speech venv: dependencies are
  declared inline (PEP 723) so `uv run` resolves them. The repo no longer needs
  a speech-to-speech checkout to transcribe, and `make dev` starts it alongside
  the rest

- Persistent Claude Code process per session, fed as `stream-json` over stdin
  instead of spawning `claude -p` per turn. Cold 7.6s, warm 5.3s, then 4.4s —
  and context is retained on the live process. Measurement first ruled out the
  obvious suspect: trimming MCP from 15 servers to 1 saved only 1.6s of 11.8s,
  so the cost is CLI startup and only reuse fixes it
- Drop superseded turns. speech-to-speech emits progressive transcription
  finals, so one sentence arrived as four requests that each queued on the
  session lock — four invocations and a multi-second stall. A request that
  finds a newer one waiting now drops itself before doing any work
- Filler short-circuit: bare "okay"/"yeah" no longer wake Claude Code. Bare
  "yes"/"no" deliberately still do — they are answers, not backchannel

- The bot's own replies are recorded too. Its speech never returns through
  Discord, so the transcript was one-sided — questions with no answers. Written
  as timestamped `.txt` sidecars rather than appended directly, so the
  transcriber merges them in order; appending would race, since STT lags and the
  reply would land above the question
- Utterances close on sustained silence (1.5s), not on Discord's `speaking.end`
  — that fires on every brief pause, chopping a sentence into fragments and
  filling the transcript with "Yeah." lines
- Recipes source `local.env` in the shell. Make's `include` reads `$HOME` as an
  empty _Make_ variable and keeps quotes literally, so `TRANSCRIPT_DIR` became
  `"OME/Documents/...` and transcripts landed in a bogus directory

- Always-on transcription: every speaker in the channel is written to a
  speaker-labelled, timestamped `transcript.md` inside the vault, appended live
  so it is readable mid-call. Separate from the command allowlist — the
  allowlist controls who can _drive_ the bot, this controls who is _written
  down_. Announced in-channel on join
- `tools/transcriber.py` watches for segments and transcribes with the same
  Parakeet loader speech-to-speech uses. A separate process on purpose: STT
  must never stall a live conversation, and if it is not running the audio
  simply waits on disk

- Per-speaker audio buffers. Every subscribed speaker was appended to one
  buffer in arrival order, so two people would have produced interleaved
  chunks — worse than a mix, because the samples never align. Now buffered per
  user and summed sample-aligned at send time. Latent until now (the allowlist
  subscribes one person), and it keeps speaker identity available for
  per-speaker STT later

- Strip the CLAUDE.md closer panel from text replies too, not just voice. A chat
  window is not a terminal. Matching is anchored on the state icon rather than
  the keyword: the text after it is free-form, so "⚪ Status check answered" is
  a panel while "⚪ DONE" is the only form a keyword match would catch

- Evict voice connections left by a previous process. Killing the bot mid-call
  left it visible in the channel while `/leave` said "not in a voice channel":
  a new process has no session for it and `getVoiceConnection` only sees its
  own. Now cleared on startup and as a `/leave` fallback, via the gateway voice
  state
- `make run` uses `$$( )` rather than `$(shell )` — Make expands the latter
  itself, baking the token into the `sh -c` argv where `ps` can read it

- Keyed sessions: one Claude Code session per thread/DM/channel via
  `X-Session-Key`, with per-key locks so conversations run concurrently instead
  of queueing behind a single global lock
- `/new` clears the current conversation, `/sessions` lists what is held
- Shim injects a memory directive: anything worth keeping is written to the
  vault before the turn ends, which is what makes clearing a session safe

- Text conversations run in a thread: an `@mention` opens one, follow-ups need
  no mention, and history is scoped to the thread. Falls back to the channel if
  thread permissions are missing rather than dropping the answer

- `make dev` starts the whole local stack (shim + speech-to-speech + bot) and
  stops it cleanly; `SKIP_VOICE=1` for the text surface only
- Repo is now self-contained: the speech-to-speech launcher, the realtime probe
  and the MiniMax patch moved in from outside, where a re-clone would have
  silently destroyed them

- Text surface: DM or `@mention`, thread history resent per turn
- `/join` and `/leave` slash commands — joins the caller's current voice channel
- Sender-level allowlist on both surfaces, failing closed when unset
- `shim/claude_openai_shim.py`: one persistent Claude Code session behind an
  OpenAI-compatible endpoint, with voice-output enforcement
- Adopted the node-skeleton conventions: split Makefiles, `make precommit`,
  `make buca`, Dockerfile, k8s manifests, structured JSON logging
- `/healthz`, `/readiness`, `/version` and graceful shutdown that fails
  readiness before draining
- Security gates: `npm audit` (high/critical) and `trivy fs` (vulns + secrets)
- `make run` resolves the Discord token from TeamVault at run time, with
  fail-fast guards. Config lives in gitignored `local.env` (from
  `local.env.example`); there is no committed env file, because Make variables
  override the environment and would clobber the shell
- Health server moved to 8081 — 8080 belongs to the shim
- `Makefile.k8s` uses `teamvault-cli config parse`; `teamvault-config-parser`
  was retired in v5.7 and silently renders nothing

## v0.0.1

- Initial commit
- Voice bridge: Discord voice channel <-> speech-to-speech realtime <-> OpenAI-compatible endpoint, multi-turn, verified end to end against MiniMax-M3
- `tools/capture.js` + `tools/to16k.py` — voice-receive diagnostics from the spikes
