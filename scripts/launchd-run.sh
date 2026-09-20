#!/usr/bin/env bash
# Launch one discord-assistant component under launchd.
#
# THE EXIT CODE IS THE CONTRACT. The plists use KeepAlive/SuccessfulExit=false,
# so launchd restarts a job only when it exits non-zero:
#
#   non-zero  the process crashed        -> launchd restarts it
#   0         unrecoverable config error -> launchd leaves it stopped
#
# That is why every configuration failure below exits 0 rather than 1. It looks
# wrong in isolation and is the whole point: a revoked token restarted forever
# hammers the Discord API with a credential that will never work. Supersedes
# scripts/supervise.sh, whose exit-2 rule this reproduces natively.
#
# Exit 0 is reachable ONLY via die_config. The components are not exec'd but run
# under run_server(), which turns any exit of theirs into 75 — because a
# long-running server that returns has failed, whatever status it reports. That
# is not theoretical: `uv run` exits 0 when signalled directly, so a killed
# speech-to-speech read as a successful job and launchd correctly left it down.
#
# Secrets are resolved HERE, at launch, never stored in the plist —
# EnvironmentVariables is a literal dict and would put them on disk in cleartext.
#
#   scripts/launchd-run.sh <shim|s2s|transcriber|bot>

set -uo pipefail

# WHY THIS SCRIPT IS DEPLOYED OUTSIDE THE REPO.
#
# launchd cannot execute anything stored under ~/Documents — TCC denies it and
# the job dies with exit 126, "Operation not permitted", before a single line
# runs. It is not a chmod problem and not specific to LaunchDaemons; a
# LaunchAgent hits it too. Measured 2026-08-09 with a probe: the same script in
# /tmp ran fine and read this repo without complaint; moved into the repo, it
# would not start.
#
# So `make launchd-install` copies this file to ~/.local/bin (not protected,
# and where uv and semantic-search-http already live for the same reason) and
# points the plists there. Reading the repo afterwards is fine — only *being
# executed* from a protected folder is blocked.
#
# The repo therefore cannot be inferred from $0 in the installed copy; the
# plist passes it. Running this file in place still works, for development.
cd "${DISCORD_ASSISTANT_REPO:-$(dirname "$0")/..}" || {
  echo "launchd-run: cannot enter repo ${DISCORD_ASSISTANT_REPO:-$(dirname "$0")/..}" >&2
  exit 0
}

component="${1:-}"

# Exit 0 on purpose — see the header. Restarting cannot fix any of these.
die_config() {
  echo "launchd-run[${component:-?}]: $*" >&2
  echo "launchd-run[${component:-?}]: unrecoverable config error, not restarting" >&2
  exit 0
}

# Exit NON-zero, so KeepAlive restarts us. For anything that might work on a
# retry.
die_transient() {
  echo "launchd-run[${component:-?}]: $*" >&2
  echo "launchd-run[${component:-?}]: transient failure, letting launchd retry" >&2
  exit 75 # EX_TEMPFAIL; being non-zero is what actually matters
}

# Run the component and treat ANY exit from it as abnormal.
#
# These are long-running servers: reaching the end of one is never a success,
# whatever status it reports. That distinction was previously left to the exit
# code, and `uv run` gets it wrong in the one case that matters — measured
# 2026-08-10:
#
#   kill the python CHILD of `uv run`  -> uv exits 143 (signal propagated)
#   kill `uv run` ITSELF               -> uv exits 0   (clean shutdown)
#
# The plist sets KeepAlive/SuccessfulExit=false, so exit 0 means "do not
# restart" — deliberately, since die_config uses it to stop a job whose config
# can never work. A killed `uv` therefore looked like a job that had finished
# its work, and speech-to-speech stayed down until someone noticed voice was
# gone. That is the same silent outage the TeamVault fix above exists to
# prevent, arriving from the opposite direction: there a transient failure was
# treated as fatal, here a fatal one was treated as success.
#
# So the program is no longer exec'd. This wrapper stays alive as the launchd
# job, and translates "the server came back" into exit 75 regardless of what it
# reported. exit 0 is now reachable ONLY through die_config, which is what makes
# the "bad config stops the job" contract mean something.
#
# The trap is what makes not-exec'ing safe: launchd stops a job by signalling
# the process it spawned, which is now this shell, so the signal has to be
# forwarded or the real server would be orphaned on unload.
run_server() {
  "$@" &
  child=$!
  # Memory supervision runs alongside: samples phys_footprint, pushes to the
  # pushgateway, and TERMs the child past its cap — which the wait below turns
  # into exit 75 and a fresh launchd restart. It exits on its own once the
  # child is gone; the trap kills it explicitly so a TERM'd job does not leave
  # an orphan sampler sleeping out its interval.
  watch_memory "$child" &
  watcher=$!
  trap 'kill -TERM "$watcher" "$child" 2>/dev/null' TERM INT
  # `wait` returns early when a trapped signal arrives; loop until the child is
  # genuinely gone, or a forwarded SIGTERM would look like an exit.
  wait "$child"
  rc=$?
  kill "$watcher" 2>/dev/null || true
  while kill -0 "$child" 2>/dev/null; do
    wait "$child"
    rc=$?
  done
  if [ "$rc" -gt 128 ]; then
    die_transient "$component exited on signal $((rc - 128))"
  fi
  die_transient "$component exited with status $rc — a server exiting is never success"
}

# Read phys_footprint in MB for a PID. `ps` RSS reads ~20x low for MPS/MLX
# processes, so the ceiling keys on phys_footprint — the metric Activity
# Monitor and jetsam actually use (see [[Metrics That Lie With Plausible
# Numbers]]). vmmap --summary prints a unit that varies per process
# (B/K/M/G); normalise it, because misreading 9232 KB as 9232 MB is a 1000x
# error that manufactures a leak in an idle process.
footprint_mb() {
  local pid="$1" line value suffix
  line="$(vmmap --summary "$pid" 2>/dev/null | awk '/^Physical footprint:/{print $3; exit}')"
  [ -n "$line" ] || return 1
  value="${line%[KMG]}"
  suffix="${line##*[0-9.]}"
  case "$suffix" in
  G) awk -v v="$value" 'BEGIN{printf "%d", v*1024}' ;;
  M) awk -v v="$value" 'BEGIN{printf "%d", v}' ;;
  K) awk -v v="$value" 'BEGIN{printf "%d", v/1024}' ;;
  *) return 1 ;;
  esac
}

# Largest phys_footprint in the process tree rooted at $1, in MB. The wrapper
# is not the server — the tree is wrapper -> uv -> python (or node / python3
# directly), and the real memory lives in the deepest process. Sample the whole
# tree and take the largest: the property being measured decides the PID, not a
# label. (The same lesson as the 2026-08-10 triage, where identifying the
# process by name reported a healthy service as DOWN.)
tree_footprint_mb() {
  local pid="$1" mb total=0 child
  mb="$(footprint_mb "$pid")" || mb=0
  total="$mb"
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    mb="$(tree_footprint_mb "$child")"
    [ "$mb" -gt "$total" ] && total="$mb"
  done
  echo "$total"
}

# Push one phys_footprint sample to the pushgateway. Best-effort: a failed
# push is logged nowhere and disables nothing — the cap is the load-bearing
# half, the push is telemetry.
push_footprint() {
  local component="$1" mb="$2" pass="$3"
  [ -n "$pass" ] || return 0
  local url="${PUSHGATEWAY_URL:-https://pushgateway.prod.nuke.benjamin-borbe.de}"
  local user="${PUSHGATEWAY_USERNAME:-monitoring}"
  printf '# TYPE ai_assistant_phys_footprint_bytes gauge\nai_assistant_phys_footprint_bytes{component="%s"} %d\n' \
    "$component" $((mb * 1048576)) |
    curl -sS -u "$user:$pass" --data-binary @- \
      "$url/metrics/job/ai-assistant/instance/$component" >/dev/null 2>&1 || true
}

# Watch one component's memory: sample phys_footprint on an interval, push each
# sample to the pushgateway, and restart the component past its cap.
#
# Restarting is a TERM to the child, which run_server() turns into exit 75 and
# launchd restarts fresh — the existing supervised-restart contract, nothing
# new. The cap cannot be a plist key (ResidentSetSize / RLIMIT_RSS is a
# documented no-op on macOS), so the bound lives here, in the supervisor.
#
# Env (all optional):
#   MEMORY_CAP_MB_<component>  cap in MB for this component; unset = default below
#   MEMORY_CAP_MB              fallback cap for any component without a specific one
#   MEMORY_SAMPLE_INTERVAL     seconds between samples (default 60)
#   PUSHGATEWAY_PASSWORD_KEY   TeamVault key id for the basic-auth password;
#                              unset = telemetry disabled, cap still enforced
#   PUSHGATEWAY_URL / PUSHGATEWAY_USERNAME  defaults target nukeprod monitoring
watch_memory() {
  local child="$1" mb cap pass=""
  local cap_var="MEMORY_CAP_MB_${component}"
  cap="${!cap_var:-${MEMORY_CAP_MB:-}}"
  # Defaults bound the real consumers: s2s cold-loads ~5.5 GB and peaks ~8 GB
  # mid-turn, so 12 GB sits above any single-turn peak yet far below the 50 GB
  # the 2026-08-10 OOM produced; the transcriber is already cache-limited
  # (~2.4 GB active + 512 MB cap), so 4 GB is pure headroom; shim and bot are
  # tens of MB. Override any of them with MEMORY_CAP_MB_<component> in local.env,
  # or set MEMORY_CAP_MB=0 to disable supervision for that component.
  if [ -z "$cap" ]; then
    case "$component" in
    s2s) cap=12288 ;;
    transcriber) cap=4096 ;;
    shim | bot) cap=2048 ;;
    *) cap=0 ;;
    esac
  fi
  # Resolved HERE so only this subshell holds it — never exported to the
  # component (resolve_secret's die_config would also kill the cap on a
  # rejection, which is backwards: telemetry must not take the ceiling down).
  if [ -n "${PUSHGATEWAY_PASSWORD_KEY:-}" ] && command -v teamvault-cli >/dev/null 2>&1; then
    pass="$(teamvault-cli password "$PUSHGATEWAY_PASSWORD_KEY" 2>/dev/null || true)"
    [ -n "$pass" ] ||
      echo "launchd-run[$component]: pushgateway password unresolvable ($PUSHGATEWAY_PASSWORD_KEY) — telemetry disabled, cap still enforced" >&2
  fi
  local interval="${MEMORY_SAMPLE_INTERVAL:-60}"
  while kill -0 "$child" 2>/dev/null; do
    mb="$(tree_footprint_mb "$child")"
    if [ "$mb" -gt 0 ]; then
      push_footprint "$component" "$mb" "$pass"
      if [ "$cap" -gt 0 ] && [ "$mb" -gt "$cap" ]; then
        echo "launchd-run[$component]: phys_footprint ${mb} MB exceeds cap ${cap} MB — restarting" >&2
        kill -TERM "$child" 2>/dev/null
        return 0
      fi
    fi
    sleep "$interval"
  done
}

# Resolve a TeamVault secret into RESOLVED_SECRET, distinguishing "this key will
# never work" from "TeamVault happened to be unreachable".
#
# Found the hard way on 2026-08-09: a TeamVault request timed out, the launcher
# called it a config error, and the bot stopped and stayed stopped — recreating
# the exact silent outage this deployment exists to prevent. Only a definitive
# rejection stops the job now; everything else retries. A job that retries too
# often is visible in the log, a job that stopped when it should not have is
# invisible until someone notices the assistant is gone.
#
# NOTE: sets a global rather than printing. Called via $( ), die_config's exit
# would end the subshell and the caller would sail on with an empty token.
RESOLVED_SECRET=""
resolve_secret() {
  key="$1"
  name="$2"
  out=$(teamvault-cli password "$key" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    RESOLVED_SECRET="$out"
    return 0
  fi
  case "$out" in
  # Absent, or we may not read it. No retry fixes either. 408/429 deliberately
  # excluded — those are retryable and must not match.
  *"status: 401"* | *"status: 403"* | *"status: 404"*)
    die_config "$name=$key rejected by TeamVault: $out"
    ;;
  esac
  if [ "$rc" -eq 0 ]; then
    die_config "$name=$key resolved to an empty value"
  fi
  die_transient "TeamVault unreachable resolving $name=$key: $out"
}

case "$component" in
shim | s2s | transcriber | bot | gateway) ;;
*) die_config "usage: launchd-run.sh <shim|s2s|transcriber|bot|gateway>" ;;
esac

[ -f local.env ] || die_config "local.env missing — cp local.env.example local.env"
set -a
# shellcheck disable=SC1091
. ./local.env
set +a

# Per-component secret isolation. local.env holds no secrets, only the
# TeamVault key *ids*, so the only secrets in this process are the ones
# resolved below — and each component resolves only its own.
#
# CHAT_BRIDGE_TOKEN used to be the one exception: a real shared secret sitting
# in local.env, which put it in every checkout of a public repo. It now follows
# the same key-id rule as everything else, resolved from CHAT_BRIDGE_TOKEN_KEY.
#
# It is now the one secret THREE components share: the bot and the shim
# authenticate to each other with it, and s2s must send it to the shim's
# /chat/completions (every mutating shim route is guarded by it). transcriber
# still needs it for nothing, so it never resolves it — that is the isolation,
# and it is now enforced by not fetching rather than by unsetting after the
# fact.
#
# Unset unconditionally first: an operator's shell (or a stale local.env) can
# still export the literal, and inheriting it would silently defeat both the
# key-id rule and the per-component split.
inherited_chat_bridge_token="${CHAT_BRIDGE_TOKEN:-}"
unset CHAT_BRIDGE_TOKEN
case "$component" in
bot | shim | s2s)
  if [ -n "${CHAT_BRIDGE_TOKEN_KEY:-}" ]; then
    command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
    resolve_secret "$CHAT_BRIDGE_TOKEN_KEY" CHAT_BRIDGE_TOKEN_KEY
    CHAT_BRIDGE_TOKEN="$RESOLVED_SECRET"
    export CHAT_BRIDGE_TOKEN
  elif [ -n "$inherited_chat_bridge_token" ]; then
    # Half-migrated local.env: the literal is still there, the key id is not.
    # Warn rather than die — the bridge is optional and the rest of the
    # component works fine without it. But it must not be SILENT: the bridge
    # fails closed, so the only other symptom is spoken replies quietly
    # ceasing to appear in the channel, which reads as a bug in the feature
    # rather than a missing variable.
    echo "launchd-run[$component]: CHAT_BRIDGE_TOKEN is set as a literal but CHAT_BRIDGE_TOKEN_KEY is not." >&2
    echo "launchd-run[$component]: the literal is IGNORED and the chat bridge is DISABLED — migrate local.env to CHAT_BRIDGE_TOKEN_KEY (see local.env.example)." >&2
  fi
  ;;
esac

# The gateway's own secret, and only the gateway's. Per-component isolation
# applies here as everywhere else: the gateway never holds CHAT_BRIDGE_TOKEN,
# DISCORD_TOKEN or the shim's key, and no other component holds this one.
#
# The same secret necessarily appears in two components — the gateway checks
# it, and the bot presents it as the ?token= query param on S2S_URL — but they
# are two independent resolutions of one TeamVault key, not a shared variable,
# so neither component can observe the other's copy.
case "$component" in
gateway)
  command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
  # die_config, not a warning: the gateway is the ONLY thing standing between
  # the QUANT network and an unauthenticated voice API. A gateway that starts
  # without a token is worse than one that does not start at all.
  [ -n "${S2S_GATEWAY_TOKEN_KEY:-}" ] || die_config "S2S_GATEWAY_TOKEN_KEY unset in local.env — refusing to start an open gateway"
  resolve_secret "$S2S_GATEWAY_TOKEN_KEY" S2S_GATEWAY_TOKEN_KEY
  S2S_GATEWAY_TOKEN="$RESOLVED_SECRET"
  export S2S_GATEWAY_TOKEN
  ;;
esac

case "$component" in
shim)
  # Without this the assistant is never told where a call's transcript lives,
  # the pointer is silently omitted, and "what did we just discuss?" fails with
  # no error. Wired here rather than left to whoever remembers to export it.
  export SHIM_TRANSCRIPT_DIR="${TRANSCRIPT_DIR:-}"
  if [ -n "${FRONT_API_KEY_ID:-}" ] && [ -z "${SHIM_FRONT_API_KEY:-}" ]; then
    command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
    resolve_secret "$FRONT_API_KEY_ID" FRONT_API_KEY_ID
    SHIM_FRONT_API_KEY="$RESOLVED_SECRET"
    export SHIM_FRONT_API_KEY
  fi
  run_server python3 -u shim/claude_openai_shim.py
  ;;

s2s)
  launcher="${S2S_LAUNCHER:-$PWD/scripts/s2s-minimax}"
  [ -x "$launcher" ] || die_config "s2s launcher not executable: $launcher"
  export S2S_MODE=realtime
  # The launcher is named for its DEFAULT backend and hardcodes
  # `--responses_api_base_url https://api.minimax.io/v1`. It only reaches Claude
  # Code because trailing "$@" args override those flags — so launching it bare
  # silently routes voice to MiniMax. Nothing errors: the bot answers, in a
  # different voice, with no vault access, leaking MiniMax's own tool-call
  # markup into replies. Shipped exactly that way in v0.8.0 and caught by using
  # it, not by any check.
  #
  # Overrides come from local.env, so voice and text cannot drift onto
  # different endpoints.
  #
  # The api key here is the CONTROL-PLANE token, not OPENAI_API_KEY: the shim's
  # /chat/completions now requires CHAT_BRIDGE_TOKEN (the shared secret the
  # bot and shim authenticate to each other with — every mutating shim route
  # is guarded by it). The old default `${OPENAI_API_KEY:-not-needed}` was a
  # literal the shim ignored; it is exactly the hole this guard closes. Passed
  # in argv like any api key because it IS one (the SDK sends it as the
  # Authorization header); CHAT_BRIDGE_TOKEN itself is resolved from TeamVault
  # above, never from a literal in local.env.
  [ -n "${OPENAI_BASE_URL:-}" ] || die_config "OPENAI_BASE_URL unset in local.env — voice would silently fall back to MiniMax"
  [ -n "${OPENAI_MODEL:-}" ] || die_config "OPENAI_MODEL unset in local.env — voice would silently fall back to MiniMax"
  [ -n "${CHAT_BRIDGE_TOKEN:-}" ] || die_config "CHAT_BRIDGE_TOKEN unset — the shim's /chat/completions fails closed without it"
  run_server "$launcher" \
    --responses_api_base_url "$OPENAI_BASE_URL" \
    --responses_api_api_key "$CHAT_BRIDGE_TOKEN" \
    --model_name "$OPENAI_MODEL"
  ;;

transcriber)
  command -v uv >/dev/null 2>&1 || die_config "uv not on PATH"
  run_server uv run tools/transcriber.py
  ;;

bot)
  command -v teamvault-cli >/dev/null 2>&1 || die_config "teamvault-cli not on PATH"
  [ -n "${DISCORD_TOKEN_KEY:-}" ] || die_config "DISCORD_TOKEN_KEY unset in local.env"
  # Resolved here, at launch, and never via a Make $(shell ) — Make would expand
  # that itself and bake the literal token into the sh -c argv, readable by any
  # process via ps. Same reason the `run` target uses $$( ).
  resolve_secret "$DISCORD_TOKEN_KEY" DISCORD_TOKEN_KEY
  DISCORD_TOKEN="$RESOLVED_SECRET"
  export DISCORD_TOKEN

  # Append the gateway token to S2S_URL. src/voice.js:469 opens the socket as
  # `new WebSocket(config.s2sUrl, { maxPayload: 0 })` — no headers option — so
  # a URL query param is the one auth channel available without editing the
  # bot's connection code. config.js:70 reads S2S_URL from the environment, so
  # this is a config change, not a code change.
  #
  # Resolved separately from the gateway's copy above (same TeamVault key, two
  # independent resolutions) so neither component can read the other's.
  #
  # die_config when unset, deliberately: falling back to the bare URL would
  # point the bot at the gateway with no token, which 403s every call — voice
  # would fail with a connection error that says nothing about the real cause.
  # Refusing to start states the actual problem.
  [ -n "${S2S_GATEWAY_TOKEN_KEY:-}" ] || die_config "S2S_GATEWAY_TOKEN_KEY unset in local.env — the bot cannot authenticate to the s2s gateway"
  resolve_secret "$S2S_GATEWAY_TOKEN_KEY" S2S_GATEWAY_TOKEN_KEY
  gateway_token="$RESOLVED_SECRET"
  [ -n "${S2S_URL:-}" ] || die_config "S2S_URL unset in local.env"
  case "$S2S_URL" in
  *\?*) S2S_URL="$S2S_URL&token=$gateway_token" ;;
  *) S2S_URL="$S2S_URL?token=$gateway_token" ;;
  esac
  export S2S_URL

  # No supervise.sh wrapper: launchd is the supervisor now, and nesting one
  # inside the other would hide the exit code the KeepAlive rule depends on.
  run_server node src/index.js
  ;;

gateway)
  # nginx as the authenticating reverse proxy in front of speech-to-speech.
  # See deploy/nginx/s2s-gateway.conf.template for the why and the config.
  #
  # s2s keeps binding 127.0.0.1; this is the ONLY 0.0.0.0 bind in the stack,
  # and it is token-gated. If this job dies, nothing is exposed.
  command -v nginx >/dev/null 2>&1 || die_config "nginx not on PATH — brew install nginx"

  template="$PWD/deploy/nginx/s2s-gateway.conf.template"
  [ -f "$template" ] || die_config "gateway config template missing: $template"

  # The rendered config embeds the token, so it is a runtime artifact and never
  # a tracked file. ~/.local/share is outside the repo on purpose: anything
  # written under the checkout risks being committed by a later `git add -A`.
  runtime_dir="${S2S_GATEWAY_RUNTIME_DIR:-$HOME/.local/share/discord-assistant}"
  mkdir -p "$runtime_dir" || die_config "cannot create runtime dir $runtime_dir"
  chmod 700 "$runtime_dir"
  conf="$runtime_dir/s2s-gateway.conf"

  # envsubst restricted to an explicit variable list, and the template uses the
  # __NAME__ placeholder form precisely so the substituted names are disjoint
  # from nginx's own variables. Bare `envsubst` (or a wider list) would also
  # eat $arg_token / $http_upgrade / $remote_addr and silently render them
  # empty — producing a gateway that 403s every request, or proxies with no
  # upgrade headers. The list is the fix; do not widen it casually.
  #
  # umask before the redirect so the file is never briefly world-readable.
  ( umask 077; RUNTIME_DIR="$runtime_dir" S2S_GATEWAY_TOKEN="$S2S_GATEWAY_TOKEN" \
      envsubst '$RUNTIME_DIR $S2S_GATEWAY_TOKEN' \
      < "$template" > "$conf" ) || die_config "envsubst failed rendering $conf"
  chmod 600 "$conf"

  # Fail-closed verification at the source: refuse to start rather than serve a
  # broken or open proxy. Both checks are needed and neither implies the other.
  #
  # grep -F, not a regex — the token is hex but must not be interpreted.
  if ! grep -qF "$S2S_GATEWAY_TOKEN" "$conf"; then
    rm -f "$conf"
    die_config "token absent from rendered config — refusing to start an open gateway"
  fi
  # A leftover placeholder means the substitution silently missed, which would
  # hand nginx a literal "__RUNTIME_DIR__" path and a pid/log path that cannot
  # be created. Cheap to assert here, obscure to debug from an nginx error.
  if grep -q '__RUNTIME_DIR__\|__S2S_GATEWAY_TOKEN__' "$conf"; then
    rm -f "$conf"
    die_config "unsubstituted placeholder left in rendered config — refusing to start"
  fi

  # A stale nginx.pid from a hard kill would make the new master refuse to
  # start ("invalid PID number"); removing it is safe because nothing else
  # owns this runtime dir.
  rm -f "$runtime_dir/nginx.pid"

  # No `daemon off` flag here: the template sets it, and passing it in both
  # places makes nginx warn about a duplicate directive on every start.
  run_server nginx -c "$conf" -e "$runtime_dir/error.log"
  ;;
esac
