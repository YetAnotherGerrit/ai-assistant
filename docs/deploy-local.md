# Deploying locally (macOS, launchd)

Run the assistant unattended on a Mac: starting at login, restarting after a crash or a sleep/wake cycle, with no terminal window holding it up.

This is how the assistant runs today. `make dev` remains the way to run it in a terminal while developing.

For the cluster, see [deploy-kubernetes.md](deploy-kubernetes.md).

## What actually runs

Five long-lived processes. `make dev` starts the four app processes in one terminal; launchd starts all five as independent jobs.

| Component        | Port      | Started by                           | Needed for                    |
| ---------------- | --------- | ------------------------------------ | ----------------------------- |
| shim             | 8080      | `python3 shim/claude_openai_shim.py` | both surfaces                 |
| speech-to-speech | 127.0.0.1:8765 | `scripts/s2s-minimax`           | voice only (~60 s model load) |
| gateway          | 0.0.0.0:8766 | `nginx -c <rendered conf>`        | voice from off-host clients   |
| transcriber      | —         | `uv run tools/transcriber.py`        | per-speaker transcripts       |
| bot              | 8081      | `node src/index.js`                  | both surfaces                 |

The transcriber is easy to forget — it has no port, so nothing fails loudly when it is missing; the transcript file simply stops growing.

## The gateway: the one 0.0.0.0 bind

`s2s` has no incoming-client auth. Its `/v1/realtime` handler accepts immediately, so exposing `8765` on the network exposes an unauthenticated voice API. The `gateway` component is nginx in front of it:

```
bot  ──ws://127.0.0.1:8766/v1/realtime?token=…──▶  gateway (0.0.0.0:8766)
                                                       │  403 without a matching token
                                                       ▼
                                              s2s (127.0.0.1:8765) — never on 0.0.0.0
```

**This split is an invariant, not a preference.** The gateway is the only process bound beyond loopback; if it dies, nothing is exposed. Moving `s2s` onto `0.0.0.0` and dropping the gateway would remove the auth boundary entirely — the two are not interchangeable.

The token travels as a `?token=` **query parameter**, not a header, because `src/voice.js:469` opens the socket with no `headers` option. `config.js:70` reads `S2S_URL` from the environment, so this is a config change rather than a code change. `scripts/launchd-run.sh` appends the token to `S2S_URL` at launch for the `bot` component.

### Why `proxy_buffering off`

nginx buffers proxied responses by default. For a voice call that is a silent, total regression: audio is held until the turn completes and then released in one block, so every latency win the streaming pipeline buys is discarded — with no error and no log line. The measured failure mode is 211 deltas held, then 33.6 s dumped at once. `proxy_read_timeout 3600s` is the same class of setting: the 60 s default cuts a live call mid-session during any pause.

### Fail-closed, at three layers

A gateway that starts without a token is worse than one that does not start, so:

1. **The launcher refuses to start** when `S2S_GATEWAY_TOKEN_KEY` is unset. It uses `die_config` (exit 0), so the `KeepAlive/SuccessfulExit=false` rule leaves the job **stopped** rather than respawn-looping.
2. **The render is verified** before nginx is started — the token must appear in the rendered config, and no unsubstituted placeholder may remain. `envsubst` is restricted to an explicit `$RUNTIME_DIR $S2S_GATEWAY_TOKEN` list; a bare `envsubst` would also consume nginx's own `$arg_token`, `$http_upgrade` and `$remote_addr` and silently render them empty.
3. **The `map` denies by default.** If the expected token is empty, every request resolves to `deny`, because no real request carries an empty token.

The rendered config embeds the secret, so it is written `0600` to `~/.local/share/discord-assistant/` — a runtime artifact outside the repo. The tracked `deploy/nginx/s2s-gateway.conf.template` holds no secret.

## Why LaunchAgents, not LaunchDaemons

A **LaunchDaemon runs pre-login as root and cannot do this job**:

1. **No Keychain.** `teamvault-cli` resolves the Discord token through it, and the `claude` CLI the shim drives authenticates through it. Both fail with no user session.
2. **No GUI session**, which several of the above quietly assume.

So: `~/Library/LaunchAgents/`, user context, loaded at login. This matches the 13 LaunchAgents already on this machine (`git-ai-sync-*`, `semantic-search-http-*`, `vault-ui`, `tts-mcp`).

## The TCC trap: launchd cannot execute anything under `~/Documents`

**This bites LaunchAgents too, not only LaunchDaemons** — a distinction commonly stated and wrong. The job dies with exit **126** and a log containing only:

```
shell-init: error retrieving current directory: getcwd: cannot access parent directories: Operation not permitted
/bin/bash: /Users/…/Documents/workspaces/discord-assistant/scripts/launchd-run.sh: Operation not permitted
```

Since this repo lives under `~/Documents`, a plist pointing `ProgramArguments` at `scripts/launchd-run.sh` in place **never starts**. It is not a `chmod` problem; TCC is a separate layer, and no amount of `chmod +x` helps.

Measured on 2026-08-09 with a two-way probe, because the failure mode is easy to misdiagnose:

| Probe                               | Result                            |
| ----------------------------------- | --------------------------------- |
| script in `/tmp`, reading this repo | **runs, reads fine**              |
| identical script inside the repo    | **exit 126 before a single line** |

So only **being executed** from a protected folder is blocked. Reading `~/Documents` afterwards is fine — which is why `semantic-search-http` happily indexes the vaults, and why `tts-mcp` runs with its working directory inside `~/Documents/workspaces`: both are _executed_ from `~/.local/bin`.

The grants are per responsible binary, and visible:

```bash
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "select service,client,auth_value from access
   where service='kTCCServiceSystemPolicyDocumentsFolder';"
```

`/Users/…/.local/bin/uv` appears there with `auth_value 2`. `/bin/bash` does not — which is the whole story.

**Consequence for this deployment:** `make launchd-install` copies `scripts/launchd-run.sh` to `~/.local/bin/discord-assistant-launchd` and the plists point _there_. The repo copy stays the source of truth and the install target always re-copies, so the two cannot drift. The launcher learns where the repo is from `DISCORD_ASSISTANT_REPO`, set in the plist, because it can no longer infer it from its own path.

The plists also set no `WorkingDirectory`: that would make launchd `chdir` into the protected folder before the process exists. The launcher `cd`s itself once running, which is allowed.

## Layout: one plist per process

Five labels, following the existing house convention:

```
com.github.bborbe.discord-assistant-shim
com.github.bborbe.discord-assistant-s2s
com.github.bborbe.discord-assistant-gateway
com.github.bborbe.discord-assistant-transcriber
com.github.bborbe.discord-assistant-bot
```

One job per process, not one job running `dev.sh`. Each restarts on its own, and speech-to-speech's 60-second model load never delays the text surface. The gateway starts in milliseconds — it has no model to load — so voice from an off-host client is reachable long before s2s itself is ready; a client connecting in that window gets a proxy error rather than a hang, which is the honest failure.

Ordering is not expressed and does not need to be: the bot tolerates the shim and s2s being absent, and reconnects when they appear. launchd has no dependency graph for LaunchAgents anyway.

## Credentials never reach a plist

`EnvironmentVariables` in a plist is a literal dict — anything in it is on disk in cleartext. The token must not go there.

Instead each job runs `scripts/launchd-run.sh <component>`, which sources the gitignored `local.env`, resolves secrets at launch, and `exec`s the real process:

- `DISCORD_TOKEN` ← `teamvault-cli password $DISCORD_TOKEN_KEY`
- `SHIM_FRONT_API_KEY` ← `teamvault-cli password $FRONT_API_KEY_ID`
- `S2S_GATEWAY_TOKEN` ← `teamvault-cli password $S2S_GATEWAY_TOKEN_KEY` (gateway and bot, each its own resolution)

This is the same contract the `run` and `shim` Makefile targets already use, including `$$( )` rather than `$(shell )` — Make expands `$(shell )` itself and bakes the literal token into the `sh -c` argv, where any process can read it via `ps`.

Secrets are isolated **per component**, which matters more here than trimming the variable list: the bot needs most of `local.env` to function, so stripping the environment to three variables would simply break it. Instead, each component resolves only its own secret — the bot never holds the shim's `SHIM_FRONT_API_KEY`, the shim never holds `DISCORD_TOKEN`, and neither reaches speech-to-speech or the transcriber. This works because `local.env` deliberately stores no secrets, only the TeamVault key _ids_.

`CHAT_BRIDGE_TOKEN` is the one secret **two** components share — the bot and the shim authenticate to each other with it — but it is no longer an exception to the key-id rule. It used to be stored as a literal in `local.env`, which meant a real shared secret sat in every checkout of a public repo; it now resolves from `CHAT_BRIDGE_TOKEN_KEY` like the rest:

- `CHAT_BRIDGE_TOKEN` ← `teamvault-cli password $CHAT_BRIDGE_TOKEN_KEY` (bot and shim only)

The per-component split is unchanged in effect and stronger in mechanism: speech-to-speech and the transcriber never resolve it at all, rather than receiving it and having it unset afterwards. The launcher also unsets any inherited `CHAT_BRIDGE_TOKEN` before that branch, so a literal left in an operator's shell or a stale `local.env` cannot quietly defeat either rule.

## Bad config stops the job instead of looping

`KeepAlive: true` — what all 13 existing plists use — restarts unconditionally. A revoked token then retries forever at launchd's ~10 s floor, hammering the Discord API with a credential that will never work.

These plists deviate deliberately:

```xml
<key>KeepAlive</key>
<dict>
    <key>SuccessfulExit</key>
    <false/>
</dict>
```

launchd now restarts **only on a non-zero exit**. The launcher exits `0` on an unrecoverable configuration error, so the job stops and stays stopped. A crash still exits non-zero and still restarts.

This reproduces `scripts/supervise.sh`'s exit-2 rule, which it supersedes. **Do not "fix" this back to `KeepAlive: true`** — the dict form is the feature.

### Not every failure is a config error

The dangerous half of this design is deciding what counts as unrecoverable, and the first version got it wrong. During verification a TeamVault request timed out, the launcher called it a config error, and the bot stopped permanently — recreating precisely the silent outage this deployment exists to prevent.

The launcher now classifies, and **defaults to retrying**:

| TeamVault result                          | Verdict                                   | Exit         |
| ----------------------------------------- | ----------------------------------------- | ------------ |
| `401` / `403` / `404`                     | key is gone or unreadable; no retry helps | `0` — stop   |
| empty value with success                  | misconfigured key                         | `0` — stop   |
| timeout, `5xx`, `429`, connection refused | TeamVault was unreachable _just now_      | `75` — retry |
| anything unrecognised                     | assume transient                          | `75` — retry |

Unknown errors retry on purpose. A job that retries too often is visible in the log; a job that stopped when it should not have is invisible until somebody notices the assistant is gone.

Verified against all four shapes with a stubbed `teamvault-cli`, not by reasoning about them.

## Resource limits

```xml
<key>SoftResourceLimits</key>
<dict><key>NumberOfFiles</key><integer>4096</integer></dict>
<key>HardResourceLimits</key>
<dict><key>NumberOfFiles</key><integer>8192</integer></dict>
```

Two macOS traps this avoids:

- **Never set `NumberOfProcesses`.** It is `RLIMIT_NPROC`, which counts every process owned by the UID — not the job's children. A normal desktop is well past 1,000, so a modest value makes every spawn fail `EAGAIN` and the job respawn-loops.
- **`ResidentSetSize` is a no-op.** macOS does not enforce `RLIMIT_RSS`. It documents an intention and protects nothing.

`NumberOfFiles` matters here specifically: the shim spawns `claude` CLI processes, which have a known file-descriptor hoarding failure mode.

## Install

```bash
cp local.env.example local.env     # then fill in; it is gitignored
make install
make launchd-install
```

`launchd-install` generates the five plists from `deploy/launchd/discord-assistant.plist.template` — substituting the component, repo path, home and `PATH` — writes them to `~/Library/LaunchAgents/`, and loads each one. It `bootout`s first, so it is safe to re-run after editing the template.

The plists are generated rather than committed because each embeds an absolute repo path. The template is the committed artifact.

**A plist inherits no `PATH`.** The generated one is explicit and covers every binary the launcher reaches: `uv` and `claude` from `~/.local/bin`, `teamvault-cli` and `node` from `/opt/homebrew/bin`, `python3` from the pyenv shims. Omit it and the job fails with nothing in the log but `command not found`.

## Verify

```bash
make launchd-status                # PID + last exit code per component
curl -s localhost:8080/v1/models   # shim
curl -s localhost:8081/readiness   # bot — gateway connected
```

Then type `status` at the bot in Discord. A process that is running is not the same as a bot that is answering.

## Update, restart, remove

```bash
# after editing a plist
launchctl bootout gui/$(id -u)/com.github.bborbe.discord-assistant-bot
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.github.bborbe.discord-assistant-bot.plist

# restart in place, no plist change
launchctl kickstart -k gui/$(id -u)/com.github.bborbe.discord-assistant-bot

# remove
launchctl bootout gui/$(id -u)/com.github.bborbe.discord-assistant-bot
rm ~/Library/LaunchAgents/com.github.bborbe.discord-assistant-bot.plist
```

`kickstart -k` is enough for a code change; a plist change needs the bootout/bootstrap pair.

## Logs

```
~/Library/Logs/discord-assistant/{shim,s2s,transcriber,bot}.log
```

launchd does not rotate these. They grow without bound; truncate them by hand or add `newsyslog.d` config if it ever matters.

## Troubleshooting

| Symptom                                                          | Cause                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launchctl list` shows a label with **no PID** and exit code `0` | The launcher hit a config error and deliberately stopped. Read the log — it will say which.                                                                                                                                       |
| Non-zero exit code, PID keeps changing                           | Real crash loop. The log has the stack trace.                                                                                                                                                                                     |
| Exit `126`, `Operation not permitted`                            | Installed as a LaunchDaemon instead of a LaunchAgent — TCC is blocking `~/Documents`.                                                                                                                                             |
| Job "running" but nothing works, empty log                       | `ProgramArguments` points at something that no longer exists. Absolute paths only; a plist has no `PATH` unless you set one.                                                                                                      |
| Bot up, voice silent                                             | speech-to-speech still loading models (~60 s), or it died alone — check its own label.                                                                                                                                            |
| Transcript file stops growing                                    | The transcriber died. It has no port, so nothing else notices.                                                                                                                                                                    |
| `Bootstrap failed: 5: Input/output error`                        | The label was still loaded. `launchctl bootout` returns _before_ the job is actually gone, so a hand-run `bootout; bootstrap` pair races itself. `make launchd-install` waits for the label to leave `launchctl list` in between. |

## Not covered here

- **Keeping the laptop awake.** These jobs restart _after_ a sleep/wake cycle; they do not prevent sleep. `caffeinate` is a separate decision.
- **Docker / Docker Compose.** Considered and rejected for local use: `scripts/s2s-minimax` passes `--device mps`, and neither Docker Desktop nor OrbStack passes the GPU into its Linux VM, so speech-to-speech would fall back to CPU on the same machine. The shim would additionally lose Keychain and the local filesystem.
- **Log rotation.**
