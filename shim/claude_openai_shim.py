#!/usr/bin/env python3
"""OpenAI-compatible endpoint backed by keyed, persistent Claude Code sessions.

    python3 shim/claude_openai_shim.py

Any OpenAI client can point at http://127.0.0.1:8080/v1. Clients that send
`X-Session-Key` get their own conversation; clients that cannot send headers
(speech-to-speech) share the default one, so voice stays continuous.

WHY KEYED SESSIONS, NOT ONE
    An earlier design used a single session so a voice turn and a text turn
    shared context. That requirement is a symptom of not having durable memory.
    The rule from Agent System Concept — "the identity agent may hold
    conversation in memory precisely because it never holds *work* in memory" —
    means anything that matters is written to the vault. Session context is
    therefore a cache, not the record: it can be cleared, and continuity comes
    from the vault instead. That buys parallel conversations and bounded
    context, and costs nothing that was not recoverable anyway.

OPENAI-SHAPED BUT STATEFUL — a deliberate deviation:

  role            handling      why
  ------------    -----------   ----------------------------------------------
  system          pass through  per-request output rules (voice sends speech rules)
  latest user     the turn      the actual new input
  everything else DISCARD       the session already has the history

Clients resend full history per the spec; appending it to a session that
already has it would double context every turn and fork a second, divergent
history.
"""

from __future__ import annotations

import hmac
import json
import os
import pty
import random
import re
import select
import socket as _socket
import subprocess
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Lock, Thread

# ── configuration ──────────────────────────────────────────────────────────
# One flat config for one instance. Deliberately NOT multi-profile: two
# configurations means two deployments, which k8s already expresses better than
# a profile key would, and a single active profile is the only thing this
# process could ever use anyway.
#
# Precedence is env > file > default, in that order. Environment last-word is
# what keeps this k8s-native — a ConfigMap or a plain `SHIM_*` var still wins,
# and an instance with no config file behaves exactly as before.
#
# Secrets are named, never carried: `front.api_key_id` is a TeamVault key id,
# resolved by the launcher into `SHIM_FRONT_API_KEY`. This file is not
# gitignored the way `local.env` is, so it must stay safe to read.
CONFIG_FILE = Path(os.environ.get(
    "DISCORD_ASSISTANT_CONFIG", Path.home() / ".config/discord-assistant/config.yaml"))


def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        import yaml
    except ImportError:
        print(f"  config: {CONFIG_FILE} present but PyYAML is not installed — ignoring", flush=True)
        return {}
    try:
        return yaml.safe_load(CONFIG_FILE.read_text()) or {}
    except Exception as e:
        # Loud but not fatal: a typo in the config must not take the endpoint
        # down, and every value has a working default behind it.
        print(f"  config: {CONFIG_FILE} unreadable ({e}) — using defaults", flush=True)
        return {}


_CFG = _load_config()


def setting(env: str, path: str, default):
    """One value, resolved env > config file > default.

    `path` is dotted (`front.model`). Types follow the default: an int default
    parses an int, so config and env agree rather than one yielding a string.
    """
    raw = os.environ.get(env)
    if raw is None:
        node = _CFG
        for part in path.split("."):
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                break
        raw = node
    if raw is None:
        return default
    if isinstance(default, bool):
        # Quotes stripped and "off" included so this agrees with the bot's
        # `flag()` (src/config.js) on every spelling. It did not: `X=off` read
        # as TRUE here and false there, and a Make-quoted `"0"` read as TRUE on
        # both — a switch that looks set and isn't is worse than no switch.
        return str(raw).strip().strip("\"'").lower() not in ("0", "false", "no", "off", "")
    if isinstance(default, int) and not isinstance(default, bool):
        return int(raw)
    if isinstance(default, float):
        return float(raw)
    return str(raw)


def _expand(p: str) -> str:
    return str(Path(p).expanduser())


HOST = setting("SHIM_HOST", "host", "127.0.0.1")
PORT = setting("SHIM_PORT", "port", 8080)
MODEL = setting("SHIM_MODEL", "model", "claude-code")
CWD = _expand(setting("SHIM_CWD", "cwd", str(Path.home() / "Documents/Obsidian/Personal")))
MCP_CONFIG = _expand(setting(
    "SHIM_MCP_CONFIG", "mcp_config", str(Path.home() / ".claude/mcp-obsidian-personal.json")))
# The launcher that starts Claude, e.g. ~/Documents/workspaces/scripts/cc-personal.
# Naming a script rather than restating its flags is the point: the wrapper
# already pins the router, model, effort and --add-dir set that every other
# entry point uses, and a second copy of that list here drifts from it silently.
# vault-cli solves the same problem the same way, with `claude_script` per vault.
_script = setting("SHIM_CLAUDE_SCRIPT", "claude_script", "").strip()
CLAUDE_SCRIPT = _expand(_script) if _script else ""
TIMEOUT = setting("SHIM_TIMEOUT", "timeout", 300)
# How much of a dead claude's stderr to keep for the error it raises. Matches
# the [:400] the legacy path already uses, so a failure reads the same however
# it was reached — bounded, because this text lands in the reply as well as the
# log, and generous enough to keep the line that explains the failure.
_STDERR_TAIL_CHARS = 400
# Which model Claude Code itself runs. Distinct from SHIM_MODEL above, which is
# only the name advertised to OpenAI clients. Empty = the CLI's own default.
#
# Worth setting for voice: a warm turn costs ~5.5s even for a trivial reply
# (measured 2026-08-03), and most spoken requests are retrieval or commands
# rather than reasoning, so a smaller model shortens the answer itself — unlike
# an acknowledgement tier, which only shortens the silence before it.
CLAUDE_MODEL = setting("SHIM_CLAUDE_MODEL", "claude_model", "").strip()

# Blast radius. Anyone on the Discord allowlist reaches this session, so the
# tool set is bounded rather than left at "whatever Claude Code can do".
# Derived from the /first-mate command's own allowed-tools: read and write the
# vault, search it, query GitHub read-only, and nothing else. Notably absent:
# unrestricted Bash, WebFetch, and any mutating git or kubectl.
#
# `--allowed-tools` is an allowlist, so anything not named here is refused —
# and because -p disables interactive prompts, refusal is a clean failure
# rather than a hang. Set SHIM_ALLOWED_TOOLS to override, or SHIM_UNSAFE=1 to
# drop the restriction entirely (do that only against a throwaway vault).
DEFAULT_ALLOWED_TOOLS = ",".join([
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(vault-cli:*)",
    "Bash(date:*)", "Bash(shasum:*)", "Bash(ls:*)",
    "Bash(gh api:*)", "Bash(gh pr view:*)", "Bash(git ls-remote:*)",
    "mcp__semantic-search__search_related",
    "mcp__semantic-search__check_duplicates",
])
ALLOWED_TOOLS = setting("SHIM_ALLOWED_TOOLS", "allowed_tools", DEFAULT_ALLOWED_TOOLS)
UNSAFE = setting("SHIM_UNSAFE", "unsafe", False)
SESSIONS_FILE = Path(_expand(setting(
    "SHIM_SESSIONS_FILE", "sessions_file", str(Path.home() / ".claude/shim-sessions.json"))))
DEFAULT_KEY = "default"

# ── front tier ─────────────────────────────────────────────────────────────
# A small hosted model answers pure conversation, so "hello" does not pay the
# ~2.4s a Claude Code turn costs before its first word. Everything else goes to
# Claude untouched.
#
# The ROUTING is a closed whitelist here, not a decision the front model makes.
# Letting it choose costs a round trip (~0.6s) to be told what the transcript
# already says, and puts a safety-critical judgement inside a model: answering
# "what did I decide about the deploy" from its own head produces a fluent
# invention about the user's vault, spoken in the assistant's voice. A closed set
# of phrases cannot drift, and anything unrecognised falls through to Claude.
#
# Disabled unless a key is present, so a missing credential degrades to today's
# behaviour rather than breaking voice.
FRONT_BASE_URL = setting("SHIM_FRONT_BASE_URL", "front.base_url", "https://api.minimax.io/v1").rstrip("/")
FRONT_MODEL = setting("SHIM_FRONT_MODEL", "front.model", "MiniMax-M3")
FRONT_API_KEY = os.environ.get("SHIM_FRONT_API_KEY", "").strip()
FRONT_TIMEOUT = setting("SHIM_FRONT_TIMEOUT", "front.timeout", 4.0)
FRONT_HISTORY = setting("SHIM_FRONT_HISTORY", "front.history", 8)
# The hand-written whitelist and factual backstop below are a bet that pattern
# matching routes better than the model does. SHIM_FRONT_HEURISTICS=0 takes them
# out of the path so the front model decides every turn on its own — slower, but
# it is the honest baseline the heuristics have to beat.
FRONT_HEURISTICS = setting("SHIM_FRONT_HEURISTICS", "front.heuristics", True)

# ── chat bridge ────────────────────────────────────────────────────────────
# The back-edge that lets a spoken answer also land in the channel as text.
# See the task's `# Design`: the shim already computes the full answer and
# discards everything past SPOKEN_MAX — this posts what would otherwise be
# thrown away to the bot's health server, which owns channel routing because
# it (not the shim) knows which voice call is actually live.
#
# CHAT_BRIDGE_TOKEN is read directly from the environment, never via
# `setting()`'s config-file fallback and never via argv — the secret-in-argv
# class has bitten this repo twice (visible in `ps`, logged by supervisors).
# Both processes read the SAME env var name by convention (see local.env.example)
# so a name mismatch cannot silently strand the secret on one side.
CHAT_BRIDGE_URL = setting("SHIM_CHAT_BRIDGE_URL", "chat_bridge.url", "http://127.0.0.1:8081/chat")
CHAT_BRIDGE_TOKEN = os.environ.get("CHAT_BRIDGE_TOKEN", "").strip()
CHAT_BRIDGE_TIMEOUT = setting("SHIM_CHAT_BRIDGE_TIMEOUT", "chat_bridge.timeout", 5.0)


def control_authorized(supplied: str) -> bool:
    """True iff `supplied` (the raw `Authorization` header value) matches the
    shared control-plane token.

    The one check that gates every shim route mutating state (see `do_POST`).
    The bot and the shim authenticate to each other with the same
    `CHAT_BRIDGE_TOKEN`, exactly like the chat-bridge back-edge. Fail-closed on
    an empty token: a shim that lost its secret must refuse every mutating
    route rather than admit anyone who can merely reach the port.
    """
    if not CHAT_BRIDGE_TOKEN:
        return False
    return hmac.compare_digest(supplied, f"Bearer {CHAT_BRIDGE_TOKEN}")

# The model has no tool for this and makes no decision about it — the posting
# is done here, in code. But it still has to know the channel is reachable,
# because otherwise it truthfully reports the old limitation: caught on a live
# call 2026-08-09, asked to "write it to the chat", it answered "I can only
# speak, not type into the channel" while this very bridge was armed.
#
# Note what this directive does NOT say: it never asks the model to decide, to
# emit a marker, or to call anything. It corrects a factual belief and gets out
# of the way. The LENGTH rule above still binds what is SPOKEN; the full text
# reaching the channel is exactly the point of the cap.
CHAT_BRIDGE_DIRECTIVE = (
    "WRITTEN COPY. Everything you write this turn is ALSO posted into the voice "
    "channel's text chat, in full and automatically. Only the opening is spoken; the "
    "whole thing is readable. This is why the SHAPE rule above says answer first, "
    "detail after — the two halves go to different senses, not to different people.\n"
    "So NEVER say you can only speak, that you cannot type, or that you have no way "
    "to put something in the chat. That was true once and is not true now.\n"
    "When asked to write something down — a name, a list, a link, a price — do not "
    "announce that you have put it somewhere. Just answer, in full: the writing IS "
    "the answer, and it arrives without you saying so."
)

# The inverse of the above, injected when this conversation has silenced chat
# posting (see the voice-only switch below). Without it the model keeps its
# in-context belief that everything it writes is posted — so it says "the
# details are in the chat" into a channel the user explicitly silenced, and
# the silencing looks broken from the user's side. Same correction, opposite
# sign: never claim written copy is in the channel, because it is not.
CHAT_BRIDGE_VOICE_ONLY_DIRECTIVE = (
    "WRITTEN COPY. The voice channel's text chat is currently SILENCED for this "
    "conversation — the user asked for speech only. Nothing you write is posted "
    "there. So NEVER say something is or will be in the chat, and never offer to "
    "write it there. If the user asks you to write it down, say it out loud "
    "instead — the written copy is still recorded to the transcript, but the "
    "channel stays quiet."
)

# The mode change must reach the model as IN-CONTEXT FACT, not only as a
# system directive — precedent beats the system prompt (the hub page's
# documented lesson; observed live 2026-09-03, the model said "the details
# are in the chat" into a silenced channel). Prepended to the user's prompt,
# so the statement lands in the session history the model reads every turn.
# The OFF note is restated on every silenced turn so a long voice-only
# conversation cannot drift; the ON note is prepended on the turn that flips
# back, announcing posting is live again. `remember()` mirrors them into the
# front model's view, keeping both tiers consistent.
CHAT_MODE_CONTEXT_NOTE_OFF = (
    "REMINDER: voice-only mode is ON for this conversation — the user asked "
    "to stop posting to the channel. Nothing you write is posted to the voice "
    "channel's text chat; the transcript records it instead. So NEVER say "
    "something is or will be in the chat, and never offer to write it there."
)
CHAT_MODE_CONTEXT_NOTE_ON = (
    "NOTE: the user has turned chat posting back ON — voice-text mode is "
    "active again. Everything you write IS posted to the voice channel's text "
    "chat, in full and automatically. You may say the details are in the chat."
)

# ── typed-turn hint ────────────────────────────────────────────────────────
# A turn the user TYPED during a live call reaches us through speech-to-speech
# looking exactly like a spoken one — no session key, no output mode, nothing
# in the text that distinguishes it. That indistinguishability is by design
# (it is what lets the same pipeline answer both), and it is also why the
# chat-bridge triggers cannot see the difference on their own.
#
# So the bot says so out of band: it POSTs here immediately before pushing the
# typed turn into its s2s socket, and the next turn on that key consumes the
# flag. One-shot, and it fails in the safe direction — a stale hint costs one
# unnecessary post, never a missing one.
#
# Why the hint matters: the spoken reply is capped at SPOKEN_MAX sentences, so
# without it a typed question is the ONLY kind whose full answer reaches
# nobody — you typed it because it was precise, and the precise answer is the
# one that evaporates. In a call you should always hear it AND be able to read
# it.
_TYPED_TURN_HINTS: set[str] = set()
_TYPED_TURN_LOCK = Lock()


def mark_typed_turn(key: str) -> None:
    with _TYPED_TURN_LOCK:
        _TYPED_TURN_HINTS.add(key)


def clear_typed_turn(key: str) -> None:
    """Drop a hint set for a turn that never happened (speak() refused/failed)."""
    with _TYPED_TURN_LOCK:
        _TYPED_TURN_HINTS.discard(key)


def take_typed_turn(key: str) -> bool:
    """Consume the flag — reading it clears it, so it applies to ONE turn."""
    with _TYPED_TURN_LOCK:
        if key in _TYPED_TURN_HINTS:
            _TYPED_TURN_HINTS.discard(key)
            return True
        return False


# Which session spoken turns belong to right now.
#
# speech-to-speech owns the HTTP call and cannot set X-Session-Key, so every
# spoken turn used to fall through to DEFAULT_KEY — ONE conversation for all
# voice, in every guild. Joining a call in a second server resumed the first
# server's conversation, which is a privacy boundary, not a papercut.
#
# So the bot names the key out of band on join, the same shape as the typed-turn
# hint above. The difference is lifetime: that one is consumed by a single turn,
# this one persists until the next bind or leave, because it describes WHICH
# CONVERSATION is live rather than something about one utterance.
#
# A single pointer (not a map) is sound because speech-to-speech serves exactly
# one session at a time — "All 1 session slots are in use" — and the bot holds at
# most one call. Two concurrent voice conversations cannot exist to disagree
# about. If s2s ever serves more, this must become a map keyed by whatever
# identifies the socket, and the assert below is where that will surface.
# Every voice conversation's key starts with this. It is not cosmetic: the
# request handler matches on it to know a turn was SPOKEN, which is what gates
# the wake phrase. Keep the bot's `voiceKeyFor()` in step with it.
VOICE_KEY_PREFIX = "voice:"

# ── per-identity persona ───────────────────────────────────────────────────
# Multiple Discord identities can share this ONE shim (and the one
# `speech-to-speech` process every voice call goes through) without
# answering with each other's persona, session store or vault.
#
# Why here, not a second shim: `speech-to-speech` wires its backend at
# process STARTUP (`scripts/s2s-minimax`, trailing `"$@"` from `local.env`)
# and never changes it again — so the single s2s always talks to ONE shim for
# its whole life. A second identity's own shim never sees a spoken turn; only
# consolidating to one shim that decides persona PER TURN fixes the routing,
# not adding more shims for it to ignore.
#
# `ClaudeProcess` already takes `cwd` per spawn (`Popen(cmd, cwd=cwd, ...)`),
# not process-global, so the fix is to stop reading the module-level CWD /
# CLAUDE_SCRIPT / MCP_CONFIG / ALLOWED_TOOLS constants directly and resolve
# them per session key instead — a lookup, not a redesign.
#
# Keyed by IDENTITY name, not guild id: persona belongs to the identity (the
# bot), while the guild is the other half of the key that keeps sessions
# separate — see `identity_for()`. `identities:` in config.yaml maps identity
# name -> overrides; any field left unset falls back to this instance's own
# top-level setting, so a config with no `identities:` at all resolves every
# key to the same defaults it always had — single-identity setups need no
# migration.
#
# Guild-id-keyed entries (the `v0.16.0` shape) still work: a 2-segment key
# (`voice:<guildId>`, no identity segment — the bot never set `IDENTITY`)
# looks itself up in this SAME map by guildId, unchanged from before. The two
# lookups do not collide in practice — identity names and Discord guild
# snowflakes do not share a namespace — so one map serves both shapes.
def _load_identities() -> dict[str, dict]:
    """identityName-or-guildId -> {cwd, claude_script, mcp_config, allowed_tools,
    chat_bridge_url}.

    Read straight off the parsed config file rather than through `setting()`:
    that helper resolves ONE scalar against env/file/default, and an identity
    is a small object, not a scalar. There is deliberately no per-field env
    override here — a second identity's cwd is an operator-authored fact that
    belongs in config.yaml next to the other identities, not a `SHIM_*` var
    that would need one distinct name per guild to even be expressible.
    """
    raw = _CFG.get("identities") or {}
    if not isinstance(raw, dict):
        print(f"  config: identities must be a mapping, got {type(raw).__name__} — ignoring", flush=True)
        return {}
    out: dict[str, dict] = {}
    for guild_id, cfg in raw.items():
        if guild_id == "strict":
            # Reserved control flag (`identities.strict`), not an identity or
            # guild-id entry — see IDENTITIES_STRICT below. Skipped here so it
            # never falls into the "must be a mapping" warning below.
            continue
        if not isinstance(cfg, dict):
            print(f"  config: identities.{guild_id} must be a mapping — ignoring", flush=True)
            continue
        entry: dict[str, str] = {}
        if cfg.get("cwd"):
            entry["cwd"] = _expand(str(cfg["cwd"]))
        if cfg.get("claude_script"):
            entry["claude_script"] = _expand(str(cfg["claude_script"]))
        if cfg.get("mcp_config"):
            entry["mcp_config"] = _expand(str(cfg["mcp_config"]))
        if cfg.get("allowed_tools"):
            # Expanded like every other path field above. An allowed-tools value
            # can carry a `~`-rooted path, and passing the literal `~` through to
            # --allowed-tools fails silently rather than erroring.
            entry["allowed_tools"] = _expand(str(cfg["allowed_tools"]))
        if cfg.get("chat_bridge_url"):
            # NOT path-expanded — this is a URL, not a filesystem path, and the
            # top-level CHAT_BRIDGE_URL constant it overrides is not expanded
            # either (see `setting()` above).
            #
            # Validated at LOAD time, not at post time. An unusable value here
            # fails exactly like the bug this field exists to fix: the answer is
            # produced, the post goes nowhere, and nothing surfaces in Discord.
            # `htp://` is a plausible typo that urlopen only rejects on the
            # first spoken turn, which may be hours later. Warn and drop the
            # override so the identity falls back to the working global rather
            # than posting into a hole.
            raw_url = str(cfg["chat_bridge_url"])
            parsed = urllib.parse.urlparse(raw_url)
            if parsed.scheme in ("http", "https") and parsed.netloc:
                entry["chat_bridge_url"] = raw_url
            else:
                print(
                    f"  config: identities.{guild_id}.chat_bridge_url is not an "
                    f"http(s) URL ({raw_url!r}) — ignoring, falling back to the "
                    f"default bridge target",
                    flush=True,
                )
        out[str(guild_id)] = entry
    return out


IDENTITIES = _load_identities()

# Opt-in, default OFF. The implicit default persona (no `identities:` entry
# matched) is the MOST PRIVILEGED one on this instance — top-level `cwd` is
# the Personal vault and `claude_script` is `cc-personal`, whose --add-dir set
# reaches every repo on the machine (see config.example.yaml). Every other
# guard in this shim fails CLOSED (empty CHAT_BRIDGE_TOKEN refuses all posts,
# a malformed identities entry warns and skips, a 404 from /voice/bind
# degrades to one shared conversation); this is the one fallback that instead
# hands out maximum access to whichever bot's key happened to miss. Strict
# mode turns that specific gap fail-closed too, without touching any other
# fallback in the file.
#
# Only takes effect when `identities:` is ALSO configured — a fresh
# single-identity install has no `identities:` block at all and must keep
# resolving to the default silently, which is the intended behaviour for
# that shape, not a misconfiguration. See `_identity_fallback()`.
IDENTITIES_STRICT = setting("SHIM_IDENTITIES_STRICT", "identities.strict", False)


class IdentityRefused(Exception):
    """A turn's key resolved to the implicit default persona while
    `identities.strict: true` is armed. Carries enough to log and answer with
    a clean refusal rather than spawning a process under the wrong identity.
    """

    def __init__(self, key: str, reason: str):
        self._key = key
        self._reason = reason
        super().__init__(f"identity refused for {key!r}: {reason}")

    @property
    def reason(self) -> str:
        """Read-only accessor for the refusal reason.

        The fields are private per the IOC rule; the handler still needs the
        reason to log it and to put it in the 403 body, and a property keeps
        that a read rather than reaching into the instance.
        """
        return self._reason

    @property
    def key(self) -> str:
        """Read-only accessor for the refused session key."""
        return self._key


# Warned once per (key, reason) rather than every turn, so a busy channel
# whose bot never sets IDENTITY does not flood the log with the same fact
# on every sentence.
_DEFAULT_FALLBACK_WARNED: set[tuple[str, str]] = set()
_DEFAULT_FALLBACK_LOCK = Lock()


def _identity_fallback(key: str, reason: str, enforce: bool) -> dict:
    """A turn matched no `identities:` entry — warn (once) and either serve
    the default persona or, in strict mode, refuse.

    Silent when `identities:` itself is empty: that is a fresh, single-
    identity install behaving exactly as before, not a misconfiguration —
    only warn/refuse once an operator has actually configured `identities:`
    and a turn still lands on the default, which is what indicates a bot
    whose IDENTITY is unset, misspelled, or missing from config.yaml.
    """
    if IDENTITIES:
        with _DEFAULT_FALLBACK_LOCK:
            first_time = (key, reason) not in _DEFAULT_FALLBACK_WARNED
            if first_time:
                _DEFAULT_FALLBACK_WARNED.add((key, reason))
        if first_time:
            print(
                f"  WARNING [{key}] resolved to the DEFAULT persona ({reason}) — "
                f"identities: is configured but this turn matched no entry. The "
                f"default is the MOST PRIVILEGED persona on this instance "
                f"(cwd={CWD}). If this bot should carry its own identity, set "
                f"IDENTITY and add it under identities: in config.yaml.",
                flush=True,
            )
        if enforce and IDENTITIES_STRICT:
            raise IdentityRefused(key, reason)
    return {"cwd": CWD, "claude_script": CLAUDE_SCRIPT,
            "mcp_config": MCP_CONFIG, "allowed_tools": ALLOWED_TOOLS,
            "chat_bridge_url": CHAT_BRIDGE_URL}


def identity_for(key: str, *, enforce: bool = False) -> dict:
    """Resolve {cwd, claude_script, mcp_config, allowed_tools, chat_bridge_url}
    for a turn.

    This is the routing fix itself: everything that used to read the
    module-level CWD / CLAUDE_SCRIPT / MCP_CONFIG / ALLOWED_TOOLS constants
    directly now calls this instead, so persona becomes a function of WHICH
    conversation a turn belongs to rather than a process-wide constant every
    identity shared by accident.

    Identity rides in the KEY for every surface, not just voice — a header
    was tried first and dropped: two bots in the SAME Discord channel produce
    the IDENTICAL `thread:`/`channel:`/`dm:` key, so a header fixes which
    persona a process spawns with but does NOT separate the sessions — one
    identity would resume the conversation another was holding, then spawn
    it under the wrong cwd. Only the key can do both jobs at once, which is
    why voice already worked this way and text now matches it:

    - `voice:<guildId>:<identity>` — unchanged since `v0.16.1`.
      `speech-to-speech` owns the HTTP call for a spoken turn and cannot set
      `X-Session-Key` at all, which is why the bot binds this key out of band
      instead (`bind_voice_key`) — see the module docstring above.
    - `thread:<channelId>:<identity>` / `channel:<channelId>:<identity>` /
      `dm:<userId>:<identity>` — the bot DOES own `X-Session-Key` on every
      text surface, so it embeds identity there uniformly rather than
      needing a second mechanism. Before this, a text key carried no
      identity at all and every text turn from every identity resolved to
      this instance's own default persona.

    The identity segment is always LAST regardless of prefix, so resolution
    is one rule for every surface: split off the prefix, then split the
    remainder on `:`. A 3-segment key resolves by IDENTITY, in whichever
    segment it lands. A 2-segment key falls through to the identity map
    keyed by GUILD id — but only for voice: `thread:111`/`dm:111`/
    `channel:111` name a channel or user, never a guild, so a bare 2-segment
    text key must never accidentally pick up a guildId entry that happens to
    share the string. An unconfigured identity name falls back to this
    instance's own default rather than crashing or guessing.

    Persona and session are different axes and the key format reflects it:
    the guild/channel/user segment keeps sessions apart (two identities
    sharing one channel get two conversations), the optional identity
    segment is what picks persona (one identity across several
    guilds/channels gets one persona). A key with no identity segment means
    the bot never set `IDENTITY` — this instance behaves exactly as
    `v0.16.0`/pre-identity did, resolving voice by guild id and text by
    instance default, for backward compatibility with that config shape.

    `enforce=True` marks this call as serving an actual TURN, not an internal
    lookup (transcript listing, chat-bridge target, etc.) — only at that
    point does a default-persona resolution raise `IdentityRefused` when
    `identities.strict: true` is armed. Internal callers pass the default
    (`enforce=False`) so listing sessions or resolving a bridge URL never
    raises; only the moment of actually answering an unconfigured identity
    does, and only when strict mode is on. See `_identity_fallback()`.
    """
    defaults = {"cwd": CWD, "claude_script": CLAUDE_SCRIPT,
                "mcp_config": MCP_CONFIG, "allowed_tools": ALLOWED_TOOLS,
                "chat_bridge_url": CHAT_BRIDGE_URL}
    prefix, sep, rest = key.partition(":")
    if not sep:
        return _identity_fallback(key, "no identity segment (bare key)", enforce)
    first, sep2, identity = rest.partition(":")
    if sep2:
        # 3-segment key of ANY prefix — identity always lands in the last
        # segment, resolved by IDENTITY, never by guild/channel/user even
        # when that segment's value happens to match a configured one.
        overrides = IDENTITIES.get(identity)
        if not overrides:
            return _identity_fallback(
                key, f"identity {identity!r} not in identities:", enforce)
    elif f"{prefix}:" == VOICE_KEY_PREFIX:
        # 2-segment `voice:<guildId>`, no `IDENTITY` set on the bot — the
        # v0.16.0 lookup, unchanged: resolve by guild id. A MATCH here is
        # "configured", not "missing" — strict mode must not refuse a bot
        # that never adopted the identity segment but whose guild id is
        # explicitly listed.
        overrides = IDENTITIES.get(first)
        if not overrides:
            return _identity_fallback(
                key, "no identity segment and no guild-id match", enforce)
    else:
        # 2-segment text key (`thread:<id>`/`dm:<id>`/`channel:<id>`) — never
        # a guild, so never consults the guild-keyed map.
        return _identity_fallback(key, "no identity segment", enforce)
    return {**defaults, **overrides}


def _identity_label(key: str) -> str:
    """Which identity NAME (or `"default"`) a key resolves to, for logging.

    Mirrors `identity_for()`'s own resolution rules but returns the name
    rather than the override dict — so the `spawned claude` log line can say
    which persona served a turn without the reader inferring it from `cwd=`.
    """
    prefix, sep, rest = key.partition(":")
    if not sep:
        return "default"
    first, sep2, identity = rest.partition(":")
    if sep2:
        return identity if IDENTITIES.get(identity) else "default"
    if f"{prefix}:" == VOICE_KEY_PREFIX and IDENTITIES.get(first):
        return first
    return "default"


_VOICE_KEY = DEFAULT_KEY
_VOICE_KEY_LOCK = Lock()
# Counts /voice/bind calls so the handler can tell "first bind ever" (nothing
# to yield — no process has held the slot yet) apart from "bound back to the
# default identity" (which DOES have a previous holder). `_VOICE_KEY` alone
# cannot make that distinction: it initializes to DEFAULT_KEY at import time,
# identical to what a legitimate later bind-to-default would see.
_VOICE_BIND_COUNT = 0
_VOICE_BIND_COUNT_LOCK = Lock()


def is_voice_turn(mode: str, key: str, text: str = "") -> bool:
    """Was this turn SPOKEN? Decides whether the wake phrase is enforced.

    Extracted from the request handler after living there as an inline
    expression, which is how it came to be keyed on the SHAPE of a session key
    (`":" not in key`, meaning "the key is `default`"). Keying voice per guild
    gave every spoken turn a colon, so all of them classified as text, the wake
    gate stopped running, and the assistant answered every sentence of a live
    meeting. Nothing errored and every health check stayed green.

    Order matters:

    - an explicit `X-Output-Mode` header wins in both directions — the bot sets
      it, and it is the only signal that distinguishes a message TYPED into a
      call's text chat (same session key as the speech) from one spoken aloud
    - otherwise a key in the voice keyspace is spoken, since speech-to-speech
      owns the HTTP call and can send no headers
    - `":" not in key` remains for the legacy `default` key and any client that
      sends neither
    - the prompt sniff is a last resort: s2s attaches its voice system prompt
      only when `wants_audio` is set, which it never is with TTS as a separate
      stage
    """
    mode = (mode or "").lower()
    if mode == "voice":
        return True
    if mode == "text":
        return False
    low = (text or "").lower()
    return (key.startswith(VOICE_KEY_PREFIX)
            or ":" not in key
            or "spoken conversation" in low
            or "voice rules" in low)


def bind_voice_key(key: str) -> str:
    """Point spoken turns at `key` until the next bind. Returns the previous."""
    global _VOICE_KEY
    with _VOICE_KEY_LOCK:
        previous, _VOICE_KEY = _VOICE_KEY, key or DEFAULT_KEY
    return previous


# Whether the operator is the only human in the call. Sticky, like the voice
# key above and unlike the one-shot typed hint: it describes a standing state of
# the room, not something about one utterance.
#
# DEFAULTS TO FALSE, and that direction is load-bearing. An endpoint that is
# never told stays exactly as it was — gate armed — so a shim that predates this
# route, a bot that fails to post, and a backend that 404s the path all degrade
# to the safe behaviour rather than to an assistant that answers everything.
# Per-key solo state, keyed by the same shape `bind_voice_key` uses
# (`voice:<guildId>` or `voice:<guildId>:<identity>`). The global that lived
# here until v0.20.0 leaked across calls — a private session ending with
# solo=True was still True when the next call (often a team channel) joined,
# and the wake gate answered whatever the next call's first turn said. With
# one entry per key, state cannot bleed across calls: an unknown key defaults
# to False (gate armed), which is the load-bearing direction.
_SOLO_BY_KEY: dict[str, bool] = {}
_SOLO_LOCK = Lock()


def set_solo(key: str, solo: bool) -> bool:
    """Set the solo flag for a voice key. Returns the previous value."""
    with _SOLO_LOCK:
        previous = _SOLO_BY_KEY.get(key, False)
        _SOLO_BY_KEY[key] = bool(solo)
    return previous


def is_solo(key: str) -> bool:
    """Look up solo state by voice key. Unknown keys return False (gate armed)."""
    with _SOLO_LOCK:
        return _SOLO_BY_KEY.get(key, False)


# Per-key runtime override of ALWAYS_WAKE, set by an admin mid-call over
# /v1/voice/wake. Tri-state on purpose: True forces the phrase, False relaxes to
# head-count behaviour, and ABSENT means "no override" — defer to the
# ALWAYS_WAKE env default. A plain bool cannot express that third case, which is
# what `/wake default` restores; without it the configured default is unreachable
# for the life of the process once the command is used at all.
#
# In-memory and per-key, like _SOLO_BY_KEY above and for the same two reasons: a
# process-wide value leaks across calls (the bug v0.20.0 fixed), and a persisted
# one would carry a "wake OFF" across a restart invisibly — the shape of the
# incident where the assistant answered a 5-person meeting for 2.5h. A restart
# falls back to the configured default, which is the safe direction.
_WAKE_OVERRIDE_BY_KEY: dict[str, bool] = {}
_WAKE_OVERRIDE_LOCK = Lock()


def set_wake_override(key: str, value: bool | None) -> bool | None:
    """Set (or clear, with None) the wake override for a key. Returns previous."""
    with _WAKE_OVERRIDE_LOCK:
        previous = _WAKE_OVERRIDE_BY_KEY.get(key)
        if value is None:
            _WAKE_OVERRIDE_BY_KEY.pop(key, None)
        else:
            _WAKE_OVERRIDE_BY_KEY[key] = bool(value)
    return previous


def wake_override(key: str) -> bool | None:
    """Look up the override for a key. None means no override — use the default."""
    with _WAKE_OVERRIDE_LOCK:
        return _WAKE_OVERRIDE_BY_KEY.get(key)


def effective_always_wake(key: str) -> bool:
    """ALWAYS_WAKE for this key, with any runtime override applied.

    The override replaces ONLY the always-wake term. Head-count logic is
    untouched: relaxing it cannot make an unaddressed turn answerable in a room
    with other people, because `is_solo(key)` still has to be True.
    """
    override = wake_override(key)
    return ALWAYS_WAKE if override is None else override

# ── voice-only switch ──────────────────────────────────────────────────────
# "don't write in the chat" silences chat posting for the rest of this
# conversation; the opposite instruction turns it back on. Per-key, like solo —
# the setting describes this conversation, never the whole shim, so other
# channels and identities are unaffected. Sticky (not one-shot): it stays set
# until the user says otherwise or the conversation is replaced.
_CHAT_OFF_BY_KEY: dict[str, bool] = {}
_CHAT_OFF_LOCK = Lock()


def set_chat_off(key: str, off: bool | None) -> bool:
    """Set the voice-only flag for a conversation key. None clears it (falls
    back to the configured default). Returns the previous."""
    with _CHAT_OFF_LOCK:
        previous = _CHAT_OFF_BY_KEY.get(key, False)
        if off is None:
            _CHAT_OFF_BY_KEY.pop(key, None)
        else:
            _CHAT_OFF_BY_KEY[key] = bool(off)
    return previous


def is_chat_off(key: str) -> bool:
    """Look up voice-only state by key. Unknown keys return False (posting on)."""
    with _CHAT_OFF_LOCK:
        return _CHAT_OFF_BY_KEY.get(key, False)


# ── text-only switch ───────────────────────────────────────────────────────
# The mirror of the voice-only switch above: `speech_off` silences SPOKEN
# output for the rest of this conversation while chat posting stays ON — the
# assistant hears the user, answers in the channel, and never speaks. Per-key
# and sticky like its siblings, and in-memory by design: a restart falls back
# to the default (speech on), which is the ABSENCE of an override rather than a
# stored False, so an unknown key answers False without needing an env knob.
#
# ⚠️ The pair is written TOGETHER, by `set_mode` — never by two independent
# setters. `(chat_off, speech_off) = (True, True)` is not a mode: speech off
# AND chat off means the user gets nothing at all, and nothing in Discord would
# show it. One writer makes that state unreachable; two would make it a
# two-flag race nobody would notice.
MODES = ("voice-only", "voice-text", "text-only")
_SPEECH_OFF_BY_KEY: dict[str, bool] = {}
_SPEECH_OFF_LOCK = Lock()


def set_speech_off(key: str, off: bool) -> bool:
    """Set the text-only flag for a conversation key. Returns the previous."""
    with _SPEECH_OFF_LOCK:
        previous = _SPEECH_OFF_BY_KEY.get(key, False)
        _SPEECH_OFF_BY_KEY[key] = bool(off)
    return previous


def is_speech_off(key: str) -> bool:
    """Look up text-only state by key. Unknown keys return False (speech on)."""
    with _SPEECH_OFF_LOCK:
        return _SPEECH_OFF_BY_KEY.get(key, False)


def set_mode(key: str, mode: str) -> tuple[bool, bool]:
    """Set BOTH per-conversation flags from one mode name. Returns the previous pair.

    The only writer of the pair — see the warning above. `voice-only` speaks and
    never posts; `voice-text` (the default) does both; `text-only` posts and
    never speaks.
    """
    chat_off = mode == "voice-only"
    speech_off = mode == "text-only"
    with _CHAT_OFF_LOCK:
        prev_chat = _CHAT_OFF_BY_KEY.get(key, False)
        _CHAT_OFF_BY_KEY[key] = chat_off
    with _SPEECH_OFF_LOCK:
        prev_speech = _SPEECH_OFF_BY_KEY.get(key, False)
        _SPEECH_OFF_BY_KEY[key] = speech_off
    return prev_chat, prev_speech


def clear_mode(key: str) -> tuple[bool, bool]:
    """Clear BOTH per-conversation mode flags, restoring voice-text (the default).

    Same single-writer contract as `set_mode`: the pair is popped together so
    `(chat_off, speech_off) = (True, True)` stays unreachable. Unknown keys are
    a no-op (they already follow the default).
    """
    with _CHAT_OFF_LOCK:
        prev_chat = _CHAT_OFF_BY_KEY.pop(key, False)
    with _SPEECH_OFF_LOCK:
        prev_speech = _SPEECH_OFF_BY_KEY.pop(key, False)
    return prev_chat, prev_speech


# ── barge-in switch ────────────────────────────────────────────────────────
# "barge-in cancellation" is the behaviour where the listener speaking
# mid-turn ends the in-flight answer (`listener gone — interrupting turn` →
# `0 chars`). The flag below turns it OFF for a conversation: with it set,
# speaking over the assistant no longer discards the reply already being
# produced — the turn runs to completion and the full answer still reaches the
# chat bridge/transcript. Per-key like the voice-only switch: the setting
# describes this conversation, never the whole shim. Sticky (not one-shot),
# and the DEFAULT is unset (cancellation ON) — today's behaviour stays the
# safe baseline until a smarter heuristic has numbers to be judged against.
_BARGE_IN_OFF_BY_KEY: dict[str, bool] = {}
_BARGE_IN_OFF_LOCK = Lock()


def set_barge_in_off(key: str, off: bool | None) -> bool:
    """Set the barge-in-cancellation-off flag for a key. None clears it (falls
    back to the configured default, cancellation ON). Returns the previous."""
    with _BARGE_IN_OFF_LOCK:
        previous = _BARGE_IN_OFF_BY_KEY.get(key, False)
        if off is None:
            _BARGE_IN_OFF_BY_KEY.pop(key, None)
        else:
            _BARGE_IN_OFF_BY_KEY[key] = bool(off)
    return previous


def is_barge_in_off(key: str) -> bool:
    """Look up barge-in-cancellation-off state by key. Unknown keys return
    False — cancellation stays ON, exactly as before the switch existed."""
    with _BARGE_IN_OFF_LOCK:
        return _BARGE_IN_OFF_BY_KEY.get(key, False)


# ── transcription switch ───────────────────────────────────────────────────
# `/transcribe off` stops the BOT writing this conversation down for the rest
# of the call; `/transcribe on` resumes it. Per-key like the other switches:
# the setting describes THIS conversation, never the whole shim, so other
# channels and identities are unaffected. Sticky (not one-shot), and the
# DEFAULT is unset (transcription ON) — today's behaviour stays the baseline.
# Recording other people is a consent matter, so turning it OFF must always be
# possible, but nothing changes for anyone who never toggles it.
_TRANSCRIBE_OFF_BY_KEY: dict[str, bool] = {}
_TRANSCRIBE_OFF_LOCK = Lock()


def set_transcribe_off(key: str, off: bool | None) -> bool:
    """Set the transcription-off flag for a conversation key. None clears it
    (falls back to the configured default, transcription ON). Returns previous."""
    with _TRANSCRIBE_OFF_LOCK:
        previous = _TRANSCRIBE_OFF_BY_KEY.get(key, False)
        if off is None:
            _TRANSCRIBE_OFF_BY_KEY.pop(key, None)
        else:
            _TRANSCRIBE_OFF_BY_KEY[key] = bool(off)
    return previous


def is_transcribe_off(key: str) -> bool:
    """Look up transcription-off state by key. Unknown keys return False —
    transcription stays ON, exactly as before the switch existed."""
    with _TRANSCRIBE_OFF_LOCK:
        return _TRANSCRIBE_OFF_BY_KEY.get(key, False)


def voice_key() -> str:
    with _VOICE_KEY_LOCK:
        return _VOICE_KEY


ASK_CLAUDE_TOOL = {
    "type": "function",
    "function": {
        "name": "ask_claude",
        "description": (
            "Look something up. Reaches the user's notes, tasks, files, "
            "repositories and systems, none of which you can see. Use it for "
            "ANYTHING factual or specific to the user's world. It is the normal "
            "way to answer, not an escalation: call it freely and without asking."),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string",
                             "description": "The user's question, in full."},
            },
            "required": ["question"],
        },
    },
}

# Backstop for the case the tool contract cannot cover: the front model deciding
# it knows the answer to something factual. A wrong "I'll check" costs a second;
# a wrong "the answer is X" invents something about the user's world and says it
# in the assistant's voice. So anything shaped like a question about the user's
# things goes to Claude no matter what the front model chose.
_FACTUAL = re.compile(r"""(
      \b(what|which|when|where|who|why|how\s+(many|much|long|often))\b
    | \b(did|do|does|have|has|is|are|was|were)\s+(i|we|you|it|there|my|the)\b
    # Asking to enumerate something is asking about the user's world by
    # definition — and it arrives as "can you list…", which matches no
    # interrogative and no auxiliary above.
    | \b(list|show|tell\s+me\s+about|summari[sz]e|remind\s+me)\b
    # PLURALS MATTER: \btask\b cannot match "tasks", because \b needs a
    # non-word character after "task" and "s" is not one. That single missing
    # letter let "can you list all active tasks?" reach the front tier, which
    # answered with an invented task name, an invented count and an invented
    # due date — spoken as fact. Observed 2026-08-04 17:24.
    | \b(status(es)?|tasks?|notes?|files?|vaults?|repos?|repositor(y|ies)
        |deploys?|logs?|transcripts?|objectives?|goals?|commits?
        |branch(es)?|tests?|errors?|meetings?|calendars?|plans?
        |sessions?|projects?|tickets?|issues?|prs?|reviews?
        |skills?|runbooks?|slash\s+commands?)\b
    # INFRASTRUCTURE, added 2026-08-14 after a live fabrication. The list above
    # covers the user's WORK — tasks, notes, repos — because that is what the
    # assistant was originally asked about. It does not cover the user's own
    # SETUP, and a growing share of spoken questions are exactly that.
    #
    # "Can you now give me a complete answer? Can we run the benchmark against
    # the router?" matches nothing above: no interrogative in the first list, no
    # `my`/`our`, and neither "benchmark" nor "router" was a known noun. It went
    # to the front tier, which answered "No — not yet because the necessary
    # router components are missing" — a confident invention about the user's own
    # router, spoken aloud. Same shape as the 2026-08-04 incident, different
    # vocabulary.
    #
    # The asymmetry rule decides the breadth here: a needless consult costs a
    # second, a missed one puts an invented fact in the assistant's mouth. These
    # can only push turns TOWARD Claude — `looks_factual` returns early for
    # anything the chitchat whitelist already matched, so small talk is unaffected.
    | \b(routers?|benchmarks?|models?|endpoints?|shims?|servers?|clusters?
        |pods?|services?|apis?|configs?|configuration(s)?|settings?
        |subscriptions?|accounts?|keys?|tokens?|costs?|latency|throughput
        |containers?|images?|builds?|releases?|versions?)\b
    # TRAVEL, added 2026-08-29 after the bus-ride transcript. "I want to take
    # the bus from Taunustein-Neuhof to Wiesbaden" is a plain statement — no
    # interrogative, no possessive, no noun above — so it fell to the front
    # tier, whose refusal ("I do not have the capability to ask Lord Gurk") was
    # not recognized and the request never reached Claude. Travel is the user's
    # real world; the front model can't know a timetable.
    | \b(bus(es)?|trains?|trams?|routes?|timetables?|schedules?|departures?
        |connections?|stations?|platforms?|rmv|fahrplan|anreise)\b
    | \b(my|our)\b
)""", re.I | re.X)


def looks_factual(text: str) -> bool:
    """Would answering this require knowing something about the user's world?

    Deliberately over-broad — "my", a bare "did we", any interrogative — because
    the cost is asymmetric: a needless consult loses a second, a missed one puts
    an invented fact in the assistant's mouth. The conversational whitelist is
    the exemption that keeps that breadth from swallowing "how are you", which
    matches on "are you" alone.
    """
    if is_chitchat(text):
        return False
    return bool(_FACTUAL.search(text))


# A refusal CONTRACT, not a tool. Measured 2026-08-04 across 20 factual trials
# including deliberately subtle phrasings ("so what's left for today", "did that
# finish", "anything I should know about"): zero fabrications. The same model
# given an ask_claude TOOL instead answered "can you list all active tasks?" with
# an invented task, count and due date — it treats a tool as an action needing
# permission, but a refusal token as simply the honest reply. Same model, same
# questions; the channel is what changed.
FRONT_REFUSAL = '{"cannot_answer": true}'

FRONT_SYSTEM = (
    "You are the voice of an assistant in a spoken conversation. Everything you "
    "say is read aloud: ONE short spoken sentence, no markdown, no lists, no "
    "emoji.\n"
    "Answer ONLY from the conversation itself. You have NO access to the user's "
    "notes, tasks, files, code, systems, calendar or history, and no memory of "
    "their work.\n"
    f"When you cannot answer from the conversation, reply with EXACTLY this "
    f"single JSON object and NOTHING else — no words, no explanation, no "
    f"apology, no alternative sentence:\n{FRONT_REFUSAL}\n"
    "A separate system behind you answers every request you refuse, instantly, "
    "so your refusal is never shown to the user — it is an internal signal, not "
    "a reply. Saying 'I can't', 'I don't have access' or 'I cannot do that' in "
    "words is a BUG: it is spoken aloud and the user hears a denial instead of "
    "an answer. Refusing costs a second; guessing puts an invented fact in the "
    "assistant's mouth. When unsure, refuse.\n"
    "Examples — User: can you check my open tasks? Assistant: "
    f"{FRONT_REFUSAL}\n"
    "User: find the next bus from Neuhof to Wiesbaden Assistant: "
    f"{FRONT_REFUSAL}\n"
    "User: write a skill for that Assistant: "
    f"{FRONT_REFUSAL}\n"
    "User: how are you? Assistant: I'm doing great, thanks.\n"
    "Greetings, thanks, 'can you hear me' and small talk you CAN answer.\n"
    "You are ONE assistant throughout. Never name or speculate about which model "
    "or system is answering, and never describe the parts you are made of."
)

# Full-match, not substring: "hello" is small talk, "hello, what is my most
# important task" is not, and a substring test would route the second one here.
_CHITCHAT = re.compile(r"""^(
      (hi|hello|hey|yo)(\s+there)?
    | good\s+(morning|afternoon|evening)
    | (thanks|thank\s+you|cheers)(\s+(a\s+lot|very\s+much))?
    | how\s+are\s+you(\s+doing)?
    # Informal greetings that READ as questions — "yo what is up" trips the
    # factual backstop on "what" and would wake Claude to say hello.
    | (yo\s+)?(what'?s|what\s+is)\s+up
    | how'?s?\s+(it\s+going|things)
    | sup
    | (can|do)\s+you\s+hear\s+me(\s+now)?
    | are\s+you\s+(there|awake|ok|okay|still\s+there)
    | (say\s+that\s+again|repeat\s+that|come\s+again|pardon)
    | (never\s*mind|forget\s+it)
    | (speak\s+up|louder|slower|slow\s+down)
    | (good\s*night|bye|goodbye|see\s+you)
)$""", re.I | re.X)

# Matches both the well-formed block and the unclosed "<think …" MiniMax
# actually emitted, which a tag-shaped regex alone would miss.
_THINK = re.compile(r"<think\b.*?(?:</think>?|$)", re.S | re.I)

# Spoken text that asks permission or describes looking something up instead of
# having done it. The prompt forbids these and the model produces them anyway —
# observed "You want me to list the tools?" alongside a correct tool call. Said
# aloud it invites an answer, so the user replies "yes" into a turn that is
# already running. Discarded in favour of a neutral filler.
# The assistant is one thing to the user. Anything naming the machinery breaks
# that and is usually wrong as well — observed "I have one tool available called
# ask_claude", and elsewhere it introduced itself as Claude while running on
# MiniMax. Prompting against this failed three times; the reply is filtered
# instead, and a filtered reply becomes a consult.
_LEAK = re.compile(r"""(
      \bask_claude\b | \bminimax\b | \bclaude\b | \banthropic\b
    | \bsystem\s+prompt\b | \blanguage\s+model\b | \bmy\s+tools?\b
    | \btools?\s+available\b | \bi\s+am\s+an?\s+(ai|assistant|model)\b
)""", re.I | re.X)

_HEDGE = re.compile(r"""(
      \b(i'?d|i\s+would|i'?ll)\s+(have\s+to|need\s+to)\b
    | \bwant\s+me\s+to\b | \bshall\s+i\b | \bshould\s+i\b
    | \bdo\s+you\s+want\s+me\b | \byou\s+want\s+me\s+to\b
    | \blet\s+me\s+know\s+if\s+you\b
    # Refusal in prose rather than the contracted JSON. The model gets the
    # judgement right and the format wrong — observed "I do not have any context
    # about what finished", which an access-only pattern missed and the shim
    # then spoke, leaving the user with an apology instead of an answer. Any
    # admission of missing information means the same thing: send it to Claude.
    | \b(do\s+not|don'?t)\s+have\s+(any\s+)?(access|context|information|visibility|details|record)
    | \bno\s+(access|context|information|visibility|record)\s+(to|of|about)\b
    | \bi\s+(do\s+not|don'?t)\s+know\s+(what|which|when|where|who|about)\b
    | \bi\s+(can'?t|cannot|can\s+not)\s+(see|tell|access|find|check|look|provide|write|create|update|ask|give|fetch|retrieve|search|pull|get|list)\b
    # CAPABILITY refusals, added 2026-08-29 after the bus-ride transcript.
    # "I do not have the capability to ask Lord Gurk" and "I cannot write or
    # update a runbook or create a skill or slash command" matched none of the
    # patterns above: `can'?t` does not cover "cannot", "capability" was an
    # unknown noun, and "write/create/update" were never on the verb list. Each
    # was spoken verbatim and the request never reached Claude. Any admission
    # of incapability is the same signal as the JSON — defer. Same asymmetry:
    # these can only push turns TOWARD Claude.
    | \bi\s+(do\s+not|don'?t|can'?t|cannot)\s+have\s+the\s+(capability|ability|capacity)\b
    | \bi\s+(am\s+not|was\s+not)\s+(able|equipped|capable)\b
    | \b(not|isn'?t)\s+(sure|clear)\s+what\s+you'?re?\s+(referring|talking)\b
)""", re.I | re.X)

_front_history: dict[str, deque] = defaultdict(lambda: deque(maxlen=FRONT_HISTORY))
_front_lock = Lock()


def is_chitchat(text: str) -> bool:
    """Whole utterance is conversational filler with no factual content.

    Whole-utterance, not substring: "hello" is small talk, "hello, what is my
    most important task" is not, and a substring test would exempt the second
    from the factual backstop.
    """
    norm = re.sub(r"[.!?,]+$", "", text.strip().lower())
    norm = re.sub(r"\s+", " ", norm)
    return bool(_CHITCHAT.fullmatch(norm))


def front_route(key: str, prompt: str) -> tuple[str, bool]:
    """Ask the front model to answer or defer. Returns (spoken_text, want_claude).

    The PROXY owns the tool loop, not the model: when ask_claude is called we run
    it here and hand Claude's words to the caller verbatim. Feeding them back to
    the front model for a final answer — the ordinary agent loop — would let it
    reword facts about the user's vault, which is the one thing it must never do.

    Every failure path returns ("", True) so the turn continues to Claude. A front
    tier that swallows a question when the API is slow is worse than none.
    """
    with _front_lock:
        history = list(_front_history[key])
    body = json.dumps({
        "model": FRONT_MODEL,
        "messages": [{"role": "system", "content": FRONT_SYSTEM}] + history +
                    [{"role": "user", "content": prompt}],
        # No tools deliberately — see FRONT_REFUSAL. The tool form was measured
        # worse at the one job that matters, and two refusal mechanisms would be
        # two things to reason about when one of them misbehaves.
        "max_tokens": 120,
        "temperature": 0.7,
        # MiniMax emits reasoning inside `content`, not `reasoning_content`, so
        # without this the whole think-aloud is spoken. Only M3 honours the flag;
        # see patches/speech-to-speech-minimax-thinking.patch for the same fix in
        # the other client. Harmlessly ignored by non-MiniMax endpoints.
        "thinking": {"type": "disabled"},
        # The same job for OpenAI-shaped endpoints, and NOT redundant with the
        # key above — each is honoured by a disjoint set of providers.
        #
        # A local reasoning model reached through Ollama's /v1 endpoint ignores
        # `thinking` entirely and spends the whole max_tokens budget thinking,
        # returning EMPTY content with finish_reason "length". Measured
        # 2026-08-14 on gemma4:e2b-mlx: 2 of 6 chitchat prompts came back empty;
        # with this flag, 0 of 10. The failure is silent and lands in the worst
        # place — front_route returns ("", False) for a non-factual prompt, so
        # want_claude is False and the turn ends having said NOTHING, rather
        # than falling through to Claude. Same shape as the other "0 chars"
        # outages: nothing errors, /readiness stays 200.
        #
        # Ollama's own `"think": false` does nothing on the /v1 endpoint, and a
        # Modelfile `PARAMETER think` is rejected as unknown (0.32.7) — the
        # request body is the only lever.
        "reasoning_effort": "none",
    }).encode()
    req = urllib.request.Request(
        f"{FRONT_BASE_URL}/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {FRONT_API_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=FRONT_TIMEOUT) as resp:
            data = json.loads(resp.read())
        msg = data["choices"][0]["message"]
        text = (msg.get("content") or "").strip()
        # Tool calls are no longer requested, but a model may still emit one;
        # treat it as the deferral it is rather than dropping the turn.
        called = bool(msg.get("tool_calls"))
    except Exception as e:
        print(f"  [{key}] front tier unavailable ({e}) — deferring to Claude", flush=True)
        return "", True
    # Belt and braces: the disable flag is honoured only by some models, and a
    # leaked think-block is not cosmetic — it gets read aloud.
    text = _THINK.sub("", text).strip()

    # The contracted refusal. Matched loosely — the model sometimes wraps it in
    # a code fence or adds a trailing word, and any of those still mean "I
    # cannot answer this".
    if "cannot_answer" in text:
        return "", True

    if called:
        # The tool call is right; the words alongside it may still ask permission
        # for work already under way. Drop those and let the caller supply a
        # neutral filler.
        if _LEAK.search(text) or _HEDGE.search(text):
            print(f"  [{key}] discarding hedged filler: {text[:50]!r}", flush=True)
            text = ""
        return text, True

    # No tool call. A hedge here is worse: it ends the turn having neither
    # answered nor looked anything up, so the user must ask twice. A leak is
    # worse still — it is answering a question about the user's setup from
    # nothing. Both become consults.
    if _HEDGE.search(text) or _LEAK.search(text):
        print(f"  [{key}] front hedged or leaked — consulting: {text[:44]!r}", flush=True)
        return "", True
    if looks_factual(prompt):
        # It chose to answer something it cannot know. Keep the pause-filler if
        # it produced one, discard any claim, and consult anyway.
        print(f"  [{key}] front answered a factual question — forcing consult", flush=True)
        return (text if _HOLDISH.match(text) else ""), True
    return text, False


def remember(key: str, user: str, assistant: str) -> None:
    """Keep the front model's view of the conversation current.

    Claude's answers go in here too. Without them 'say that again' reaches a
    model that never heard the thing it is being asked to repeat.
    """
    if not FRONT_API_KEY or not assistant:
        return
    with _front_lock:
        h = _front_history[key]
        h.append({"role": "user", "content": user[:500]})
        h.append({"role": "assistant", "content": assistant[:500]})

# Per-key locks: Claude Code serializes turns *within* a session, but different
# sessions run concurrently. A single global lock would silently serialize every
# thread, which is the thing keyed sessions exist to avoid.
_locks: dict[str, Lock] = defaultdict(Lock)
_sessions_lock = Lock()

# Sequence per key, so a request can tell it has been superseded.
#
# speech-to-speech emits PROGRESSIVE transcription finals: one sentence arrives
# as "The plot." / "The plot uh dash p allows uh" / "…allows uh streaming of" /
# the full text. Each becomes a request, each queues on the key's lock, and the
# result is four Claude invocations for one sentence and a multi-second stall.
# s2s cancels its own stale HTTP requests, but that does not reach us — so a
# request that finds a newer one waiting simply drops itself before doing work.
_seq: dict[str, int] = defaultdict(int)
_seq_lock = Lock()


def next_seq(key: str) -> int:
    with _seq_lock:
        _seq[key] += 1
        return _seq[key]


def superseded(key: str, mine: int) -> bool:
    with _seq_lock:
        return _seq[key] > mine


# ── sessions ───────────────────────────────────────────────────────────────
def _load() -> dict:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text())
        except Exception as e:
            print(f"  sessions file unreadable, starting fresh: {e}", flush=True)
    return {}


def _save(data: dict) -> None:
    SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_FILE.write_text(json.dumps(data, indent=2))


def get_session(key: str) -> tuple[str, bool]:
    """Return (session_id, started) for a key, creating one if needed.

    `started` picks between `--resume` and `--session-id`, and the two are not
    interchangeable: re-issuing `--session-id` for an id whose transcript
    already exists makes claude exit immediately with "Session ID … is already
    in use". `mark_started` only runs on a turn that SUCCEEDS, so a first turn
    that timed out leaves a transcript on disk with `started: False` recorded —
    and every retry after that re-issues `--session-id` and dies. Observed
    2026-09-18: one bro thread wedged permanently after a 300s timeout, and
    never recovered, because nothing ever wrote `started: True`.

    The transcript is therefore the authority, not the flag: if the file is
    there, the session was started, whatever the record says. Correcting it here
    (rather than only at spawn) also repairs keys already wedged by earlier runs.
    """
    # Resolved before the lock: transcript_dir() goes through identity_for(),
    # and holding the session lock across an unrelated lookup invites a
    # lock-order bug for no gain.
    tdir = transcript_dir(key)
    with _sessions_lock:
        data = _load()
        entry = data.get(key)
        if entry:
            sid = entry["id"]
            started = entry.get("started", False)
            if not started and (tdir / f"{sid}.jsonl").exists():
                started = True
                entry["started"] = True
                _save(data)
                print(f"  [{key}] session {sid[:8]} has a transcript but was never "
                      f"marked started — correcting it, so the next spawn resumes "
                      f"instead of colliding", flush=True)
            return sid, started
        sid = str(uuid.uuid4())
        data[key] = {"id": sid, "started": False, "created": time.time(), "turns": 0}
        _save(data)
        return sid, False


def mark_started(key: str) -> None:
    with _sessions_lock:
        data = _load()
        if key in data:
            data[key]["started"] = True
            data[key]["turns"] = data[key].get("turns", 0) + 1
            data[key]["last"] = time.time()
            _save(data)


def transcript_dir(key: str = "") -> Path:
    """Where Claude Code keeps this working directory's session transcripts.

    The slug is the absolute path with every separator replaced by a dash — the
    same scheme `claude --resume` uses to find a session, which is why binding to
    an id from a DIFFERENT cwd would resolve to nothing.

    `key` resolves the cwd through `identity_for()`, same as a live turn — a
    second identity's transcripts live under ITS cwd, not this instance's
    default one. Empty `key` (the default) keeps every existing caller working
    unchanged against the instance's own default cwd.
    """
    cwd = identity_for(key)["cwd"] if key else CWD
    return Path.home() / ".claude/projects" / str(Path(cwd).resolve()).replace("/", "-")


def available_sessions(key: str = "", limit: int = 200,
                       max_age_minutes: int = 2 * 24 * 60) -> list[dict]:
    """Resumable transcripts for this cwd, newest first, labelled by session
    name when set, else by first prompt.

    A bare uuid is unusable as a choice — you cannot tell the 90-turn voice
    conversation from a one-turn probe. A session name (a `custom-title`
    record, written by /rename) beats the first user message whenever the
    operator took the trouble to set one.

    The age window is the real filter — anything older than `max_age_minutes`
    (default two days) has gone cold and clutters a switch list; the limit is
    only a safety valve now that the client drops sessions past its char
    budget rather than hard-capping the count.
    """
    out = []
    cutoff = time.time() - max_age_minutes * 60
    for f in sorted(transcript_dir(key).glob("*.jsonl"),
                    key=lambda p: p.stat().st_mtime, reverse=True):
        if f.stat().st_mtime < cutoff:
            break
        if len(out) >= limit:
            break
        name, label, turns = "", "", 0
        try:
            with f.open() as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if d.get("type") == "custom-title" and d.get("customTitle"):
                        name = name or str(d["customTitle"])
                    if d.get("type") != "user":
                        continue
                    c = d.get("message", {}).get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    if isinstance(c, str) and c.strip():
                        turns += 1
                        label = label or " ".join(c.split())[:60]
        except OSError:
            continue
        out.append({"id": f.stem, "label": name or label, "turns": turns,
                    "age_minutes": round((time.time() - f.stat().st_mtime) / 60, 1)})
    return out


# How often the peer watcher re-reads the transcript. The check is a stat plus a
# seek to EOF in the common case, so it is cheap enough to run often; the window
# it leaves is the gap between a peer turn landing on disk and us noticing.
PEER_WATCH_INTERVAL = 0.2


def _transcript_size(path: Path) -> int:
    """Current byte length of a transcript, or 0 if it is not there yet.

    Used to anchor a turn's scan at the point the turn began, so that only
    entries written DURING the turn can be judged. See the call site for why
    starting at 0 is a live outage rather than a conservative default.
    """
    try:
        return path.stat().st_size
    except OSError:
        return 0


def _transcript_has_non_voice_turn(path: Path, start_offset: int) -> tuple[bool, int]:
    """Scan transcript bytes past `start_offset` for a turn that is not the user's.

    Returns `(found, new_offset)`.

    WHY THIS EXISTS. Claude Code injects a cross-session message into a running
    session as its own turn. The shim drives exactly one long-lived `claude`
    process per session key and reads ONE stream from it, so the injected turn's
    `text_delta` and `result` events land interleaved with the spoken turn's —
    and the shim speaks them as the answer to whatever the human just said.
    Observed 2026-09-13 14:27Z: a peer's nuke-status reply was spoken into a live
    call in place of the user's open-tasks question, which then arrived late.

    The origin marker is on the USER entry in the transcript and nowhere on the
    stream: `origin: {kind: "peer", from, name, fromMode}` for a cross-session
    message, `{kind: "task-notification"}` for an internal notice, and ABSENT for
    a turn the user actually spoke. `--replay-user-messages` cannot help — it
    echoes only what the shim itself writes to stdin, and an injected peer turn
    never passes through stdin.

    Reads only COMPLETE lines, and reports the offset it reached so the caller
    never re-parses a line it has already judged. A trailing partial line (the
    writer is mid-append) is left for the next call.

    BYTE offsets, and the file is opened in BINARY mode to match. The transcript
    holds raw UTF-8 — measured 1942 literal em-dashes in one 1.5 MB session —
    so a byte offset and a character offset diverge, and `seek()` on a text-mode
    handle counts CHARACTERS. Seeking a byte offset there lands mid-line, the
    line fails to parse, and the peer entry is silently missed: the gate never
    arms and the very reply this function exists to catch gets spoken. Reproduced
    before the fix: 40 bytes of divergence was enough to lose a peer turn.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return False, start_offset          # no transcript yet — nothing to say
    if size <= start_offset:
        return False, start_offset
    try:
        with path.open("rb") as fh:
            fh.seek(start_offset)
            data = fh.read()
    except OSError:
        return False, start_offset

    consumed = start_offset
    for raw in data.splitlines(keepends=True):
        if not raw.endswith(b"\n"):
            break                            # partial append; retry next poll
        consumed += len(raw)
        try:
            entry = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            continue
        if entry.get("type") != "user":
            continue
        origin = entry.get("origin")
        # Any origin at all means the turn was not spoken by the human: `peer`
        # is a cross-session message, `task-notification` an internal notice. A
        # spoken turn carries no `origin` key. Unknown future kinds are treated
        # as non-voice too — that is the safe direction, since the failure this
        # guards against is speaking traffic the human cannot see.
        if isinstance(origin, dict) and origin.get("kind"):
            return True, consumed
    return False, consumed



def bind_session(key: str, sid: str) -> dict:
    """Point a key at an EXISTING session id. Returns {} on success, else {error}.

    Two refusals, both learned rather than guessed:

    - An id with no transcript makes `claude --resume` fail with "No conversation
      found" on the NEXT turn, long after the bind looked like it worked. Verified
      2026-08-04 against a freshly generated uuid.
    - An id already held by another key would put two keys — each with its own
      lock — on one session file at once. Per-key locking is exactly what makes
      concurrent turns safe, and sharing an id defeats it.
    """
    if not (transcript_dir(key) / f"{sid}.jsonl").exists():
        return {"error": f"no transcript for {sid} in {transcript_dir(key)}"}
    with _sessions_lock:
        data = _load()
        for k, v in data.items():
            if k != key and v.get("id") == sid:
                return {"error": f"{sid} is already bound to {k}"}
        old = data.get(key, {}).get("id", "")
        data[key] = {"id": sid, "started": True, "created": time.time(),
                     "turns": data.get(key, {}).get("turns", 0), "last": time.time()}
        _save(data)
    drop_process(key)   # the running process still holds the OLD id
    return {"bound": key, "id": sid, "previous": old}


def reset_session(key: str) -> str:
    """Drop the key's session so the next turn starts a fresh conversation."""
    with _sessions_lock:
        data = _load()
        old = data.pop(key, {}).get("id", "")
        _save(data)
    return old


# ── output shaping ─────────────────────────────────────────────────────────
# A session carrying a personal CLAUDE.md follows *its* output rules — status
# panels, markdown, bullet lists — which are right for a terminal and unusable
# as speech. The voice prompt is advisory and loses to them, so the shim
# enforces: belt (instruction) and braces (post-strip).
# Where the live transcript of the call is written. The assistant is NOT told
# this anywhere else, and without it a whole half of the conversation is
# invisible: text typed into the voice channel's chat never reaches the model —
# it goes to disk only. Observed 2026-08-04: a file path was pasted mid-call and
# captured correctly, then "can you check the file I posted in the chat?" was
# answered "I can't see it", because nothing had ever mentioned the file that
# contained it.
TRANSCRIPT_DIR = setting("SHIM_TRANSCRIPT_DIR", "transcript_dir", "").strip()

TRANSCRIPT_DIRECTIVE = (
    f"A live transcript of this call is written to {TRANSCRIPT_DIR}, one folder "
    "per channel per day — the most recently modified is this conversation, in "
    "`transcript.md`.\n"
    "It holds BOTH what everyone said aloud and everything typed into the voice "
    "channel's text chat, in order, with names. Typed messages reach you ONLY "
    "this way; they are never in your context.\n"
    "So when the user refers to anything from earlier — 'the link I posted', "
    "'the path I pasted', 'what we just discussed' — READ that file before "
    "answering. Do not say you cannot see it, and do not assume 'posted' means "
    "an attachment: it usually means a line in that transcript."
) if TRANSCRIPT_DIR else ""

VOICE_DIRECTIVE = (
    "SPOKEN OUTPUT MODE. Your reply is read aloud, not displayed. Speak the way a person "
    "speaks: full, flowing sentences in a natural conversational register. The OPENING "
    "is spoken, so it is never a clipped fragment or a list read out loud.\n"
    "This overrides any output-format rules in CLAUDE.md or memory: no status panels, no "
    "lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, no 'You:' or 'Next:' lines, "
    "and no emoji anywhere. Markdown, bullets and code formatting are FORBIDDEN in the "
    "first two sentences (they are spoken) and FINE after them (they are read).\n"
    "NEVER put in the FIRST TWO SENTENCES: identifiers, hashes, session ids, byte counts, "
    "file paths, wikilinks, URLs, line numbers, timestamps or version strings. Those two "
    "sentences are the ones spoken aloud, and such things are noise when heard rather than "
    "read — say 'the transcript file' not its path, 'about thirty turns' not an exact "
    "count. AFTER them, write them out properly: that part is read, not heard, and a path "
    "or an id is exactly what the reader needs to copy.\n"
    "If you are about to look something up, SAY ONE SHORT SENTENCE FIRST — 'let me "
    "check that' — then do the lookup and answer. Speaking before the tool runs is what "
    "keeps the silence from feeling broken; your first sentence is spoken while the work "
    "happens.\n"
    "NEVER NARRATE THE WORK. No 'let me read that', no 'right, so that means', no "
    "explaining where you are about to look or what you just realised. The user "
    "hears a filler while you work and does not need a second one from you — say "
    "the answer and nothing else.\n"
    "SHAPE, NOT LENGTH. Only your FIRST TWO SENTENCES are spoken aloud; everything "
    "after them is read in the channel and never heard. So do not ration the answer — "
    "write it completely — but put the ANSWER FIRST. Those two sentences have to stand "
    "on their own as a spoken reply: the actual answer, no preamble, no 'let me "
    "explain', nothing that only makes sense once the rest has been read. A spoken "
    "answer cannot be skimmed or re-read, which is why the point goes at the front — "
    "not why the detail gets dropped.\n"
    "Then continue: the specifics, the list, the exact names, the caveat. That half is "
    "read at the reader's own pace, so it can carry what speech cannot. Structure it "
    "for reading — short paragraphs or a list — and never with an opening line that "
    "merely announces what follows."
)

# Sessions here are disposable by design, so anything that matters must leave
# the session before it is cleared. This is the load-bearing half of keyed
# sessions: without it, clearing one loses decisions that existed nowhere else.
MEMORY_DIRECTIVE = (
    "DURABLE MEMORY. This conversation is a cache, not a record — it will be cleared. "
    "Before the turn ends, write anything worth keeping into the vault: a decision, a "
    "conclusion, a commitment, a fact you had to work to establish. Use the existing task "
    "or Knowledge Base page if one fits, and say in one short clause where you put it. "
    "Do not write chit-chat, and do not ask permission for a small note."
)

# Same lesson as the voice directive: instruct AND post-strip, because the model
# following a formatting instruction every time is not guaranteed.
TEXT_DIRECTIVE = (
    "You are replying in a Discord chat, not a terminal. Do not emit status panels: "
    "no lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, and no 'You:' or 'Next:' "
    "lines. Markdown is fine — Discord renders it. Keep it short unless asked."
)

# Three signals, most reliable first. The state icon is the strongest: those five
# emoji appear only in closer panels, whereas the keyword after them is free-form
# ("⚪ Status check answered" is not "⚪ DONE"), so matching on the word alone
# misses real panels.
# Backchannel that VAD turns into a "turn". Each one otherwise costs a full
# Claude Code invocation (10-70s) AND blocks the per-session lock, so a couple
# of "okay"s while thinking will queue up behind the real question.
#
# Deliberately narrow: bare "yes"/"no" are NOT here, because they are real
# answers to a question the assistant just asked. Only ≤3 words, all filler.
# Greetings and thanks are NOT here: "hello" is an opener that deserves a
# reply, and silence in response reads as the bot being broken. Bare "yes"/"no"
# are excluded for the same reason — they answer a question.
_FILLER_WORDS = {
    "okay", "ok", "yeah", "yep", "yup", "mm", "mmm", "mhm", "mmhmm", "hmm", "hm",
    "uh", "um", "ah", "oh", "ooh", "erm", "eh", "alright", "right",
}


def is_filler(text: str) -> bool:
    words = re.findall(r"[\w'-]+", text.lower())
    return 0 < len(words) <= 3 and all(w in _FILLER_WORDS for w in words)


# ── wake phrase ────────────────────────────────────────────────────────────
# In a call the assistant hears every word an allowlisted speaker says — the
# allowlist decides WHO can drive it, never WHETHER a given sentence was meant
# for it. So in company it answered conversations addressed to other people.
#
# A LIST, not a phrase, and the reason is empirical: speech-to-text mangles
# short utterances, and this project's own transcripts have it turning "Wide
# Forest" into "White Forest". Each variant is a deliberate entry — no edit
# distance, no phonetic matching, nothing that widens the surface silently,
# because every variant added is a false-trigger risk accepted on purpose.
#
# Matched as a PREFIX. "so, hey bot, what's my task" deliberately does not
# count: a phrase-anywhere match wakes on any sentence that merely mentions
# the bot, which is exactly the failure this exists to prevent.
#
# Fail quiet: anything unmatched is treated as not addressed. A missed trigger
# costs one repeat; a false trigger interrupts a conversation with other people
# in the room. The two are not equally cheap.
#
# `.strip("\"'")`: the Makefile's `-include local.env` parses with MAKE
# semantics, so `export SHIM_WAKE_PHRASES="a,b"` can arrive with the quote
# characters still inside the value — making the first phrase `"hey bot`, which
# matches nothing anyone says. Same family as the `$HOME` and secret-in-argv
# traps this repo has already been bitten by twice.
WAKE_PHRASES = setting("SHIM_WAKE_PHRASES", "voice.wake_phrases", "hey bot,hey bought,hey but,hi bot").strip("\"'")
# Force the wake phrase even in a solo call. Default off — mirrors the bot's
# `voiceAlwaysWake` (src/config.js `flag()`); both processes read the flag so a
# stale per-key solo=True from before the flag was set cannot disarm the gate.
# The bot also stops posting solo=True, but this is the structural half: an
# instance with VOICE_ALWAYS_WAKE=1 treats every room as not-solo, period.
ALWAYS_WAKE = setting("VOICE_ALWAYS_WAKE", "voice.always_wake", False)
# Anchored to the start of a SENTENCE, not just the start of the utterance.
#
# speech-to-speech accumulates a turn across progressive finals, so one
# transcript grows into "Uh can you check my disk space? Hey bot, can you check
# my disk space?" — the phrase is in there, but never at position zero, and a
# whole-utterance prefix match rejected every retry. Observed live: three
# consecutive properly-addressed attempts all went QUIET.
#
# Still anchored, which is the point: "I told him the bot was broken" does not
# match, because the phrase has to OPEN a sentence rather than merely appear.
# Leading disfluencies are skipped, because people do not start a sentence on
# the wake phrase — they start on a hesitation. Three real failures in one call:
# "Uh hey bot, can you check my free disk space?", "Uh hey hey bot, did you hear
# me?", and a "so," lead-in. Requiring the phrase at the literal sentence start
# made the feature unusable in ordinary speech while looking correct in tests
# written from imagined utterances.
#
# The skippable set is `_FILLER_WORDS` — already defined above, and already the
# project's answer to "noises that are not content" — plus "hey", so a doubled
# "hey hey bot" lands. It does NOT widen what counts as a wake phrase: only
# noise may precede it, never a real word.
_WAKE_LEAD = r"(?:(?:" + "|".join(sorted(_FILLER_WORDS | {"hey"})) + r")[\s,.!?-]+){0,3}"
_WAKE_RE = re.compile(
    r"(?:\A|[.!?]\s+|\n)\W*"
    + _WAKE_LEAD
    + r"(?:"
    + "|".join(re.escape(p.strip()) for p in WAKE_PHRASES.split(",") if p.strip())
    + r")\b",
    re.I,
)


def is_addressed(text: str) -> bool:
    """Does a sentence in this utterance open with a wake phrase?

    `search`, not `match`, because the turn may have accumulated — see the
    regex above. Empty phrase list disables the gate.
    """
    if not WAKE_PHRASES.strip():
        return True
    return bool(_WAKE_RE.search(text))


def strip_wake_phrase(text: str) -> str:
    """Drop the address so the model receives the question, not the greeting.

    "Hey bot, what's my most important task?" reaches Claude as "what's my most
    important task?" — the phrase is how you got its attention, not part of what
    you asked. Left in, a bare "Hey bot." is a greeting the model will answer as
    one, and every real question carries a vocative it may echo back.

    Falls back to the original text when stripping would leave nothing, so a
    bare wake phrase still reaches the model as something rather than an empty
    prompt the endpoint would reject.
    """
    if not WAKE_PHRASES.strip():
        return text
    # Everything BEFORE the wake phrase is dropped along with it: on an
    # accumulated turn that leading text is whatever was said to the room
    # before the assistant was addressed, and feeding it to the model asks the
    # wrong question. Keep only from the phrase onward.
    m = _WAKE_RE.search(text)
    if not m:
        return text
    stripped = text[m.end() :].lstrip(" ,.:;-—")
    return stripped if stripped.strip() else text


_PANEL = re.compile(
    r"^\s*[\U0001F7E2\U0001F7E1\U0001F534\U0001F535\u26AA][^\n]*$"   # 🟢🟡🔴🔵⚪ …
    r"|^[^\w\n]{1,6}\s*(?:You|Next|Recommend)\s*:.*$"                    # 👤 You: / ⏰ Next:
    r"|^[^\w\n]{0,6}\s*(?:\*\*)?(?:READY|DONE|ACTIVE|WAITING|BLOCKED)\b[^\n]*$"
    # 📌 / 🎯 — the task and goal ANCHOR lines that sit above the panel. Missed
    # until a real call put "📌 No task anchor — read-only lookup" in the
    # channel: the icon set above covers the panel's own state line but not the
    # two lines that introduce it, so half a panel was stripped and half posted.
    r"|^\s*[\U0001F4CC\U0001F3AF][^\n]*$",                               # 📌 / 🎯
    re.M,
)


def strip_panels(text: str) -> str:
    """Remove the CLAUDE.md closer panel. Applied to BOTH surfaces.

    A chat window is not a terminal: "READY / You: / Next:" is noise in Discord
    and unspeakable in voice. Markdown is kept for text, where Discord renders
    it, and removed for voice, where TTS would read the asterisks aloud.
    """
    text = _PANEL.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()   # tidy the gaps left behind


# Identifiers read aloud are pure noise — "bee one eff five zero six bee zero".
# The directive asks the model not to emit them; this is the backstop, because
# asking is not the same as guaranteeing.
# Sentence boundary for streaming text to TTS. Punctuation must be followed by
# whitespace, so a decimal ("5.5s") or a version ("v1.2.3") never splits.
_SENTENCE_END = re.compile(r"[.!?…]+[\"')\]]*(?=\s)")
# Longest run of unpunctuated text to hold before flushing anyway. Without this
# a list or a long clause would sit in the buffer until the turn ended, which is
# exactly the dead air streaming is meant to remove.
SENTENCE_MAX = 200

# How long a voice turn may stay silent before the shim speaks for itself.
#
# VOICE_DIRECTIVE asks the model to say one short sentence before it reaches for
# a tool, and it does — sometimes. A directive is a request, not a guarantee, and
# a turn that ignores it is 15s of dead air. This timer makes the early sentence
# deterministic: it fires only when nothing has been spoken yet, so a prompt
# answer is never interrupted by it.
#
# Measured from the start of the turn, and small because the tool_use gate below
# already establishes that a wait is coming. This was 3s when the filler fired on
# time alone — a shorter threshold then interjected in front of answers that were
# already arriving at ~2.4s. Once a tool is running the answer is provably many
# seconds away, so there is nothing left to interrupt and the delay was pure
# cost: it was the largest single slice of the ~4s before the user heard anything.
HOLD_AFTER = setting("SHIM_HOLD_AFTER", "voice.hold_after", 0.5)
# Well inside speech-to-speech's 20s read timeout, and cheap: an empty SSE delta
# is a few dozen bytes and produces no speech.
KEEPALIVE_EVERY = setting("SHIM_KEEPALIVE_EVERY", "voice.keepalive_every", 8.0)
# Fallback for a turn that is slow WITHOUT using tools. This was 8.0 on the
# assumption the path is rare — measured live 2026-09-17 it is not: four of six
# turns on the brogrammers identity reached it, the agent taking >8s to emit its
# first tool_use. 8.0 also collided exactly with the bot's own
# `voiceStallThresholdMs` (8000), so both timers fired together and the BOT's won
# the tie — speaking "still getting the audio ready", which is wrong, because
# nothing is getting ready; the agent is working. 5.0 puts this filler's audio on
# the wire ~3s before that clip can fire, so the user hears a true "one moment"
# instead of a false "starting up". Still above the ~3.8s fast turns, which stay
# silent as before.
HOLD_MAX = setting("SHIM_HOLD_MAX", "voice.hold_max", 5.0)
# One filler covers a 6-15s turn. A vault question can take 30s — measured at
# 30.4s live — and past about ten seconds silence reads as failure again, which
# is exactly what the filler existed to prevent. Repeating it keeps the turn
# audibly alive. 0 disables.
PROGRESS_EVERY = setting("SHIM_PROGRESS_EVERY", "voice.progress_every", 12.0)
# Hard cap on how many sentences are SPOKEN. The voice directive asks for two and
# fresh sessions obey, but a long-running one does not: measured 741 characters,
# five or six sentences, on a session with hundreds of turns behind it. In-context
# precedent beats an instruction — the model imitates its own earlier answers,
# and every long answer makes the next one likelier. A directive cannot win that
# argument, so it is enforced here instead. 0 disables.
SPOKEN_MAX = setting("SHIM_SPOKEN_MAX", "voice.spoken_max", 2)
# Points at the written copy rather than offering to continue: the rest is
# already in the channel by the time this is heard, so "if you want it" invited
# the listener to ask for something they had already been given.
_MORE_LINE = "The details are in the chat."
# Voice-only variant: the chat channel is deliberately silenced, so pointing
# there sends the listener to a place nothing was posted. The written copy is
# the transcript instead. Kept parallel to _MORE_LINE so the spoken tail still
# says where the rest went — dropping it entirely made the cut sound like a
# fault (see the comment where _MORE_LINE is emitted in `push()`).
_MORE_LINE_VOICE = "The details are in the transcript."


def _more_line(voice_only: bool) -> str:
    """The truncation notice, chosen by whether chat posting is silenced.

    Module-level so the branch is unit-testable: `push()` lives inside `ask()`
    and needs a live Claude subprocess, which no test wants to spawn.
    """
    return _MORE_LINE_VOICE if voice_only else _MORE_LINE


# Two sentences each, for the same reason as _CHECK_LINES: speech-to-speech
# releases a sentence only once the next has started, so a lone line would wait
# for the answer and arrive just before it — useless.
_PROGRESS_LINES = (
    "Still looking. Won't be much longer.",
    "Still on it. Nearly there.",
    "Still working through this. One moment.",
    "Give me a little longer. Almost done.",
)
# TWO sentences, deliberately. speech-to-speech releases a sentence to TTS only
# once the NEXT one has started (base_openai_compatible_language_model.py:404) —
# a lone holding line is held as incomplete text until the answer begins, which
# is the whole silence it was meant to fill. Observed 2026-08-03: emitted at 3s,
# spoken at 13.4s. The second sentence is what pushes the first out; it is itself
# held back and lands just before the answer, which reads as a natural beat.
# Deliberately free of any claim about what is happening. The timer is blind —
# it fires on silence, not on tool use — so "checking now" was spoken in reply to
# "thank you". A holding line that only buys time cannot be wrong about anything;
# one that describes the work can.
_HOLD_LINES = (
    "One moment. Just a second.",
    "Hang on. Won't be long.",
    "One second. Bear with me.",
    "Just a moment. Nearly there.",
)

# Spoken when we KNOW a lookup is under way — the question was recognised as
# factual, or the model asked for the tool. Saying so is more use than "hang on":
# it tells the user the request landed and is being worked, which is the whole
# point of speaking early. Kept separate from _HOLD_LINES because the timer path
# fires on silence alone and cannot know what, if anything, is happening.
_CHECK_LINES = (
    "Let me check that. One second.",
    "I'll look that up. Won't be long.",
    "Checking that now. One moment.",
    "Let me find that. Just a second.",
)
# When the model DOES comply, its own holding sentence lands after ours and the
# listener hears two. Recognise the shape and drop the duplicate — only ever the
# first sentence, and only when we already spoke.
_HOLDISH = re.compile(
    r"^\s*(let me\b|one moment|one second|hold on|checking\b|i'?ll check|"
    r"give me a\b|sure,? let me\b|okay,? let me\b)", re.I)
# A trailing abbreviation is not a sentence end. Splitting there makes TTS speak
# "e.g." alone, and CoreAudio clips the first word of every utterance — so the
# fragment is not merely odd, it is inaudible.
_ABBREV = {"e.g", "i.e", "etc", "vs", "approx", "no", "fig",
           "dr", "mr", "mrs", "ms", "prof", "st"}


def _ends_with_abbrev(text: str) -> bool:
    tail = text.rstrip("\"')]").rstrip(".")
    word = re.split(r"[\s(]", tail)[-1].lower() if tail else ""
    return word in _ABBREV


_HEXISH = re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b", re.I)
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
_PATHISH = re.compile(r"\S*/\S+\.\w{1,5}\b")


def strip_markdown(text: str) -> str:
    """Make model output safe to speak: no markup, no panels, no identifiers."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = _UUID.sub("an id", text)
    text = _PATHISH.sub("a file", text)
    text = _HEXISH.sub("an id", text)
    text = _PANEL.sub("", text)
    text = re.sub(r"\[\[([^\]|]*\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"[*_`#>|]+", "", text)
    text = re.sub(r"https?://\S+", "a link", text)
    return re.sub(r"\s+", " ", text).strip()


# ── postable-shape detector ─────────────────────────────────────────────────
# "Truncated" alone misses the answer that is pure payload and never runs long
# enough to hit SPOKEN_MAX — the task's own evidence: "ARC-L1 Wide Forest
# Station", one sentence, never truncated, exactly the thing that needed to be
# written down. This is the second trigger, content shape rather than length.
_URL_RE = re.compile(r"https?://\S+")
_LIST_LINE_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\S", re.M)
# A hyphen/underscore token with a digit in it somewhere — "ARC-L1",
# "task_42", "v0.4.3" style identifiers. \w excludes hyphens, so the digit
# lookahead has to scan the whole allowed charset, not just \w*.
_CODE_RE = re.compile(r"\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+\b")
# Two or more consecutive Capitalized Words — catches a proper noun with no
# digit in it at all, e.g. "Wide Forest Station", which _CODE_RE cannot see.
_TITLE_RUN_RE = re.compile(r"\b(?:[A-Z][a-z]+\s+){1,}[A-Z][a-z]+\b")


# Asking for it in writing is an intent, and intent lives in the USER's turn —
# no amount of looking at the answer can see it. Found on a live call
# 2026-08-09: "can you check what we last bought and write it to the chat?" was
# answered in two sentences of plain prose, so neither trigger fired and
# nothing was posted. Correct by the letter of both triggers, and exactly wrong.
#
# Still a code-side decision, not a model judgement — and the failure mode is
# safe in the direction that matters: an unmatched phrasing just falls back to
# the other two triggers, it never posts something it shouldn't.
_CHAT_REQUEST_RE = re.compile(
    r"\b(?:write|put|post|type|send|drop|paste|share)\b[^.?!]{0,40}?"
    r"\b(?:in|into|to|on)\b\s+(?:the\s+)?(?:chat|channel|text)\b"
    r"|\bin\s+writing\b|\bwrite\s+(?:it|that|this|them)\s+down\b",
    re.I)


def _wants_chat_post(prompt: str) -> bool:
    """Did the user ASK for this in writing? Third trigger, read off their turn."""
    return bool(_CHAT_REQUEST_RE.search(prompt))


# ── voice-only switch (recognition) ─────────────────────────────────────────
# The user can silence chat posting for the rest of a conversation ("don't
# write in the chat") and turn it back on ("you can write in the chat again").
# Same code-side philosophy as `_CHAT_REQUEST_RE`: the intent is read off the
# user's own turn with a regex, never left to the model to announce. An
# unmatched phrasing fails safe — the switch simply stays wherever it was.
#
# Deliberately not covered by `_CHAT_REQUEST_RE` in either direction: "don't
# write in the chat" contains "write ... in the chat" and would otherwise
# trigger a chat post, not silence it. The negations are what make it an OFF.
# The OFF side uses the gerund forms the user actually speaks ("stop POSTING
# text in the chat" was the verbatim instruction that started this task) — a
# plain \bpost\b would never match "posting".
_CHAT_OFF_RE = re.compile(
    r"\b(?:don'?t|do not|stop|quit|no more|enough)\b[^.?!]{0,40}?"
    r"\b(?:write|writing|post|posting|type|typing|send|sending|put|paste|text|texting)\b"
    r"[^.?!]{0,30}?"
    r"\b(?:in|into|to|on)\b\s+(?:the\s+)?(?:chat|channel)\b"
    r"|\bvoice[- ]?only\b",
    re.I)


# The opposite instruction, within the same conversation. "again"/"anymore"
# disambiguate a re-enable from an ordinary "write it in the chat" request:
# the latter is the third trigger (wants the answer posted NOW), the former
# restores posting for subsequent turns.
_CHAT_ON_RE = re.compile(
    r"\b(?:write|post|type|send|put|paste|text)\b[^.?!]{0,40}?"
    r"\b(?:in|into|to|on)\b\s+(?:the\s+)?(?:chat|channel)\b\s+again"
    r"|\byou\s+can\s+(?:write|post|type|send|put|paste|text)\b[^.?!]{0,40}?"
    r"\b(?:again|now|anymore)\b"
    r"|\b(?:start|resume|turn\s+back\s+on|re-?enable)\b[^.?!]{0,40}?"
    r"\b(?:chat|posting|writing)\b",
    re.I)


def _apply_chat_switch(prompt: str, key: str) -> bool:
    """Flip the per-key voice-only flag if the user's turn asks for it.

    Returns whether the switch is now OFF (voice-only). The caller prepends a
    context note to the prompt when it flips, so the mode change reaches the
    model as in-context FACT — a system directive alone loses to in-context
    precedent (the hub page's documented lesson, observed live: after the
    flip the model kept saying "the details are in the chat").
    """
    if is_speech_off(key):
        # Text-only: chat is already ON and speech is OFF, so the chat-off
        # instruction would set (chat_off, speech_off) = (True, True) — the pair
        # that is not a mode, and that leaves the user with nothing at all. The
        # instruction is refused with the way out named, rather than reaching
        # that state without anyone choosing it.
        if _CHAT_OFF_RE.search(prompt):
            print(f"  text-only: chat-off instruction ignored for {key} "
                  f"(use /mode voice-only to speak again)", flush=True)
            return False
        # "write in the chat again" implies speech is on — it clears text-only
        # and returns the conversation to voice-text.
        if _CHAT_ON_RE.search(prompt):
            set_speech_off(key, False)
            print(f"  text-only: speech back ON for {key} "
                  f"(spoken instruction)", flush=True)
        return is_chat_off(key)
    if _CHAT_OFF_RE.search(prompt):
        previous = set_chat_off(key, True)
        if not previous:
            print(f"  voice-only: chat posting OFF for {key}", flush=True)
        return True
    if _CHAT_ON_RE.search(prompt):
        previous = set_chat_off(key, False)
        if previous:
            print(f"  voice-only: chat posting back ON for {key}", flush=True)
    return is_chat_off(key)


def chat_mode_context_note(chat_off: bool, just_turned_on: bool) -> str:
    """The in-context mode note to prepend to a voice turn's prompt.

    Returns the note plus a blank line (ready to concatenate before the
    prompt), or "" when no note belongs — the steady voice-text state (the
    default) needs none, since the model's baseline belief already matches it
    and the plain CHAT_BRIDGE_DIRECTIVE is in the system prompt.
    """
    if chat_off:
        return CHAT_MODE_CONTEXT_NOTE_OFF + "\n\n"
    if just_turned_on:
        return CHAT_MODE_CONTEXT_NOTE_ON + "\n\n"
    return ""


def _has_postable_shape(text: str) -> bool:
    """Would this answer be worth reading back later, even if never truncated?

    Deliberately a code-side detector, not a model judgement — see the task's
    `# Design`: asking the model to decide is a decision already reversed
    three times elsewhere in this file (routing, filler timing, length).
    """
    if _URL_RE.search(text) or _PATHISH.search(text) or _UUID.search(text):
        return True
    if _CODE_RE.search(text) or _TITLE_RUN_RE.search(text):
        return True
    return len(_LIST_LINE_RE.findall(text)) >= 2


def post_chat_message(text: str, key: str, voice_only: bool = False) -> None:
    """POST the full answer to the bot's chat-bridge route. Never raises.

    `key` resolves the target through `identity_for()`, same as cwd/persona —
    three bots can share this one shim, each with its own health server on
    its own port, and CHAT_BRIDGE_URL is a single GLOBAL default. Without a
    per-identity override every identity's answer posts to the SAME bot
    (whichever one owns the global URL), so the other two speak but never see
    their own reply land in the channel — the spoken assistant is dropped
    silently by the bot that has no live voice session, while the wrong bot's
    chat fills up instead. An identity with no `chat_bridge_url` override
    falls back to the global exactly as before — a single-identity install
    behaves unchanged.

    `voice_only` is the conversation's silenced state (see `_apply_chat_switch`):
    the post STILL happens so the transcript keeps the full answer, but the
    payload tells the bot to write the transcript without touching the channel.

    No channel id in the payload — the bot owns routing to whichever voice
    call is actually live (see `# Design`). Best-effort: a failure here must
    never take down a voice turn that has already been spoken.
    """
    if not CHAT_BRIDGE_TOKEN:
        print("  chat bridge: CHAT_BRIDGE_TOKEN not set — skipping post", flush=True)
        return
    url = identity_for(key)["chat_bridge_url"]
    try:
        payload = {"text": text}
        if voice_only:
            payload["voiceOnly"] = True
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {CHAT_BRIDGE_TOKEN}"})
        with urllib.request.urlopen(req, timeout=CHAT_BRIDGE_TIMEOUT) as resp:
            resp.read()
        print(f"  chat bridge: posted ({len(text)} chars) -> {url}", flush=True)
    except Exception as e:
        print(f"  chat bridge: post failed ({e}) -> {url}", flush=True)


def notify_voice_yield(previous_key: str, new_identity: str) -> None:
    """Ask the PREVIOUS holder of the shared speech-to-speech slot to leave.

    LAST JOINER WINS: called from the `/voice/bind` handler when a bind
    changes which identity spoken turns belong to. Mirrors `post_chat_message`
    deliberately — same target resolution (`identity_for(...)["chat_bridge_url"]`),
    same env-only `CHAT_BRIDGE_TOKEN`, same fail-closed-on-empty-token guard —
    reusing the one bridge auth mechanism rather than inventing a second.

    Derived from `chat_bridge_url` (always `.../chat` by convention) rather
    than a separate config key: one URL per identity to maintain, not two.

    Best-effort, like `post_chat_message`: a bot that crashed or was never
    reachable must not block the NEW bind — the cost of failure here is a
    stale voice session lingering until its own retry/error path notices, not
    a wedged handover.
    """
    if not CHAT_BRIDGE_TOKEN:
        print("  voice yield: CHAT_BRIDGE_TOKEN not set — skipping notify", flush=True)
        return
    chat_url = identity_for(previous_key)["chat_bridge_url"]
    url = chat_url.rsplit("/", 1)[0] + "/voice/yield"
    try:
        body = json.dumps({"newIdentity": new_identity}).encode()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {CHAT_BRIDGE_TOKEN}"})
        with urllib.request.urlopen(req, timeout=CHAT_BRIDGE_TIMEOUT) as resp:
            resp.read()
        print(f"  voice yield: asked previous holder to leave -> {url}", flush=True)
    except Exception as e:
        print(f"  voice yield: notify failed ({e}) -> {url}", flush=True)


def notify_voice_rebind() -> None:
    """Ask every configured bot to re-announce its live voice bind.

    A shim restart drops the in-memory `/voice/bind` pointer, so the first
    spoken turn of any call that was live when it went down classifies
    against `default` and the wake gate rejects it. The shim knows it
    restarted; only the bot knows which calls are live — so on startup we
    ask, over the same chat-bridge back-edge `post_chat_message` and
    `notify_voice_yield` use, and each bot re-binds whatever it holds.

    Fan-out to every configured identity rather than the one that was bound:
    the whole point is that the bind is gone, so there is no way to know
    which identity it named. Idempotent on the bot side — a bot with no live
    call answers "nothing to do" and the one with a live call re-binds.

    Best-effort, like both siblings: a bot that is down must not block
    startup, and a shim with no chat bridge configured has nothing to say.
    """
    if not CHAT_BRIDGE_TOKEN:
        print("  voice rebind: CHAT_BRIDGE_TOKEN not set — skipping notify", flush=True)
        return
    # Every identity with an explicit chat_bridge_url, plus the global that
    # identities without one fall back to (`identity_for`) — a restart loses
    # the bind, so we cannot know which of them was holding it.
    urls = {CHAT_BRIDGE_URL}
    for overrides in IDENTITIES.values():
        if overrides.get("chat_bridge_url"):
            urls.add(overrides["chat_bridge_url"])
    for chat_url in sorted(urls):
        url = chat_url.rsplit("/", 1)[0] + "/voice/rebind"
        try:
            req = urllib.request.Request(
                url, data=b"", method="POST",
                headers={"Authorization": f"Bearer {CHAT_BRIDGE_TOKEN}"})
            with urllib.request.urlopen(req, timeout=CHAT_BRIDGE_TIMEOUT) as resp:
                resp.read()
            print(f"  voice rebind: asked bot to re-announce its live call -> {url}", flush=True)
        except Exception as e:
            print(f"  voice rebind: notify failed ({e}) -> {url}", flush=True)


def maybe_yield_voice(previous: str, key: str) -> None:
    """Decide whether the `/voice/bind` handler needs to ask anyone to yield.

    LAST JOINER WINS: called AFTER `bind_voice_key(key)` already moved the
    pointer, `previous` being whatever it returned. Kept separate from
    `bind_voice_key` itself so that function's return contract (pinned by
    `VoiceKeyBinding` tests) never has to change.

    Every branch logs its reason, including the two decisions NOT to notify —
    a bridge call that silently never fires is indistinguishable from one
    that is broken:

    - first bind ever (nothing has held the slot before this process saw a
      bind) — a no-op, not "yield to default", which `_VOICE_KEY`'s own
      DEFAULT_KEY initial value would otherwise look identical to.
    - same identity binding again — no handover happened, nothing to yield.
    - otherwise — best-effort notify via `notify_voice_yield`; a previous
      holder that is unreachable must never block THIS bind, so failure
      there is swallowed (see `notify_voice_yield`'s own docstring).
    """
    global _VOICE_BIND_COUNT
    with _VOICE_BIND_COUNT_LOCK:
        first_bind = _VOICE_BIND_COUNT == 0
        _VOICE_BIND_COUNT += 1

    new_label = _identity_label(key)
    if first_bind:
        print("-> VOICE YIELD: first bind ever, no previous holder — nothing to yield",
              flush=True)
        return

    previous_label = _identity_label(previous)
    if previous_label == new_label:
        print(f"-> VOICE YIELD: same identity ({new_label}), nothing to yield", flush=True)
        return

    print(f"-> VOICE YIELD: asking {previous_label} to yield to {new_label}", flush=True)
    notify_voice_yield(previous, new_label)


# ── persistent claude processes ────────────────────────────────────────────
# One long-lived `claude` per session key, fed over stdin as stream-json.
#
# Spawning `claude -p` per turn re-pays startup every time: measured at ~10s,
# of which trimming MCP from 15 servers to 1 saved only 1.6s — the cost is the
# CLI itself, so only process reuse fixes it. A second turn on a warm process
# measured 4.4s against 7.5s cold, and the gap widens as a session grows.
#
# `--append-system-prompt` is a LAUNCH flag, not per-message. That is fine here
# because a key maps to exactly one surface (voice uses the default key, text
# uses thread:/dm:/channel: keys), so the directive is stable for the process's
# life.
def peer_hung_up(sock) -> bool:
    """True once the client has closed its end.

    A failed write is NOT enough to notice in time: a turn spends most of its
    life running tools, producing nothing to write, so a disconnect at second 5
    would go unseen until the answer at second 60 — measured exactly that. This
    peeks instead: a socket that is readable but yields no bytes has seen EOF.

    Never raises. A socket we cannot inspect is assumed alive, so the failure
    mode is the old behaviour rather than a turn killed by mistake.
    """
    try:
        r, _, _ = select.select([sock], [], [], 0)
        if not r:
            return False
        return sock.recv(1, _socket.MSG_PEEK) == b""
    except (BlockingIOError, InterruptedError):
        return False
    except OSError:
        return True     # already unusable
    except Exception:
        return False


class ClientGone(Exception):
    """The listener hung up — raised by the sink, caught by the turn.

    speech-to-speech drops its HTTP request whenever it supersedes its own turn,
    which happens on every mid-sentence pause. Without this the turn kept running
    to completion holding the per-key lock, and the NEXT request — the one
    carrying the full sentence — queued behind one or two dead turns. Measured
    2026-08-03: three fragments of one sentence, the real answer's holding line
    delayed to 15s purely by that queue.
    """


class ClaudeProcess:
    def __init__(self, key: str, session_id: str, resume: bool, system: str):
        # Persona/cwd/launcher/tools are resolved PER KEY, not read off the
        # module-level CWD/CLAUDE_SCRIPT/MCP_CONFIG/ALLOWED_TOOLS constants —
        # see `identity_for()`. That is the actual routing fix: a second
        # identity's key — `voice:<guildId>:<identity>` or
        # `thread:`/`channel:`/`dm:<id>:<identity>` — now spawns its own
        # process against its own cwd, rather than every turn landing in
        # this instance's one default persona.
        identity = identity_for(key)
        cwd = identity["cwd"]
        claude_script = identity["claude_script"]
        mcp_config = identity["mcp_config"]
        allowed_tools = identity["allowed_tools"]

        # A launcher, when configured, OWNS the environment flags: model,
        # effort, router base URL, --add-dir set, MCP config. Restating them
        # here is how the bot's Claude silently drifted from the desk's —
        # different model, no --add-dir, so a session resumed through `switch`
        # lost capabilities its own history showed it once had.
        cmd = ([claude_script] if claude_script else ["claude"]) + [
               "-p",
               "--input-format", "stream-json", "--output-format", "stream-json",
               # Without this, only COMPLETE assistant events arrive, so there is
               # nothing to stream and the whole reply lands at once — measured
               # first-token == total == 5.5s on a warm process. With it, text
               # arrives token-by-token and TTS can start on the first sentence.
               "--include-partial-messages",
               "--verbose", "--permission-mode", "auto"]
        # Only assert the MCP set when nothing else is: a launcher passes its
        # own --mcp-config, and while the CLI tolerates the flag twice, which
        # copy wins is not something to depend on.
        if not claude_script:
            cmd += ["--mcp-config", mcp_config, "--strict-mcp-config"]
        if CLAUDE_MODEL:
            cmd += ["--model", CLAUDE_MODEL]
        if not UNSAFE:
            cmd += ["--allowed-tools", allowed_tools]
        cmd += ["--resume", session_id] if resume else ["--session-id", session_id]
        if system:
            cmd += ["--append-system-prompt", system]

        self._key = key
        self._session_id = session_id
        self._cwd = cwd
        self._last_used = time.time()

        # stdout goes to a PTY, not a pipe. Claude Code block-buffers when it
        # is not on a terminal, so every event of a turn arrives at once at the
        # end — measured: acknowledgement and answer both landing at 32.4s. On a
        # PTY it line-buffers, and the same turn yields "let me check" at 3.0s
        # with the answer at 7.8s. That early sentence is what TTS speaks while
        # the tools run, instead of dead air.
        self._pty_main, pty_child = pty.openpty()
        self._proc = subprocess.Popen(
            cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=pty_child,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        os.close(pty_child)
        self._out = os.fdopen(self._pty_main, "rb", 0)
        self._buf = b""
        # stderr is kept, not discarded. Claude writes its fatal errors there —
        # including "Session ID … is already in use", the single line that
        # explains the whole 2026-09-18 wedge — and sending it to DEVNULL left
        # "claude process ended" as the only evidence, indistinguishable from an
        # ordinary one-off crash. Drained on its own thread rather than read once
        # the process is gone: a pipe holds a fixed buffer, so a reader that only
        # looks at the end would let a chatty failure block the writer and hang
        # the very turn it was supposed to report.
        self._stderr_tail = ""
        Thread(target=self._drain_stderr, daemon=True).start()
        # cwd logged unconditionally, not only when it differs from the
        # default — the whole point of per-key persona is that this line is
        # what proves a spoken turn was answered by the RIGHT identity, not
        # inferred from the reply. See the task's first Success Criterion.
        print(f"  [{key}] spawned claude ({'resume' if resume else 'new'} {session_id[:8]}) "
              f"cwd={cwd} identity={_identity_label(key)}", flush=True)

    def alive(self) -> bool:
        return self._proc.poll() is None

    def _drain_stderr(self) -> None:
        """Keep the tail of stderr, so a failure can say why it failed.

        Bounded rather than accumulated: a process that logs in a loop would
        otherwise grow this for as long as it runs.
        """
        try:
            for line in self._proc.stderr:
                self._stderr_tail = (self._stderr_tail + line)[-_STDERR_TAIL_CHARS:]
        except (ValueError, OSError):
            pass    # pipe closed under us — nothing left worth keeping

    def stderr_tail(self) -> str:
        return self._stderr_tail.strip()

    def _ended_reason(self) -> str:
        """Why the process ended, in claude's own words when it left any.

        The bare sentence is what made the 2026-09-18 failure expensive: the
        real cause was on a stderr nobody kept, so a permanent wedge and a
        one-off crash looked identical from the outside, and the retry loop
        rebuilt the same broken command indefinitely.
        """
        tail = self.stderr_tail()
        return f"claude process ended: {tail}" if tail else "claude process ended"

    def interrupt(self) -> None:
        """Abandon the in-flight turn without killing the session.

        Verified: the turn ends within ~0.1s with a `result` carrying
        subtype 'error_during_execution', and the SAME process answers the next
        prompt normally — so the session is not desynchronised by this. That
        second property is what makes it safe; without it, waiting out the dead
        turn would be the lesser evil.
        """
        try:
            self._proc.stdin.write(json.dumps({
                "type": "control_request",
                "request_id": str(uuid.uuid4()),
                "request": {"subtype": "interrupt"},
            }) + "\n")
            self._proc.stdin.flush()
        except Exception:
            pass    # a turn we were abandoning anyway

    def _readline(self) -> str | None:
        """One JSON line off the PTY. A PTY has no EOF while the child lives,
        so read byte-wise and split on newlines ourselves; \r is the PTY's
        own line-ending translation and is not part of the payload."""
        while True:
            chunk = self._out.read(1)
            if not chunk:
                return None
            self._buf += chunk
            if chunk == b"\n":
                line = self._buf.decode("utf-8", errors="ignore").replace("\r", "")
                self._buf = b""
                return line

    def ask(self, prompt: str, on_text=None, is_gone=None,
            already_held=False, voice_only=False, speech_off=False) -> tuple[str, bool]:
        """Run one turn. `on_text` receives assistant text as it arrives.

        The `assistant` event carries the reply BEFORE `result` — measured 6.1s
        vs 8.7s on a plain question, and much wider when the turn uses tools,
        because `result` waits for every tool to finish. Waiting for `result`
        therefore throws away speech-ready text; emitting on `assistant` lets
        TTS start earlier and lets the model say "let me check" while it works,
        which is exactly what the voice prompt asks for and never got.

        `voice_only` selects the truncation notice: with the chat channel
        silenced, "the details are in the chat" would send the listener to a
        place nothing was posted, so the spoken tail points at the transcript
        instead (see `_MORE_LINE_VOICE` in `push()`).

        Returns `(text, truncated)` — `truncated` is whether the SPOKEN_MAX cap
        actually cut something short (see `push()`), so a caller can tell "the
        full text has more than what was spoken" apart from "this is all of it".
        """
        # Watch for a turn that is not the human's BEFORE the turn starts, so a
        # peer message injected while we wait cannot be spoken as this answer.
        # See `_transcript_has_non_voice_turn` for why the transcript is the
        # only place this signal exists.
        peer_stop = Event()
        peer_seen = Event()
        peer_path = transcript_dir(self._key) / f"{self._session_id}.jsonl"
        # Bytes already judged. Shared between the watcher and the synchronous
        # check so neither re-parses the other's lines.
        #
        # Starts at the transcript's CURRENT SIZE, never 0. From 0, the first
        # scan reads the whole history and trips on any origin entry already in
        # the file — one `task-notification` from days ago is enough — and
        # `peer_seen` then mutes EVERY turn for the life of the process.
        # Observed live 2026-09-19: the assistant went completely silent
        # mid-call, every turn logging "non-voice turn appeared in the
        # transcript", because the live transcript held exactly one such entry.
        #
        # Only an entry written AFTER this turn starts can be a peer turn
        # injected into it, which is the only thing this gate exists to catch.
        # An entry from before the turn is history, not interference.
        peer_offset = [_transcript_size(peer_path)]

        def peer_check_now() -> bool:
            """Synchronous backstop for the watcher's polling window.

            The watcher only notices a peer turn on its next poll, and a fast
            peer reply could emit a sentence inside that gap. Re-reading from
            the last judged offset at the moment we are about to speak the
            turn's FIRST sentence closes the window that matters — after that
            the watcher has had at least one interval to see anything that
            arrives later.
            """
            found, peer_offset[0] = _transcript_has_non_voice_turn(
                peer_path, peer_offset[0])
            if found:
                peer_seen.set()
            return peer_seen.is_set()

        def peer_watch():
            # Bounded by the turn's own deadline: without it a turn that ends
            # normally leaves the thread stat-ing a transcript forever, and one
            # leak per turn accumulates across a long-lived call.
            deadline = time.time() + TIMEOUT
            while time.time() < deadline and not peer_stop.wait(PEER_WATCH_INTERVAL):
                found, peer_offset[0] = _transcript_has_non_voice_turn(
                    peer_path, peer_offset[0])
                if found:
                    peer_seen.set()
                    print(f"  [{self._key}] non-voice turn appeared in the "
                          f"transcript — muting the rest of this turn",
                          flush=True)
                    return

        Thread(target=peer_watch, daemon=True).start()

        msg = {"type": "user",
               "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

        seen: list[str] = []
        pending = ""       # partial text not yet handed to on_text
        streamed = False   # did any partial reach on_text this turn?
        # `already_held` means the front tier has spoken a filler for this turn.
        # Marking it held both stops us adding a second one and suppresses
        # Claude's own opening "let me check that" as a duplicate.
        held = already_held
        first_out = True   # next emitted sentence is the model's first
        gone = False       # listener hung up; abandon as soon as we notice
        tool_seen = False  # Claude reached for a tool, so a real wait is coming
        # When the listener last heard anything, filler included. A list so the
        # watcher thread can read a value the request thread updates.
        last_spoken = [time.monotonic()]
        spoken = 0         # sentences of real answer actually voiced
        truncated = False  # the "there's more" line has been said once

        def mark_spoken():
            last_spoken[0] = time.monotonic()

        def push(part: str) -> None:
            """The ONLY route from model text to the wire.

            Both the sentence-split path and the end-of-block flush go through
            here: keeping the duplicate check in one of them let the model's own
            holding sentence through whenever it arrived unpunctuated, and the
            listener heard "Let me check that." twice.
            """
            nonlocal streamed, first_out, gone
            if gone or not part:
                return
            if first_out and held and _HOLDISH.match(part):
                # Suppressed as a duplicate of the filler we already spoke.
                # Deliberately does NOT set `streamed`: that flag means real
                # text reached the listener, and it silences the progress
                # watcher. Setting it here left a 34s turn with one filler and
                # then nothing, because the watcher believed we were mid-reply
                # while the only thing produced had just been thrown away.
                first_out = False
                return
            first_out = False

            # Past the cap: say so once, then stay quiet. Cutting mid-answer
            # without acknowledging it sounds like a fault; offering the rest is
            # what the directive asks for anyway, and the full text is still
            # returned to the caller and written to the transcript.
            nonlocal spoken, truncated
            # Text-only: the sentence is produced and counted, but never reaches
            # the wire. This is the ONE choke point — every path from model text
            # to the speaker goes through `push()` — so gating here silences the
            # spoken answer without touching the chat post, which reads the full
            # text after the turn.
            #
            # Marking it spoken keeps the progress watcher quiet (otherwise it
            # decides we have gone silent and interjects "still on it" into a
            # call where nothing is being said). Leaving `truncated` False is
            # deliberate and load-bearing: the chat bridge reads it as "the
            # spoken reply was cut short", and nothing was spoken to cut.
            if speech_off:
                spoken += 1
                mark_spoken()
                return
            # A turn that is not the human's has appeared in this session — a
            # cross-session message injected mid-turn, or an internal notice.
            # Its text is interleaved with the spoken turn's on the ONE stream
            # we read, and speaking it puts an answer to a conversation the
            # listener cannot see into their call. Mute the rest of the turn:
            # the peer's reply is dropped, the human's own answer still arrives
            # when the turn ends, and the full text still reaches the chat
            # bridge and the transcript.
            #
            # Same bookkeeping as `speech_off` above, for the same reasons —
            # count it so the progress watcher does not decide we have gone
            # quiet and interject "still on it" into the silence, and leave
            # `truncated` False because nothing was spoken to cut short.
            #
            # On the turn's FIRST utterance, re-read before deciding: the
            # watcher may not have polled since a peer turn landed.
            if first_out:
                peer_check_now()
            if peer_seen.is_set():
                spoken += 1
                mark_spoken()
                return
            # A sentence ending in a colon promises the answer rather than being
            # it. Counting those spent the budget on throat-clearing: "typed
            # messages only reach me through the transcript." / "Let me read
            # it:" hit the cap before a single word of the answer, so the user
            # heard the preamble and then "there's more if you want it".
            lead_in = part.rstrip().endswith(":")
            if lead_in:
                try:
                    on_text(part)
                    mark_spoken()
                    streamed = True
                except ClientGone:
                    gone = True
                return

            if SPOKEN_MAX > 0 and spoken >= SPOKEN_MAX:
                if truncated:
                    # Still producing, just not voicing it. Count it as speech
                    # anyway or the progress watcher decides we have gone quiet
                    # and interjects "still on it" after "there's more if you
                    # want it" — which sounds like the turn broke.
                    mark_spoken()
                    return
                truncated = True
                # Voice-only never posts to the channel, so the ordinary line
                # would point the listener at a place nothing was written; the
                # written copy is the transcript instead. See `_more_line()`.
                part = _more_line(voice_only)
            try:
                on_text(part)
            except ClientGone:
                gone = True
                return
            spoken += 1
            streamed = True
            mark_spoken()

        def emit_sentences(flush: bool = False) -> None:
            """Hand whole sentences to on_text, never bare tokens.

            TTS synthesises what it is given, so forwarding each delta as it
            arrives produces one clipped utterance per token. Sentence
            boundaries are the natural unit; SENTENCE_MAX bounds the wait for
            text that never punctuates (a long list, a code-ish line).
            """
            nonlocal pending
            if not on_text:
                pending = "" if flush else pending
                return
            search_from = 0
            while True:
                m = _SENTENCE_END.search(pending, search_from)
                if m and _ends_with_abbrev(pending[:m.end()]):
                    search_from = m.end()   # "e.g." — keep looking
                    continue
                if m:
                    cut = m.end()
                elif len(pending) >= SENTENCE_MAX:
                    cut = pending.rfind(" ", 0, SENTENCE_MAX) + 1 or SENTENCE_MAX
                else:
                    break
                part, pending = pending[:cut].strip(), pending[cut:]
                search_from = 0
                push(part)
            if flush and pending.strip():
                push(pending.strip())
                pending = ""

        def speak_holding_line():
            nonlocal held, gone
            if streamed or gone or not on_text:
                return          # already talking; nothing to fill
            held = True
            try:
                on_text(random.choice(_HOLD_LINES))
                mark_spoken()
            except ClientGone:
                gone = True     # the write is also how we learn they left
            except Exception:
                pass            # a failed filler must never break the turn

        # Wait for EVIDENCE of work, not merely for time to pass. A bare timer
        # fires on any slow turn, so "thank you" was answered with "checking
        # now" — a holding line in front of a reply that needed no lookup at
        # all. A tool_use block is the signal that a wait is genuinely coming.
        hold_stop = Event()

        said_before: list[str] = []

        def speak_progress_line():
            nonlocal gone
            if gone or not on_text:
                return
            # Never the same line twice running. Random choice repeats about a
            # quarter of the time with four options, and hearing "still looking"
            # verbatim twice in a row sounds like the bot is stuck rather than
            # working.
            choices = [ln for ln in _PROGRESS_LINES if ln not in said_before[-1:]]
            line = random.choice(choices or list(_PROGRESS_LINES))
            said_before.append(line)
            try:
                on_text(line)
                mark_spoken()
                # shim.log must show when a progress line was actually handed
                # to the voice path — otherwise "generated but swallowed" and
                # "never generated" are indistinguishable on a slow turn.
                print(
                    f"  [{self._key}] progress line emitted at {time.monotonic():.3f}s: {line!r}",
                    flush=True,
                )
            except ClientGone:
                gone = True
            except Exception:
                pass

        def hold_watch():
            """Keep the turn audible: speak whenever the listener has heard
            nothing for a while.

            The test is time since the last thing SPOKEN, not whether anything
            has been spoken at all. A turn commonly says "let me take a look",
            then works silently for another twenty seconds — an
            anything-yet test stops watching at the first word and leaves
            exactly the dead air it was added to prevent.
            """
            began = time.monotonic()
            opened = already_held          # front tier already spoke for us
            while not hold_stop.wait(0.4):
                if gone:
                    return
                now = time.monotonic()
                if not opened:
                    if (tool_seen and now - began >= HOLD_AFTER) or now - began >= HOLD_MAX:
                        speak_holding_line()
                        opened = True
                    continue
                if PROGRESS_EVERY > 0 and now - last_spoken[0] >= PROGRESS_EVERY:
                    speak_progress_line()

        # Runs even when the front tier already spoke: the first filler is then
        # skipped, but the progress lines still cover the long tail.
        if on_text and (HOLD_AFTER > 0 or PROGRESS_EVERY > 0):
            Thread(target=hold_watch, daemon=True).start()

        def stop_timer():
            hold_stop.set()

        interrupted = False
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            # Noticed on the previous iteration that nobody is listening. Stop
            # the turn so the per-key lock frees for the request that replaced
            # it, then keep reading until `result` so the process stays in sync.
            if not gone and is_gone and is_gone():
                gone = True
            if gone and not interrupted:
                interrupted = True
                stop_timer()
                if is_barge_in_off(self._key):
                    # Barge-in cancellation is OFF for this conversation (set
                    # via /interrupt): the listener speaking mid-turn must NOT
                    # discard the in-flight answer. Stop speaking into the
                    # dead socket and stop the fillers, but let the turn run to
                    # completion — the full answer still reaches the chat
                    # bridge/transcript instead of dying at `0 chars`.
                    print(f"  [{self._key}] listener gone — interrupt OFF, answer continues", flush=True)
                else:
                    print(f"  [{self._key}] listener gone — interrupting turn", flush=True)
                    self.interrupt()

            line = self._readline()
            if line is None:
                stop_timer()
                raise RuntimeError(self._ended_reason())
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = event.get("type")
            if kind == "stream_event":
                # {"type":"stream_event","event":{"type":"content_block_delta",
                #   "delta":{"type":"text_delta","text":"…"}}}
                # Only text_delta: input_json_delta is tool arguments and
                # thinking_delta is private reasoning — neither is speakable.
                ev = event.get("event", {})
                if ev.get("type") == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta":
                        pending += d.get("text", "")
                        emit_sentences()
                elif ev.get("type") == "content_block_start":
                    if ev.get("content_block", {}).get("type") == "tool_use":
                        tool_seen = True
                elif ev.get("type") == "content_block_stop":
                    emit_sentences(flush=True)
            elif kind == "assistant":
                chunk = "".join(
                    c.get("text", "")
                    for c in event.get("message", {}).get("content", [])
                    if c.get("type") == "text"
                ).strip()
                if chunk:
                    # Authoritative text for the RETURN value only. It repeats
                    # what the deltas already carried, and it arrives BEFORE
                    # content_block_stop — so emitting here too would speak the
                    # block once now and again at the flush. Streaming is left
                    # entirely to the deltas.
                    seen.append(chunk)
            elif kind == "result":
                # A block that never closed (turn ended early, or the model
                # stopped without punctuation) would otherwise be swallowed.
                stop_timer()
                emit_sentences(flush=True)
                self._last_used = time.time()
                final = str(event.get("result") or "").strip()
                # `result` repeats the last assistant text; return what was
                # already emitted so the caller does not say it twice.
                return (final if not seen else "\n".join(seen)), truncated
        stop_timer()
        raise TimeoutError(f"no result within {TIMEOUT}s")

    def close(self):
        try:
            self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._out.close()
        except Exception:
            pass
        try:
            self._proc.stderr.close()
        except Exception:
            pass
        try:
            self._proc.terminate()
        except Exception:
            pass


_procs: dict[str, ClaudeProcess] = {}
_procs_lock = Lock()


def get_process(key: str, system: str) -> ClaudeProcess:
    with _procs_lock:
        proc = _procs.get(key)
        if proc and proc.alive():
            return proc
        if proc:
            print(f"  [{key}] claude process died, respawning", flush=True)
            proc.close()
        sid, started = get_session(key)
        proc = ClaudeProcess(key, sid, started, system)
        _procs[key] = proc
        return proc


def drop_process(key: str) -> None:
    with _procs_lock:
        proc = _procs.pop(key, None)
    if proc:
        proc.close()


def _utc_iso() -> str:
    """Wall-clock UTC stamp, so a shim turn can be joined to the bot's logs.

    Durations here are measured on `time.monotonic()`, which shares no origin
    with the ISO timestamps the bot writes — so a duration alone cannot be
    placed on a turn. Stamping the start makes `start + duration` a wall-clock
    window that the bot's `mic turn start-to-audio` line can be compared
    against, which is what attributes a slow turn to a stage.
    """
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def ask_claude(key: str, system: str, prompt: str, on_text=None, is_gone=None,
               already_held=False, voice_only=False,
               speech_off=False) -> tuple[str, bool, bool]:
    """Ask over the persistent process, respawning once if it has died.

    Returns `(text, truncated, ok)`. `ok` is False on every error/timeout
    fallback path — those return a synthetic sentence like "(claude
    unavailable: ...)" for the ordinary text/voice reply, which is fine to
    speak or show inline, but the chat-bridge trigger must never mistake one
    for a real answer: `_has_postable_shape` can match a local filesystem
    path or an error class name inside the sentinel text and post it to the
    channel as if it were content. See do_POST's `if answer and ok and ...`.
    """
    for attempt in (1, 2):
        proc = get_process(key, system)
        began = time.monotonic()
        began_iso = _utc_iso()
        try:
            out, truncated = proc.ask(prompt, on_text=on_text, is_gone=is_gone,
                                       already_held=already_held,
                                       voice_only=voice_only,
                                       speech_off=speech_off)
            mark_started(key)
            print(f"  [{key}] {began_iso} {time.monotonic() - began:.1f}s, {len(out)} chars",
                  flush=True)
            return out, truncated, True
        except (RuntimeError, BrokenPipeError, OSError) as e:
            print(f"  [{key}] process failed ({e}), attempt {attempt}", flush=True)
            drop_process(key)
            if attempt == 2:
                return f"(claude unavailable: {e})", False, False
        except TimeoutError as e:
            print(f"  [{key}] {e}", flush=True)
            return f"(timed out after {TIMEOUT}s)", False, False
    return "(claude unavailable)", False, False


def _legacy_ask_claude(key: str, system: str, prompt: str) -> str:
    sid, started = get_session(key)
    cmd = ["claude", "-p", prompt, "--output-format", "text",
           "--mcp-config", MCP_CONFIG, "--strict-mcp-config",
           "--permission-mode", "auto"]
    if not UNSAFE:
        cmd += ["--allowed-tools", ALLOWED_TOOLS]
    cmd += ["--resume", sid] if started else ["--session-id", sid]
    if system:
        cmd += ["--append-system-prompt", system]

    began = time.monotonic()
    try:
        r = subprocess.run(cmd, cwd=CWD, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return f"(timed out after {TIMEOUT}s)"

    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()[:400]
        # A resume can fail if the session file was pruned; start a new one once.
        if started and "session" in err.lower():
            reset_session(key)
            print(f"  [{key}] resume failed, starting fresh: {err[:120]}", flush=True)
            text, _truncated, _ok = ask_claude(key, system, prompt)
            return text
        print(f"  [{key}] claude failed rc={r.returncode}: {err}", flush=True)
        return f"(claude error: {err[:200]})"

    mark_started(key)
    out = r.stdout.strip()
    print(f"  [{key}] {time.monotonic() - began:.1f}s, {len(out)} chars", flush=True)
    return out


def extract(messages: list[dict]) -> tuple[str, str]:
    system = "\n\n".join(
        c if isinstance(c := m.get("content"), str) else json.dumps(c)
        for m in messages if m.get("role") == "system"
    )
    users = [m for m in messages if m.get("role") == "user"]
    prompt = ""
    if users:
        c = users[-1].get("content")
        prompt = c if isinstance(c, str) else " ".join(
            p.get("text", "") for p in c if isinstance(p, dict))
    return system.strip(), prompt.strip()


class _StreamWriter:
    """Incremental SSE writer for one response.

    Headers go out on the first chunk, so a turn that produces nothing (a
    superseded or filler turn) can still answer with the simple empty body.
    """

    def __init__(self, handler):
        self._h = handler
        self._id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        self._created = int(time.time())
        self._started = False
        # The keepalive runs on its own thread; two writers interleaving would
        # split an SSE frame down the middle.
        self._wlock = Lock()

    def keepalive(self) -> None:
        """Empty delta — resets the client's read timeout, says nothing.

        speech-to-speech aborts a request after 20s with no bytes
        (base_openai_compatible_language_model.py:139) and speaks a canned
        apology. That is a gap between chunks, not a total, so a tool phase
        longer than 20s killed the turn even though it was progressing. An empty
        delta is a well-formed chunk that adds no text, so nothing is spoken.
        Sent only once the response has started; before that there is nothing to
        keep alive.
        """
        if self._started:
            self._raw({})

    def _send(self, delta: dict, finish=None):
        if not self._started:
            self._h.send_response(200)
            self._h.send_header("Content-Type", "text/event-stream")
            self._h.send_header("Cache-Control", "no-cache")
            self._h.send_header("Connection", "close")
            self._h.end_headers()
            self._started = True
            self._raw({"role": "assistant", "content": ""})
        self._raw(delta, finish)

    def _raw(self, delta: dict, finish=None):
        chunk = {"id": self._id, "object": "chat.completion.chunk", "created": self._created,
                 "model": MODEL,
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        with self._wlock:
            self._h.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self._h.wfile.flush()

    def chunk(self, text: str):
        if text:
            self._send({"content": text})

    def finish(self):
        if not self._started:
            self._send({"content": ""})
        self._raw({}, finish="stop")
        self._h.wfile.write(b"data: [DONE]\n\n")
        self._h.wfile.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def handle_one_request(self):
        """Client disconnects are normal here, not errors.

        speech-to-speech cancels its own in-flight request on barge-in and on a
        superseded turn, so the socket is often gone by the time we answer.
        The default handler dumps a traceback for that; it is expected traffic.
        """
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            print("   (client went away — cancelled turn)", flush=True)
            self.close_connection = True

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _key(self) -> str:
        # A header means the bot made the call and knows its own conversation.
        # No header means speech-to-speech, which cannot send one — so the key
        # is whatever the bot last bound for voice, not a fixed default.
        return self.headers.get("X-Session-Key") or voice_key()

    def _control_authorized(self) -> bool:
        """The one shared check for every route that mutates state.

        Same token the chat-bridge back-edge uses, read the same way (see
        `control_authorized`): a request without the right `Authorization:
        Bearer <CHAT_BRIDGE_TOKEN>` is refused, and an unset token refuses
        everything. Kept a one-liner so the guard reads identically at every
        call site and cannot drift from the module-level contract.
        """
        return control_authorized(self.headers.get("Authorization", ""))

    def do_GET(self):
        path = self.path.rstrip("/")
        if path.endswith("/models"):
            return self._json(200, {"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "anthropic"}]})
        if path.endswith("/sessions/available"):
            return self._json(200, {"available": available_sessions(self._key())})
        if path.endswith("/sessions"):
            now = time.time()
            # `live` is the difference between an id that answers immediately and
            # one that costs a cold spawn (~3s more) on its next turn: the mapping
            # outlives the process, so a persisted id says nothing about warmth.
            with _procs_lock:
                live = {k for k, p in _procs.items() if p.alive()}
            return self._json(200, {"sessions": [
                {"key": k, "id": v["id"], "turns": v.get("turns", 0),
                 "live": k in live,
                 "age_minutes": round((now - v.get("created", now)) / 60, 1)}
                for k, v in sorted(_load().items())
            ]})
        if path.endswith("/voice/state"):
            # The bot's /status back-edge: report the effective posture of every
            # runtime per-conversation toggle for ONE conversation key, so the
            # operator sees wake / posting / interrupt / transcribe at a glance
            # instead of invoking each flag bare. GET is open by design — it only
            # observes, never mutates (the control-plane guard gates do_POST).
            key = self.headers.get("X-Session-Key", "").strip() or DEFAULT_KEY
            return self._json(
                200,
                {
                    "key": key,
                    "wake": effective_always_wake(key),
                    "wake_override": wake_override(key),
                    "posting": not is_chat_off(key),
                    "speech": not is_speech_off(key),
                    "interrupt": not is_barge_in_off(key),
                    "transcribe": not is_transcribe_off(key),
                },
            )
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        # Every route in this handler mutates state — sessions, voice bindings,
        # wake/solo/typing flags, chat-posting posture, and /chat/completions
        # (which drives a Claude Code session with the assistant's full tool
        # allowlist). One shared check guards all of them: a request without
        # the control-plane token is refused before any route runs, and an
        # unset token refuses everything (fail-closed). GET routes stay open —
        # they only observe. See `control_authorized` for the contract.
        #
        # The refusal is logged, not silent — an unset token must be
        # distinguishable from a broken route (same reason the chat-bridge
        # guard prints "not set — skipping post"). Two lines because the
        # diagnosis differs: an unset token is a config gap (nothing on this
        # side can fix it), a wrong/missing header is a caller bug.
        if not self._control_authorized():
            if not CHAT_BRIDGE_TOKEN:
                print("  control route: CHAT_BRIDGE_TOKEN not set — refusing every mutating route", flush=True)
            else:
                print("  control route: missing or wrong token — refused", flush=True)
            return self._json(401, {"error": {"message": "unauthorized"}})

        if self.path.rstrip("/").endswith("/sessions/bind"):
            key = self._key()
            try:
                n = int(self.headers.get("Content-Length") or 0)
                sid = (json.loads(self.rfile.read(n) or b"{}").get("id") or "").strip()
            except ValueError:
                return self._json(400, {"error": {"message": "bad json"}})
            if not sid:
                return self._json(400, {"error": {"message": "id required"}})
            res = bind_session(key, sid)
            if "error" in res:
                print(f"-> BIND [{key}] refused: {res['error']}", flush=True)
                return self._json(409, {"error": {"message": res["error"]}})
            print(f"-> BIND [{key}] {sid} (was {res['previous'] or 'none'})", flush=True)
            return self._json(200, res)

        # The bot calls this immediately before pushing a typed turn into its
        # s2s socket — see `_TYPED_TURN_HINTS`. Deliberately takes no body: the
        # text arrives the normal way, this only says which SURFACE asked.
        if self.path.rstrip("/").endswith("/voice/bind"):
            # The bot names the conversation spoken turns belong to. Sent on
            # join only — never unbound on leave, because no spoken turn exists
            # while no call is live, and leaving the pointer where it is means a
            # straggling turn lands in the conversation it was spoken into.
            key = self.headers.get("X-Session-Key") or DEFAULT_KEY
            previous = bind_voice_key(key)
            print(f"-> VOICE KEY [{key}] (was {previous})", flush=True)
            maybe_yield_voice(previous, key)
            return self._json(200, {"key": key, "previous": previous})

        # Sticky, and sent whenever the room changes — not per turn. The bot is
        # the only side that can see who is in the voice channel; the shim is
        # the only side that runs the wake gate. Same out-of-band shape as
        # /voice/bind above, for the same reason: speech-to-speech owns the HTTP
        # call and can attach no headers of its own.
        if self.path.rstrip("/").endswith("/voice/solo"):
            key = self.headers.get("X-Session-Key", "").strip()
            if not key:
                # The bot always sends the key, mirroring /voice/bind and
                # /turns/typed — a missing one is a client bug, not something
                # to silently fold into a default key (which is what the old
                # global did, and the cause of the 2026-08-18 cross-call leak).
                return self._json(400, {"error": {"message": "missing X-Session-Key"}})
            solo = self.headers.get("X-Voice-Solo", "").strip().strip("\"'").lower()
            previous = set_solo(key, solo in ("1", "true", "yes", "on"))
            print(f"-> SOLO [{key}={is_solo(key)}] (was {previous})", flush=True)
            return self._json(
                200,
                {"solo": is_solo(key), "previous": previous, "key": key},
            )

        # Runtime wake-phrase override, set by an admin over the bot's slash
        # command. Sticky and out-of-band for the same reason as /voice/solo
        # above: speech-to-speech owns the HTTP call to /chat/completions and
        # can attach no headers of its own, so posture has to arrive separately.
        #
        # X-Voice-Wake: on | off | default. `default` (also accepted as
        # `clear`) CLEARS the override rather than setting it false — "no
        # override, use VOICE_ALWAYS_WAKE" is a third state, and conflating it
        # with off would make the configured default unreachable until the
        # process restarts.
        #
        # ADMIN SURFACE: this route carries the decision the bot's
        # config.isAdmin gate makes, so it must not be settable by whatever can
        # merely reach the port. Guarded by the shared control-plane check at
        # the top of do_POST (the same CHAT_BRIDGE_TOKEN the shim's chat-bridge
        # posts carry, validated on the bot side in src/health.js). Since the
        # top-level guard covers EVERY mutating route, /voice/solo and
        # /voice/bind are now equally protected — the original "siblings stay
        # unauthenticated" carve-out was the hole this task closes.
        if self.path.rstrip("/").endswith("/voice/wake"):
            key = self.headers.get("X-Session-Key", "").strip()
            if not key:
                # Same contract as /voice/solo: the bot always sends the key, so
                # a missing one is a client bug. Folding it into a default key
                # is what caused the cross-call leak this route is keyed to
                # avoid in the first place.
                return self._json(400, {"error": {"message": "missing X-Session-Key"}})
            raw = self.headers.get("X-Voice-Wake", "").strip().strip("\"'").lower()
            if raw in ("on", "1", "true", "yes"):
                value = True
            elif raw in ("off", "0", "false", "no"):
                value = False
            elif raw in ("default", "clear"):
                value = None
            else:
                return self._json(
                    400,
                    {"error": {"message": f"bad X-Voice-Wake: {raw!r} (want on|off|default)"}},
                )
            previous = set_wake_override(key, value)
            effective = effective_always_wake(key)
            print(
                f"-> WAKE [{key}] override={value} (was {previous}) "
                f"effective_always_wake={effective}",
                flush=True,
            )
            return self._json(
                200,
                {
                    "key": key,
                    "override": value,
                    "previous": previous,
                    "always_wake": effective,
                    "default": ALWAYS_WAKE,
                },
            )

        if self.path.rstrip("/").endswith("/turns/typed"):
            key = self._key()
            if self.headers.get("X-Turn-Typed", "").lower() == "false":
                clear_typed_turn(key)
                print(f"-> TYPED [{key}] hint cleared", flush=True)
                return self._json(200, {"typed": False, "key": key})
            mark_typed_turn(key)
            print(f"-> TYPED [{key}] next turn came from the keyboard", flush=True)
            return self._json(200, {"typed": True, "key": key})

        # The /mode slash command's back-edge: the bot sets the SAME per-key
        # voice-only flag the spoken instruction flips, so both surfaces drive
        # one state. Sticky like /voice/solo — it describes the conversation's
        # standing mode, not one turn. Same out-of-band shape as /voice/bind:
        # the bot owns the slash surface and the session key; the shim owns
        # the flag that gates the chat-bridge post.
        #
        # ADMIN SURFACE, same as /voice/wake: silencing the channel is an
        # The /mode back-edge: set BOTH per-conversation flags from one mode
        # name. This is the slash-command surface, where the user picks a mode
        # rather than flipping a single flag, and it is the only writer of the
        # pair — see `set_mode` for why (chat_off, speech_off) = (True, True)
        # must stay unreachable. The /chat/posting route below remains for the
        # SPOKEN instruction path, which knows about chat only.
        #
        # X-Mode also accepts `default`/`clear` (mirroring /voice/wake and the
        # other flag routes): CLEAR both per-key overrides, restoring
        # the configured default (voice-text). The on|off aliases are mapped on
        # the BOT side (`on` → voice-text, `off` → voice-only) before the mode
        # reaches this route, so MODES stays the canonical value space.
        if self.path.rstrip("/").endswith("/mode"):
            key = self.headers.get("X-Session-Key", "").strip()
            if not key:
                return self._json(400, {"error": {"message": "missing X-Session-Key"}})
            mode = self.headers.get("X-Mode", "").strip().strip("\"'").lower()
            if mode in ("default", "clear"):
                prev_chat, prev_speech = clear_mode(key)
                print(f"-> MODE  [{key}] default (was chat_off={prev_chat}, "
                      f"speech_off={prev_speech})", flush=True)
                return self._json(
                    200,
                    {"mode": "voice-text", "posting": True, "speech": True,
                     "key": key, "cleared": True},
                )
            if mode not in MODES:
                return self._json(
                    400,
                    {"error": {"message": f"unknown mode {mode!r}; "
                                         f"expected one of {list(MODES)}"}},
                )
            prev_chat, prev_speech = set_mode(key, mode)
            print(f"-> MODE  [{key}] {mode} (was chat_off={prev_chat}, "
                  f"speech_off={prev_speech})", flush=True)
            return self._json(
                200,
                {"mode": mode, "posting": not is_chat_off(key),
                 "speech": not is_speech_off(key), "key": key},
            )

        # operator decision, not state the bot merely observes and reports.
        # Whatever can reach the port must not be able to turn the assistant's
        # chat off — guarded by the shared control-plane check at the top of
        # do_POST, same as every other mutating route.
        if self.path.rstrip("/").endswith("/chat/posting"):
            key = self.headers.get("X-Session-Key", "").strip()
            if not key:
                # The bot always sends the key, mirroring /voice/solo — a
                # missing one is a client bug, not something to fold into a
                # default key (which is what the old global did, and the cause
                # of the 2026-08-18 cross-call leak).
                return self._json(400, {"error": {"message": "missing X-Session-Key"}})
            posting = self.headers.get("X-Chat-Posting", "").strip().strip("\"'").lower()
            if posting in ("default", "clear"):
                # Same clear contract as /voice/wake, /voice/barge and
                # /voice/transcribe: pop the per-key override so the configured
                # default (posting ON) is in force again.
                previous = set_chat_off(key, None)
                state = "DEFAULT (voice-text)"
                print(f"-> CHAT POSTING [{key}] {state} (was {previous})", flush=True)
                return self._json(
                    200,
                    {"posting": True, "previous": not previous, "key": key, "cleared": True},
                )
            off = posting not in ("1", "true", "yes", "on")
            previous = set_chat_off(key, off)
            state = "OFF (voice-only)" if off else "ON (voice-text)"
            print(f"-> CHAT POSTING [{key}] {state} (was {previous})", flush=True)
            return self._json(
                200,
                {"posting": not off, "previous": not previous, "key": key},
            )

        # Runtime barge-in toggle, set by an admin over the bot's slash
        # command. Sticky and per-key like /chat/posting: it describes this
        # conversation's standing behaviour, not one turn.
        #
        # X-Barge-In: on | off | default. `off` DISABLES barge-in cancellation —
        # the listener speaking mid-turn no longer ends the in-flight answer;
        # the reply still completes and reaches the chat bridge/transcript. `on`
        # restores today's behaviour (cancel on barge-in). `default` (also
        # accepted as `clear`, mirroring /voice/wake) CLEARS the per-key
        # override, so the configured default is in force again. The default is
        # `on` — current behaviour stays the safe baseline until a smarter
        # heuristic has numbers.
        #
        # ADMIN SURFACE, same as /chat/posting and /voice/wake: deciding that a
        # turn may survive a barge-in is an operator call, not state the bot
        # merely observes. Guarded by the shared control-plane check at the top
        # of do_POST, same as every other mutating route.
        if self.path.rstrip("/").endswith("/voice/barge"):
            key = self.headers.get("X-Session-Key", "").strip()
            if not key:
                # The bot always sends the key, mirroring /voice/solo — a
                # missing one is a client bug, not something to fold into a
                # default key.
                return self._json(400, {"error": {"message": "missing X-Session-Key"}})
            raw = self.headers.get("X-Barge-In", "").strip().strip("\"'").lower()
            if not raw:
                # Bare POST is the query form (from /interrupt with no option):
                # report the current posture without changing it.
                off = is_barge_in_off(key)
                return self._json(
                    200,
                    {"cancel": not off, "key": key},
                )
            if raw in ("on", "1", "true", "yes"):
                off = False
            elif raw in ("off", "0", "false", "no"):
                off = True
            elif raw in ("default", "clear"):
                previous = set_barge_in_off(key, None)
                state = "DEFAULT (interrupt enabled)"
                print(f"-> INTERRUPT [{key}] {state} (was {previous})", flush=True)
                return self._json(
                    200,
                    {"cancel": True, "previous": not previous, "key": key, "cleared": True},
                )
            else:
                return self._json(
                    400,
                    {"error": {"message": f"bad X-Barge-In: {raw!r} (want on|off|default)"}},
                )
            previous = set_barge_in_off(key, off)
            state = "OFF (interrupt disabled)" if off else "ON (interrupt enabled)"
            print(f"-> INTERRUPT [{key}] {state} (was {previous})", flush=True)
            return self._json(
                200,
                {"cancel": not off, "previous": not previous, "key": key},
            )

        # Runtime transcription toggle, set by an admin over the bot's slash
        # command. Sticky and per-key like /voice/barge: it describes this
        # conversation's standing behaviour, not one turn. Unlike the other
        # switches the shim does not CONSUME this flag — the bot writes the
        # transcripts — but the store still lives here so the posture is
        # queryable without a live call and both sides agree on one source.
        #
        # X-Transcribe: on | off | default. `off` stops the bot writing this
        # call down; `on` restores it. `default` (also accepted as `clear`,
        # mirroring /voice/wake) CLEARS the per-key override, so the configured
        # default is in force again. Bare POST (no header) is the query form:
        # report the current posture without changing it.
        #
        # ADMIN SURFACE, same as the other three: deciding what gets written
        # down is an operator call, not state the bot merely observes. Guarded
        # by the shared control-plane check at the top of do_POST (the same
        # CHAT_BRIDGE_TOKEN the shim's chat-bridge posts carry).
        if self.path.rstrip("/").endswith("/voice/transcribe"):
            key = self.headers.get("X-Session-Key", "").strip()
            if not key:
                # The bot always sends the key, mirroring the sibling routes —
                # a missing one is a client bug, not something to fold into a
                # default key.
                return self._json(400, {"error": {"message": "missing X-Session-Key"}})
            raw = self.headers.get("X-Transcribe", "").strip().strip("\"'").lower()
            if not raw:
                # Bare POST is the query form (from /transcribe with no option):
                # report the current posture without changing it.
                off = is_transcribe_off(key)
                return self._json(
                    200,
                    {"transcribe": not off, "key": key},
                )
            if raw in ("on", "1", "true", "yes"):
                off = False
            elif raw in ("off", "0", "false", "no"):
                off = True
            elif raw in ("default", "clear"):
                previous = set_transcribe_off(key, None)
                state = "DEFAULT (writing down)"
                print(f"-> TRANSCRIBE [{key}] {state} (was {previous})", flush=True)
                return self._json(
                    200,
                    {"transcribe": True, "previous": not previous, "key": key, "cleared": True},
                )
            else:
                return self._json(
                    400,
                    {"error": {"message": f"bad X-Transcribe: {raw!r} (want on|off|default)"}},
                )
            previous = set_transcribe_off(key, off)
            state = "OFF (not writing down)" if off else "ON (writing down)"
            print(f"-> TRANSCRIBE [{key}] {state} (was {previous})", flush=True)
            return self._json(
                200,
                {"transcribe": not off, "previous": not previous, "key": key},
            )

        if self.path.rstrip("/").endswith("/sessions/reset"):
            key = self._key()
            drop_process(key)          # kill the live process, not just the mapping
            old = reset_session(key)
            print(f"-> RESET [{key}] {old or '(none)'}", flush=True)
            return self._json(200, {"reset": key, "previous": old})

        if "chat/completions" not in self.path:
            return self._json(404, {"error": {"message": "not found"}})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"message": f"bad json: {e}"}})

        system, prompt = extract(req.get("messages", []))
        if not prompt:
            return self._json(400, {"error": {"message": "no user message"}})

        key = self._key()

        # Strict identity mode: refuse a turn that would otherwise be served
        # by the implicit default persona — the MOST PRIVILEGED one on this
        # instance — rather than the identity its key actually named or
        # failed to name. Checked before anything else in the turn (no
        # process spawned, no session touched) so an unconfigured or
        # misspelled IDENTITY fails loudly instead of quietly inheriting
        # vault and workspace access. No-op unless `identities.strict: true`
        # AND `identities:` is configured — see `_identity_fallback()`.
        try:
            identity_for(key, enforce=True)
        except IdentityRefused as e:
            print(f"-> REFUSED [{key}] {e.reason} (identities.strict)", flush=True)
            return self._json(403, {"error": {
                "message": f"identity refused: {e.reason}"}})

        # Consumed here, once, at the top of the turn it belongs to — so an
        # abandoned or superseded turn cannot leave the flag behind for an
        # unrelated later one.
        typed_turn = take_typed_turn(key)

        # Answer filler without waking Claude Code. Empty content means
        # speech-to-speech synthesises nothing, so the bot simply stays quiet —
        # which is what a person does when you say "okay" mid-thought.
        if is_filler(prompt):
            print(f"-> SKIP  [{self._key()}] filler: {prompt[:40]!r}", flush=True)
            if req.get("stream"):
                return self._stream("")
            return self._json(200, self._completion(""))

        low = system.lower()
        # The session key is the reliable signal, not the prompt: text surfaces
        # always carry a thread:/dm:/channel: prefix (src/llm.js sessionKeyFor)
        # while voice uses the bare default key.
        #
        # The prompt sniff alone silently failed on every real call — s2s picks
        # its voice system prompt only when wants_audio is set
        # (base_openai_compatible_language_model.py:284), and with TTS as a
        # separate stage it never is. So live voice turns arrived carrying the
        # TEXT prompt, were classified TEXT, and got neither the voice directive
        # nor live streaming. Kept as a fallback for clients that do send it.
        # Mode follows the TRANSPORT, not the key. Once a voice channel's text
        # chat began sharing the spoken session (both key on `default`), keying
        # off the session alone made typed messages answer in speech: "It's the
        # fifth of August, twenty twenty-six" — numbers spelled out, capped at two
        # sentences — to something typed. An explicit header wins in both
        # directions; the keyless default only applies when nothing says
        # otherwise, which is exactly the speech-to-speech case (it owns the HTTP
        # call and can set no headers).
        mode = self.headers.get("X-Output-Mode", "").lower()
        voice = is_voice_turn(mode, key, low)
        print(f"-> {'VOICE' if voice else 'TEXT '} [{key}] {prompt[:70]!r}", flush=True)

        # Wake phrase: in a call the assistant hears everything said by an
        # allowlisted speaker, including whole conversations addressed to other
        # people, and answered all of it. Same silence mechanism as the filler
        # check above — empty content, so speech-to-speech synthesises nothing
        # and no filler line is ever spoken.
        #
        # VOICE ONLY, and never a typed turn. A typed message already had to
        # carry an @mention or arrive in a thread/DM to be answered at all, so
        # it is addressed by construction; demanding a wake phrase on top of
        # that would be asking the user to say it twice.
        # ALONE, the gate is off. "Better silent than too eager" was priced on a
        # false trigger interrupting a room; with no room there is nothing to
        # interrupt, and the cost of a miss (say it again) is unchanged. This
        # reverses only WHEN the gate is armed — how it matches is untouched.
        if voice and not typed_turn:
            solo = is_solo(key) and not effective_always_wake(key)
            if not solo and not is_addressed(prompt):
                print(f"-> QUIET [{key}] not addressed: {prompt[:60]!r}", flush=True)
                if req.get("stream"):
                    return self._stream("")
                return self._json(200, self._completion(""))
            # Addressed: hand on the question without the address. The full
            # utterance, wake phrase and all, is already in the transcript —
            # this only changes what the model is asked. Still stripped when
            # solo: saying "hey bot" out of habit should not change the
            # question the model is asked, and strip_wake_phrase is a no-op on
            # an utterance that carries no phrase.
            prompt = strip_wake_phrase(prompt)

        # The voice-only switch, read off THIS turn and only after the wake
        # gate: "don't write in the chat" silences chat posting for the rest of
        # this conversation, the opposite instruction turns it back on. Gated
        # here so an unaddressed utterance (someone in the room saying it to a
        # human, not the bot) cannot flip the setting — a QUIET turn above
        # never reaches this line. Checked before the post decision below so
        # the instruction's own turn is already silenced.
        chat_off_before = is_chat_off(key)
        _apply_chat_switch(prompt, key)
        chat_off = is_chat_off(key)
        # Read AFTER _apply_chat_switch, so the spoken "write in the chat again"
        # — which clears text-only — is already reflected in this turn's mode.
        speech_off = is_speech_off(key)
        # True exactly on the turn that turns posting back on (the opposite
        # instruction), so the ON note announces the return once, not forever.
        chat_off_just_turned_on = chat_off_before and not chat_off

        # The mode change must ALSO reach the model as in-context FACT, not
        # only as a directive: in-context precedent beats a system prompt (the
        # hub page's documented lesson, observed live 2026-09-03 — after the
        # flip the model kept saying "the details are in the chat" into a
        # silenced channel). The prompt IS the user turn of the session, so
        # stating the mode at its top puts the fact in the history the model
        # reads every turn. OFF is restated on every silenced turn (a long
        # voice-only conversation cannot drift back into claiming chat copy
        # exists); ON is stated on the turn that flips back, so the model
        # knows posting is live again before it answers.
        if voice:
            prompt = chat_mode_context_note(chat_off, chat_off_just_turned_on) + prompt

        # The transcript directive is voice-only: it is the record of a call,
        # and a text surface already has its own history in the thread. The
        # chat-bridge directive is replaced by its voice-only inverse when this
        # conversation has silenced posting — see the comment above it.
        parts = [p for p in (system, MEMORY_DIRECTIVE,
                             VOICE_DIRECTIVE if voice else TEXT_DIRECTIVE,
                             TRANSCRIPT_DIRECTIVE if voice else "",
                             (CHAT_BRIDGE_VOICE_ONLY_DIRECTIVE
                              if is_chat_off(key) else CHAT_BRIDGE_DIRECTIVE)
                             if (voice and CHAT_BRIDGE_TOKEN) else "") if p]
        mine = next_seq(key)

        # Live streaming is VOICE ONLY. strip_panels recognises a closer panel in
        # a complete answer; chunk-by-chunk it cannot, so a text surface would
        # leak panel lines into the reply. Text has no latency pressure and keeps
        # the buffer-then-strip path.
        live = bool(req.get("stream")) and voice
        writer = _StreamWriter(self) if live else None
        dead = False

        def on_text(part: str):
            # Must never raise: speech-to-speech drops the socket on barge-in,
            # and an exception here would abandon the read loop mid-turn, leaving
            # the warm process out of sync with its own session.
            nonlocal dead
            if dead:
                return
            # text-only: THIS function is the wire — the `writer.chunk` below is
            # the SSE delta speech-to-speech synthesises. `push()` already
            # returns before reaching here for the streamed answer, but the
            # holding and progress fillers call `on_text` DIRECTLY, so gating
            # each of those callers would leave the next filler added to leak
            # again. The guard belongs at the one point every spoken path
            # funnels through, and silence here is the whole mode.
            if speech_off:
                return
            spoken = strip_markdown(part).strip()
            if not spoken:
                return
            try:
                # Trailing space matters: each sentence is its own SSE delta and
                # the client concatenates them verbatim, so without it a reply
                # arrives as "Still here.That question" — which TTS then reads
                # as one run-on word.
                writer.chunk(spoken + " ")
            except (BrokenPipeError, ConnectionResetError):
                dead = True
                self.close_connection = True
                # Raise rather than swallow: the write is the only place we
                # learn the listener left, and the turn needs to know so it can
                # interrupt instead of running on holding the lock.
                raise ClientGone from None

        # Front tier decides, proxy executes. The front model either answers pure
        # conversation itself — which never wakes Claude — or asks for the tool
        # and gives us a pause-filler to speak while Claude works. Voice only: a
        # text surface has no latency problem worth a second model.
        pre_spoken = False
        if voice and FRONT_API_KEY:
            # Three ways, cheapest first.
            #
            #   recognised chat  -> front answers                       ~1.0s
            #   plainly factual  -> Claude, filler decided locally      0.14s
            #   anything else    -> front under the refusal contract
            #
            # The middle case skips the round trip because the wording already
            # settles it: asking the model costs ~3s of silence to be told what
            # a regex knew for free.
            #
            # The third case is why this is not just an allowlist. A whitelist
            # cannot enumerate every way of being conversational — "yo what's
            # up" is chat, "did that finish" is not, and neither matches a
            # pattern worth writing. The refusal contract handles that band, and
            # handles it safely: 20 factual trials including subtle phrasings,
            # zero fabrications.
            #
            # The factual patterns stay as defence in depth rather than as the
            # gate. They were the gate once, and a single missing "s" —
            # \btask\b cannot match "tasks" — let an invented task, count and
            # due date be spoken as fact (2026-08-04 17:24).
            if FRONT_HEURISTICS and is_chitchat(prompt):
                said, want_claude = front_route(key, prompt)
            elif FRONT_HEURISTICS and looks_factual(prompt):
                said, want_claude = random.choice(_CHECK_LINES), True
            else:
                said, want_claude = front_route(key, prompt)
            # Models commonly return EITHER content OR tool calls, so asking for
            # a pause-filler alongside the call gets one only sometimes. Supply
            # our own when it does not — unless fillers are switched off, in
            # which case the pause is left bare on purpose.
            if want_claude and not said and HOLD_AFTER > 0:
                said = random.choice(_CHECK_LINES)
            if said and live and not speech_off:
                try:
                    writer.chunk(strip_markdown(said) + " ")
                    pre_spoken = True
                except (BrokenPipeError, ConnectionResetError):
                    dead = True
            if not want_claude:
                said = strip_markdown(said)
                print(f"-> FRONT [{key}] {said[:60]!r}", flush=True)
                remember(key, prompt, said)
                if live:
                    writer.finish()
                    return
                return self._stream(said) if req.get("stream") else \
                    self._json(200, self._completion(said))
            print(f"-> ASK   [{key}] front deferred{' (said filler)' if said else ''}",
                  flush=True)

        # Keepalive for the whole turn, including the wait for the lock: a turn
        # queued behind another can easily exceed the client's 20s read timeout
        # before it even starts.
        stop_keepalive = Event()
        if live:
            def keepalive_loop():
                while not stop_keepalive.wait(KEEPALIVE_EVERY):
                    if dead:
                        return
                    try:
                        writer.keepalive()
                    except Exception:
                        return
            Thread(target=keepalive_loop, daemon=True).start()

        try:
            with _locks[key]:             # per key, so other keys run concurrently
                # While we waited for the lock a newer turn may have arrived —
                # this one is a partial hypothesis of the same sentence. Drop it
                # rather than spending a Claude invocation on stale text.
                if superseded(key, mine):
                    print(f"-> STALE [{key}] superseded, dropping: {prompt[:40]!r}", flush=True)
                    return self._stream("") if req.get("stream") else self._json(200, self._completion(""))
                answer, truncated, ok = ask_claude(
                    key, "\n\n".join(parts), prompt,
                    on_text=on_text if live else None,
                    is_gone=(lambda: peer_hung_up(self.connection)) if live else None,
                    already_held=pre_spoken,
                    voice_only=chat_off,
                    speech_off=speech_off)
        finally:
            stop_keepalive.set()

        if live:
            # Claude's answer is what the user heard, so it is what the front
            # tier must believe it said — otherwise "say that again" is answered
            # by a model with no idea what came before.
            remember(key, prompt, strip_markdown(answer))
            if not dead:
                try:
                    writer.finish()
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
            # The chat bridge: post the FULL answer, not what was spoken.
            # Two triggers, either is enough — see `# Design`, "What still
            # needs deciding during implementation": length alone misses a
            # short pure-payload answer that never hit SPOKEN_MAX. `ok` guards
            # against posting a sentinel failure string as if it were content
            # — "(claude unavailable: ...)" routinely contains a local path or
            # an error-class name that _has_postable_shape happily matches.
            #
            # Every decision is logged WITH ITS REASON, including the decision
            # not to post. Without it a non-post and a broken bridge look
            # identical from the outside — the same class of blindness that made
            # the 2026-08-04 Discord outage take four restarts to diagnose,
            # where a filtered event and an event that never arrived were
            # indistinguishable until both were logged before filtering.
            if not answer or not ok:
                reason = "no answer" if not answer else "failed turn"
                print(f"  chat bridge: not posting ({reason})", flush=True)
            else:
                # `typed_turn` first, and unconditional: asking from the
                # keyboard is the strongest possible signal that the answer is
                # wanted in a form you can keep. The other three are
                # inferences about the answer; this one is a fact about the
                # question. Spoken turns keep the inferences, so a spoken
                # "hello" still does not litter the channel.
                #
                # Voice-only mode (see _apply_chat_switch) gates all of these
                # upstream: the answer is still posted — but to the transcript,
                # not to the channel. The bridge stays on the one path so
                # nothing is lost; only the destination changes.
                chat_off = is_chat_off(key)
                # Text-only forces the post, ahead of all four inferences. With
                # speech off nothing is streamed, so `truncated` is False; a
                # short plain SPOKEN question then fires none of the triggers
                # and the turn would end at "not posting (short, plain, and not
                # requested)" — the user hears nothing AND sees nothing, which
                # is the one outcome this mode must not produce. In text-only
                # the channel IS the output surface, so the inference is moot.
                why = ("text-only mode (chat is the only surface)" if speech_off
                       else "the question was typed" if typed_turn
                       else "asked for it in writing" if _wants_chat_post(prompt)
                       else "spoken reply was truncated" if truncated
                       else "answer has postable shape" if _has_postable_shape(answer)
                       else "")
                if why:
                    where = "transcript only (voice-only)" if chat_off else "channel"
                    print(f"  chat bridge: posting to {where} — {why}", flush=True)
                    # strip_panels, same as the text branch below. The bridge
                    # posts into a Discord channel, which is a chat window and
                    # not a terminal — its docstring says "applied to BOTH
                    # surfaces", and this path was the one place that skipped
                    # it, so "📌 No task anchor" and "⏰ Next:" lines were
                    # landing in the channel verbatim.
                    post_chat_message(strip_panels(answer), key, voice_only=chat_off)
                else:
                    print("  chat bridge: not posting (short, plain, "
                          "and not requested)", flush=True)
            return

        answer = strip_markdown(answer) if voice else strip_panels(answer)
        if req.get("stream"):
            self._stream(answer)
        else:
            self._json(200, self._completion(answer))

    def _completion(self, text: str) -> dict:
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    def _stream(self, text: str):
        """Send an ALREADY-COMPLETE answer as sentence-sized chunks.

        The non-live path: text surfaces, and voice turns that produced nothing
        (filler, superseded). Live voice streaming goes through _StreamWriter in
        do_POST instead, driven by on_text as Claude produces the text."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        cid, created = f"chatcmpl-{uuid.uuid4().hex[:24]}", int(time.time())

        def send(delta: dict, finish=None):
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": created,
                     "model": MODEL,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()

        def safe(*a, **kw):
            try:
                send(*a, **kw)
                return True
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
                return False

        if not safe({"role": "assistant", "content": ""}):
            return
        for part in re.findall(r"[^.!?]+[.!?]*\s*", text) or [text]:
            if part and not safe({"content": part}):
                return
        if not safe({}, finish="stop"):
            return
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


if __name__ == "__main__":
    existing = _load()
    print(f"claude-code shim on http://{HOST}:{PORT}/v1")
    print(f"  sessions {len(existing)} known ({SESSIONS_FILE})")
    print(f"  tools    {'UNRESTRICTED (SHIM_UNSAFE=1)' if UNSAFE else str(ALLOWED_TOOLS.count(',') + 1) + ' allowed'}")
    print(f"  cwd      {CWD}")
    print(f"  claude   {CLAUDE_SCRIPT or 'claude (bare — no launcher configured)'}")
    print(f"  config   {CONFIG_FILE if _CFG else str(CONFIG_FILE) + ' (absent, using env + defaults)'}")
    if IDENTITIES:
        for guild_id, overrides in sorted(IDENTITIES.items()):
            print(f"  identity {guild_id} -> cwd={overrides.get('cwd', CWD)}")
    else:
        print("  identities  none configured — every key resolves to the default persona")
    # Tell every bot we serve that this process came back up with no memory
    # of who was bound — each re-announces its live call (or answers "nothing
    # to do"). One POST per identity per restart, never a poll; see
    # notify_voice_rebind(). Runs from a daemon thread AFTER the server is
    # constructed (not before it serves): a bot that receives the ping
    # immediately POSTs its re-bind back to `/voice/bind`, and that POST must
    # land on a listening server — notifying first made the very first
    # restart race the bind it was meant to fix.
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    Thread(target=notify_voice_rebind, daemon=True).start()
    server.serve_forever()
