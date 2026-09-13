# CLAUDE.md

Instructions for working on `bborbe/discord-assistant`.

## What This Is

A Discord bot that bridges text and voice channels to an OpenAI-compatible endpoint, transcribing voice and relaying conversation. Derived from `bborbe/node-skeleton` — `src/log.js` and `Makefile.precommit` are byte-identical to it, and `eslint.config.js` differs only by a `tools/**` console override.

Stack: Node 22+, CommonJS, `discord.js` + `@discordjs/voice`, `prism-media`, `opusscript`, `libsodium-wrappers`, `ws`, the built-in `node:test` runner. Deployed as a container to Kubernetes.

## Coding Guidelines

| Guide                                   | Covers                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `coding/docs/node-service-guide.md`     | Config, logging, health endpoints, metrics, graceful shutdown, testing, k8s couplings |
| `coding/docs/node-makefile-commands.md` | Build targets, security gates                                                         |
| `coding/docs/git-commit-guide.md`       | Commit workflow                                                                       |

Enforced by `node-quality-assistant` via `/coding:pr-review` and `/coding:code-review`.

**Known deviations from the guide** — real gaps, not exemptions:

- **No `/metrics` endpoint and no `prom-client` dependency.** The guide makes this a `MUST`: the service runs in Kubernetes and is currently invisible to Prometheus. It already serves health endpoints over `node:http`, so adding the endpoint is cheap.
- **`config.isAllowed()` lives on the config object.** The guide keeps config data-only; domain predicates belong in the module that owns the concern.

Fixing either is welcome in any PR that already touches the area.

## Non-Obvious Invariants

- **Health endpoints use raw `node:http`, not express** (`src/health.js`) — deliberate. The bot has no HTTP surface of its own, and the guide specifies the health _contract_ (paths, status codes, the liveness/readiness split), not the transport. Do not add express for three routes.
- **`/healthz` must not check the Discord gateway or the LLM endpoint.** A liveness failure restarts the pod; making it depend on Discord would turn a Discord outage into a reconnect storm across every replica. Dependency state belongs in `/readiness`, where failure only drains traffic.
- **The allowlist fails closed** (`src/config.js`). `ALLOWED_USER_IDS` empty means _nobody_, on purpose: this bot can reach a session with vault and repository access. Never default it to permissive.
- **Transcription is separate from the command path.** `ALLOWED_USER_IDS` controls who can _drive_ the bot; `TRANSCRIBE` controls who gets _written down_ — which is everyone in the channel. Recording other people is a consent matter; `ANNOUNCE_TRANSCRIPTION` exists so it is never silent. Do not couple these two settings.
- **`TRANSCRIPT_DIR` must be readable by the shim.** The shim runs with its cwd in the vault and no `--add-dir`, so a path outside it cannot be read mid-call and "what did we just discuss?" fails. Defaults to a repo-local directory so a fresh clone never writes into a vault it was not told about.
- **The LLM endpoint is swappable by design** (`src/config.js`). Nothing in the bot may depend on which backend is behind `OPENAI_BASE_URL`.
- **`VOICE_ENABLED=0` is the deployable mode, not a reduced one.** speech-to-speech needs a GPU and no cluster node has one, so a text-only instance is the only shape that runs outside a laptop. It omits `join`/`leave` from the guild's command list rather than registering them to refuse — a command in that list is a promise the instance can do the thing. Not to be confused with `SKIP_VOICE` in `scripts/dev.sh`, which only skips launching speech-to-speech locally.

## Non-Code Surfaces

Changes here break in ways tests do not catch:

- `patches/` — a patch applied against a dependency. It must keep applying; verify after any dependency change.
- `shim/claude_openai_shim.py` — a **Python** process, started via `npm run shim`. Not covered by the Node guides.
- `tools/` — mixed `.js` and `.py` diagnostics, run by hand from a terminal. `no-console` is deliberately disabled for `tools/**`; a terminal is their interface.
- `scripts/` — dev helpers.

## Build and Test

```bash
make precommit    # install format test check — run before every commit
make test         # node --test
make check        # lint formatcheck audit trivy
npm run shim      # start the Python shim
```

## Verifying Voice Changes

The audio path is the part most likely to break silently, and unit tests do not cover it. Any change touching `src/voice.js`, the decode pipeline, the audio dependencies, **or the shim's spoken-output path** (`shim/claude_openai_shim.py` — truncation, fillers, the `_MORE_LINE` tail) needs a **real voice session**: join a channel, speak, confirm audio is received and decodes to intelligible PCM. "The process started" is not verification — a broken decode path produces silence or garble while every log line looks healthy.

**Check the running config before diagnosing spoken output.** The shim reads `~/.config/discord-assistant/config.yaml` (or `$DISCORD_ASSISTANT_CONFIG`) once at startup: `voice.spoken_max: 0` disables truncation outright, so with it set no truncation tail can be spoken and a missing "the details are in…" line is config, not a code regression. A config change needs a shim restart (`launchctl kickstart -k gui/$(id -u)/com.github.bborbe.discord-assistant-shim`), and the value that matters is the one the _running_ process read, not the repo's.

## Git Workflow

Feature branch → PR to `master` → merge. Never commit directly to `master`.

`.maintainer.yaml` sets `autoRelease: true`: add bullets under `## Unreleased` in `CHANGELOG.md` with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`), and the releaser rewrites the header and tags after merge. **Never hand-tag or rename `## Unreleased` yourself.**
