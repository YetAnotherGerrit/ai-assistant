"""Tests for shim/claude_openai_shim.py.

The shim had no tests at all until 2026-08-10, which is how a change to session
keys silently disabled the wake phrase in a live meeting: `make precommit` runs
`node --test`, and the shim is Python, so nothing here was ever executed by a
check. These cover the decisions that are cheap to get wrong and expensive to
notice — classification and key routing — not the HTTP or subprocess plumbing.

Run: python3 -m unittest discover -s test -p 'test_*.py'
"""

import ast
import contextlib
import io
import json
import os
import pathlib
import re
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "shim"))

import claude_openai_shim as shim  # noqa: E402


def _function_source(name):
    """The source of a function by name, nested or not.

    Some of the invariants worth pinning live inside closures in `do_POST` —
    `on_text` is the whole spoken wire — and there is no seam to call them
    through without standing up an HTTP request, a model call and a live
    writer. Reading the function's own source is the honest way to assert
    "this guard is here and it comes first"; the alternative is a test that
    proves the guard works by never exercising the path that bypasses it.
    """
    src = pathlib.Path(shim.__file__).read_text()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return ast.get_source_segment(src, node)
    return None


class IsVoiceTurn(unittest.TestCase):
    """Whether a turn counts as SPOKEN — this is what gates the wake phrase.

    The regression: voice keys gained a `voice:<guildId>` shape, the classifier
    asked `":" not in key`, every spoken turn became text, and the assistant
    answered every sentence said in a room full of colleagues.
    """

    def test_per_guild_voice_key_is_spoken(self):
        # THE REGRESSION. Fails against the pre-2026-08-10 classifier.
        self.assertTrue(shim.is_voice_turn("", "voice:1118825106303631470"))
        self.assertTrue(shim.is_voice_turn("", "voice:512637223569719307"))

    def test_identity_keyed_voice_key_is_still_spoken(self):
        # The identity-routing fix adds a third segment
        # (`voice:<guildId>:<identity>`). Classification keys on the PREFIX
        # only, so this must stay armed exactly like the 2-segment key — a
        # format change here is what caused the live incident this class
        # documents, and a 3-segment key is the next format change.
        self.assertTrue(shim.is_voice_turn("", "voice:1118825106303631470:personal"))
        self.assertTrue(shim.is_voice_turn("", "voice:512637223569719307:sc"))

    def test_legacy_default_key_is_spoken(self):
        # speech-to-speech sends no header and, before per-guild keys, no key.
        self.assertTrue(shim.is_voice_turn("", shim.DEFAULT_KEY))

    def test_voice_keys_use_the_shared_prefix(self):
        # The bot builds these; the shim matches on the prefix. If the two ever
        # disagree the wake gate silently stops running, so pin the constant.
        self.assertEqual(shim.VOICE_KEY_PREFIX, "voice:")
        self.assertTrue(f"{shim.VOICE_KEY_PREFIX}123".startswith(shim.VOICE_KEY_PREFIX))

    def test_explicit_header_wins_in_both_directions(self):
        # A message TYPED into a call's text chat carries the SAME session key as
        # the speech around it, so the header is the only thing separating them.
        self.assertFalse(shim.is_voice_turn("text", "voice:123"))
        self.assertFalse(shim.is_voice_turn("text", shim.DEFAULT_KEY))
        self.assertTrue(shim.is_voice_turn("voice", "thread:456"))

    def test_ordinary_text_surfaces_are_not_spoken(self):
        for key in ("thread:123", "dm:456", "channel:789"):
            with self.subTest(key=key):
                self.assertFalse(shim.is_voice_turn("", key))

    def test_identity_keyed_text_surfaces_are_still_not_spoken(self):
        # Text now gains a 3rd segment too (`thread:<id>:<identity>` etc.) —
        # classification keys on the PREFIX only, so an identity segment must
        # not flip a text key to spoken any more than it flips a voice key to
        # text. Pinned per-prefix: this is the exact shape change that broke
        # the wake gate once already (see the class docstring).
        for key in ("thread:123:sc", "dm:456:sc", "channel:789:sc"):
            with self.subTest(key=key):
                self.assertFalse(shim.is_voice_turn("", key))
        self.assertTrue(shim.is_voice_turn("", "voice:123:sc"))

    def test_prompt_sniff_still_catches_a_client_that_sends_neither(self):
        self.assertTrue(
            shim.is_voice_turn("", "channel:789", "you are in a spoken conversation")
        )

    def test_mode_is_case_insensitive(self):
        self.assertFalse(shim.is_voice_turn("TEXT", "voice:123"))
        self.assertTrue(shim.is_voice_turn("Voice", "thread:123"))


class VoiceKeyBinding(unittest.TestCase):
    """The pointer speech-to-speech turns are routed by.

    s2s cannot set `X-Session-Key`, so the bot names the conversation out of
    band on join. Getting this wrong sends one server's speech into another
    server's conversation.
    """

    def setUp(self):
        self._previous = shim.voice_key()

    def tearDown(self):
        shim.bind_voice_key(self._previous)

    def test_binding_routes_headerless_requests_and_returns_the_previous(self):
        shim.bind_voice_key("voice:aaa")
        self.assertEqual(shim.voice_key(), "voice:aaa")
        self.assertEqual(shim.bind_voice_key("voice:bbb"), "voice:aaa")
        self.assertEqual(shim.voice_key(), "voice:bbb")

    def test_an_empty_bind_falls_back_to_the_default_rather_than_an_empty_key(self):
        shim.bind_voice_key("")
        self.assertEqual(shim.voice_key(), shim.DEFAULT_KEY)

    def test_a_bound_key_is_still_classified_as_spoken(self):
        # The two halves have to agree: routing a turn to the voice session and
        # enforcing the wake phrase on it are separate code paths, and the bug
        # was that they disagreed.
        shim.bind_voice_key("voice:ccc")
        self.assertTrue(shim.is_voice_turn("", shim.voice_key()))


class IdentityForKey(unittest.TestCase):
    """Which cwd/launcher/mcp/tools a session key resolves to.

    THE ROUTING FIX: `ClaudeProcess` used to read the module-level CWD
    constant no matter which key spawned it, so every identity's spoken turns
    landed in this instance's one default persona regardless of which guild
    was actually talking — s2s wires its backend once at process startup, so
    the shim itself has to make persona a function of the key.
    """

    def setUp(self):
        self._previous = shim.IDENTITIES
        shim.IDENTITIES = {
            "111": {"cwd": "/tmp/guild-a", "claude_script": "/tmp/cc-a"},
            "222": {"cwd": "/tmp/guild-b"},   # only cwd overridden
            "sc": {"cwd": "/tmp/sc", "claude_script": "/tmp/cc-sc",
                   "chat_bridge_url": "http://127.0.0.1:8091/chat"},
        }

    def tearDown(self):
        shim.IDENTITIES = self._previous

    def test_an_unconfigured_guild_falls_back_to_the_instance_default(self):
        resolved = shim.identity_for("voice:999")
        self.assertEqual(resolved["cwd"], shim.CWD)
        self.assertEqual(resolved["claude_script"], shim.CLAUDE_SCRIPT)

    def test_a_configured_guild_gets_its_own_cwd_and_launcher(self):
        # 2-segment key, no IDENTITY set on the bot — the v0.16.0 shape,
        # resolved by guild id exactly as before.
        resolved = shim.identity_for("voice:111")
        self.assertEqual(resolved["cwd"], "/tmp/guild-a")
        self.assertEqual(resolved["claude_script"], "/tmp/cc-a")

    def test_a_3_segment_key_resolves_by_identity_not_by_guild(self):
        # THE AXIS FIX. `111`/`222` are configured by GUILD id and must be
        # ignored for a 3-segment key even when the guild segment matches one
        # of them — only the identity segment may resolve persona.
        resolved = shim.identity_for("voice:111:sc")
        self.assertEqual(resolved["cwd"], "/tmp/sc")
        self.assertEqual(resolved["claude_script"], "/tmp/cc-sc")

    def test_two_identities_in_one_guild_resolve_to_different_personas(self):
        # THE LEAK THIS FIX EXISTS TO PREVENT: two bots serving the same
        # guild, keyed only by guildId, could not both be configured — this
        # is what a 3-segment key makes possible.
        shim.IDENTITIES["boss"] = {"cwd": "/tmp/boss"}
        same_guild_personal = shim.identity_for("voice:999:sc")
        same_guild_boss = shim.identity_for("voice:999:boss")
        self.assertEqual(same_guild_personal["cwd"], "/tmp/sc")
        self.assertEqual(same_guild_boss["cwd"], "/tmp/boss")

    def test_one_identity_across_two_guilds_gets_one_persona(self):
        # The mirror case: sc-assistant serving two guilds must resolve the
        # SAME persona in both, not fragment by guild.
        first = shim.identity_for("voice:111:sc")
        second = shim.identity_for("voice:222:sc")
        self.assertEqual(first["cwd"], second["cwd"])
        self.assertEqual(first["cwd"], "/tmp/sc")

    def test_an_unconfigured_identity_falls_back_to_the_instance_default(self):
        # A 3-segment key never falls through to the guild-keyed lookup —
        # an unconfigured identity name must not accidentally pick up a
        # guildId entry that happens to share the string.
        resolved = shim.identity_for("voice:111:unconfigured")
        self.assertEqual(resolved["cwd"], shim.CWD)

    def test_fields_left_unset_for_a_guild_still_fall_back_to_the_default(self):
        # Guild 222 overrides only cwd — claude_script/mcp_config/allowed_tools
        # must come from the instance default, not go missing or empty.
        resolved = shim.identity_for("voice:222")
        self.assertEqual(resolved["cwd"], "/tmp/guild-b")
        self.assertEqual(resolved["claude_script"], shim.CLAUDE_SCRIPT)
        self.assertEqual(resolved["mcp_config"], shim.MCP_CONFIG)
        self.assertEqual(resolved["allowed_tools"], shim.ALLOWED_TOOLS)

    def test_an_identity_with_a_chat_bridge_url_override_resolves_to_it(self):
        # THE BUG THIS FIELD FIXES: three bots share one shim behind one
        # global CHAT_BRIDGE_URL, so every identity's bridged answer used to
        # post to whichever bot owned the global default — the identity that
        # actually spoke never saw its own reply land in the channel.
        resolved = shim.identity_for("voice:111:sc")
        self.assertEqual(resolved["chat_bridge_url"], "http://127.0.0.1:8091/chat")

    def test_an_identity_with_no_chat_bridge_url_falls_back_to_the_global(self):
        # Guild 111/222 configure cwd but no chat_bridge_url override — must
        # fall back to the instance's global CHAT_BRIDGE_URL, not go missing.
        resolved = shim.identity_for("voice:111")
        self.assertEqual(resolved["chat_bridge_url"], shim.CHAT_BRIDGE_URL)

    def test_no_identity_segment_uses_the_global_chat_bridge_url(self):
        # A 2-segment key with no configured guild — single-identity install
        # or a bot with no IDENTITY set — must behave exactly as before.
        resolved = shim.identity_for("voice:999")
        self.assertEqual(resolved["chat_bridge_url"], shim.CHAT_BRIDGE_URL)

    def test_text_surfaces_never_consult_the_guild_map(self):
        # thread:/dm:/channel: keys name a channel or user, never a guild —
        # identity_for must not misread a channel/user id as a guild id that
        # happens to collide with a configured one.
        for key in ("thread:111", "dm:111", "channel:111"):
            with self.subTest(key=key):
                self.assertEqual(shim.identity_for(key)["cwd"], shim.CWD)

    def test_legacy_default_key_resolves_to_the_instance_default(self):
        self.assertEqual(shim.identity_for(shim.DEFAULT_KEY)["cwd"], shim.CWD)

    def test_a_3_segment_text_key_resolves_that_identity(self):
        # THE GAP THIS PR CLOSES: a 2-segment text key (`thread:`/`dm:`/
        # `channel:`) carries no identity on its own — a bot with `IDENTITY`
        # set now embeds it as a third segment, exactly like voice already
        # does, so it resolves the same way `identity_for` already resolves
        # a 3-segment voice key.
        resolved = shim.identity_for("thread:H1:sc")
        self.assertEqual(resolved["cwd"], "/tmp/sc")
        self.assertEqual(resolved["claude_script"], "/tmp/cc-sc")

    def test_a_2_segment_text_key_falls_back_to_the_instance_default(self):
        # No `IDENTITY` set on the bot — the pre-existing shape, unchanged.
        resolved = shim.identity_for("thread:H1")
        self.assertEqual(resolved["cwd"], shim.CWD)

    def test_two_identities_in_one_channel_resolve_to_different_personas(self):
        # THE LEAK THIS FIX EXISTS TO PREVENT: multiple Discord identities
        # can share one guild, so two bots typing in the SAME channel
        # produce the IDENTICAL 2-segment key without the identity segment —
        # a header could not have separated the SESSIONS, only the persona
        # a process spawns with. The key does both at once.
        shim.IDENTITIES["boss"] = {"cwd": "/tmp/boss"}
        as_sc = shim.identity_for("channel:H1:sc")
        as_boss = shim.identity_for("channel:H1:boss")
        self.assertEqual(as_sc["cwd"], "/tmp/sc")
        self.assertEqual(as_boss["cwd"], "/tmp/boss")

    def test_unknown_identity_in_a_text_key_falls_back_to_default_not_a_crash(self):
        resolved = shim.identity_for("dm:U1:nonexistent")
        self.assertEqual(resolved["cwd"], shim.CWD)
        self.assertEqual(resolved["claude_script"], shim.CLAUDE_SCRIPT)


class DefaultFallbackWarning(unittest.TestCase):
    """The one fallback in this shim that fails OPEN: an unresolved key gets
    served by the top-level default persona — the most privileged one on the
    instance. This is not the fallback changing; it is the fallback becoming
    LOUD when it fires on an instance that actually configured `identities:`.
    """

    def setUp(self):
        self._previous_identities = shim.IDENTITIES
        self._previous_warned = shim._DEFAULT_FALLBACK_WARNED
        self._previous_strict = shim.IDENTITIES_STRICT
        shim._DEFAULT_FALLBACK_WARNED = set()
        shim.IDENTITIES_STRICT = False

    def tearDown(self):
        shim.IDENTITIES = self._previous_identities
        shim._DEFAULT_FALLBACK_WARNED = self._previous_warned
        shim.IDENTITIES_STRICT = self._previous_strict

    def test_warns_once_when_identities_configured_and_key_hits_default(self):
        shim.IDENTITIES = {"sc": {"cwd": "/tmp/sc"}}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            shim.identity_for("thread:H1")
        self.assertIn("WARNING", buf.getvalue())
        self.assertIn("thread:H1", buf.getvalue())

    def test_no_warning_when_identities_is_absent_entirely(self):
        # A fresh single-identity install has no `identities:` block at all —
        # must keep resolving to the default silently, not flagged as a
        # misconfiguration.
        shim.IDENTITIES = {}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            shim.identity_for("thread:H1")
        self.assertEqual(buf.getvalue(), "")

    def test_warning_is_not_repeated_for_the_same_key_and_reason(self):
        shim.IDENTITIES = {"sc": {"cwd": "/tmp/sc"}}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            shim.identity_for("thread:H1")
            shim.identity_for("thread:H1")
        self.assertEqual(buf.getvalue().count("WARNING"), 1)

    def test_unknown_identity_and_no_identity_segment_warn_separately(self):
        # Two distinct reasons on the SAME key must not dedupe against each
        # other — the warn-once cache is keyed on (key, reason), not key alone.
        shim.IDENTITIES = {"sc": {"cwd": "/tmp/sc"}}
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            shim.identity_for("thread:H1:nonexistent")
            shim.identity_for("thread:H1")
        self.assertEqual(buf.getvalue().count("WARNING"), 2)


class IdentityStrictMode(unittest.TestCase):
    """`identities.strict: true` — refuse an unresolved turn instead of
    silently serving it with the most privileged persona on the instance.
    """

    def setUp(self):
        self._previous_identities = shim.IDENTITIES
        self._previous_strict = shim.IDENTITIES_STRICT
        self._previous_warned = shim._DEFAULT_FALLBACK_WARNED
        shim.IDENTITIES = {
            "sc": {"cwd": "/tmp/sc"},
            "111": {"cwd": "/tmp/guild-a"},   # guild-id-keyed, v0.16.0 shape
        }
        shim._DEFAULT_FALLBACK_WARNED = set()

    def tearDown(self):
        shim.IDENTITIES = self._previous_identities
        shim.IDENTITIES_STRICT = self._previous_strict
        shim._DEFAULT_FALLBACK_WARNED = self._previous_warned

    def test_strict_refuses_an_unknown_identity(self):
        shim.IDENTITIES_STRICT = True
        with self.assertRaises(shim.IdentityRefused):
            shim.identity_for("thread:H1:nonexistent", enforce=True)

    def test_strict_refuses_a_no_identity_key(self):
        shim.IDENTITIES_STRICT = True
        with self.assertRaises(shim.IdentityRefused):
            shim.identity_for("thread:H1", enforce=True)

    def test_strict_allows_a_configured_identity(self):
        shim.IDENTITIES_STRICT = True
        resolved = shim.identity_for("thread:H1:sc", enforce=True)
        self.assertEqual(resolved["cwd"], "/tmp/sc")

    def test_strict_allows_a_2_segment_key_matching_a_guild_id_entry(self):
        # A guild-id MATCH is "configured", not "missing" — the v0.16.0
        # shape (no IDENTITY set, key resolved by guild id) must keep working
        # under strict mode exactly like non-strict.
        shim.IDENTITIES_STRICT = True
        resolved = shim.identity_for("voice:111", enforce=True)
        self.assertEqual(resolved["cwd"], "/tmp/guild-a")

    def test_strict_off_preserves_todays_behaviour_exactly(self):
        # enforce=True is passed (as the real request handler does), but with
        # strict OFF nothing raises and the default persona is still served.
        shim.IDENTITIES_STRICT = False
        resolved = shim.identity_for("thread:H1:nonexistent", enforce=True)
        self.assertEqual(resolved["cwd"], shim.CWD)
        resolved = shim.identity_for("thread:H1", enforce=True)
        self.assertEqual(resolved["cwd"], shim.CWD)

    def test_non_enforcing_callers_never_raise_even_when_strict(self):
        # Internal lookups (transcript_dir, chat-bridge target, session
        # listing) must never raise — only the moment of serving an actual
        # turn does. enforce defaults to False.
        shim.IDENTITIES_STRICT = True
        resolved = shim.identity_for("thread:H1:nonexistent")
        self.assertEqual(resolved["cwd"], shim.CWD)

    def test_strict_is_a_noop_when_identities_is_not_configured(self):
        shim.IDENTITIES_STRICT = True
        shim.IDENTITIES = {}
        resolved = shim.identity_for("thread:H1", enforce=True)
        self.assertEqual(resolved["cwd"], shim.CWD)


class LoadIdentitiesFromConfig(unittest.TestCase):
    """Parsing the `identities:` block out of config.yaml's shape.

    A typo here must degrade to "no per-identity routing", never take the
    shim down — the same rule the rest of `_load_config()` already follows.
    """

    def setUp(self):
        self._previous_cfg = shim._CFG

    def tearDown(self):
        shim._CFG = self._previous_cfg

    def test_a_non_mapping_identities_block_is_ignored_not_fatal(self):
        shim._CFG = {"identities": "not a mapping"}
        self.assertEqual(shim._load_identities(), {})

    def test_a_non_mapping_guild_entry_is_skipped_not_fatal(self):
        shim._CFG = {"identities": {"111": "not a mapping", "222": {"cwd": "/tmp/x"}}}
        out = shim._load_identities()
        self.assertNotIn("111", out)
        self.assertEqual(out["222"]["cwd"], "/tmp/x")

    def test_only_recognised_fields_are_carried_over(self):
        shim._CFG = {"identities": {"111": {"cwd": "/tmp/x", "bogus": "ignored"}}}
        out = shim._load_identities()
        self.assertEqual(set(out["111"]), {"cwd"})

    def test_a_missing_identities_block_yields_no_overrides(self):
        shim._CFG = {}
        self.assertEqual(shim._load_identities(), {})

    def test_the_strict_flag_is_not_parsed_as_an_identity_entry(self):
        # `strict` lives in the SAME mapping as identity/guild-id entries
        # (`identities.strict`), but it is a scalar control flag, not an
        # identity — it must never surface in the resolved map nor trip the
        # "must be a mapping" warning meant for a genuinely malformed entry.
        shim._CFG = {"identities": {"strict": True, "sc": {"cwd": "/tmp/sc"}}}
        out = shim._load_identities()
        self.assertNotIn("strict", out)
        self.assertEqual(out["sc"]["cwd"], "/tmp/sc")

    def test_chat_bridge_url_is_carried_over_unexpanded(self):
        # Not path-expanded like cwd/claude_script/mcp_config/allowed_tools —
        # it is a URL, not a filesystem path.
        shim._CFG = {"identities": {"sc": {"chat_bridge_url": "http://127.0.0.1:8091/chat"}}}
        out = shim._load_identities()
        self.assertEqual(out["sc"]["chat_bridge_url"], "http://127.0.0.1:8091/chat")

    def test_https_chat_bridge_url_is_accepted(self):
        shim._CFG = {"identities": {"sc": {"chat_bridge_url": "https://host.example/chat"}}}
        out = shim._load_identities()
        self.assertEqual(out["sc"]["chat_bridge_url"], "https://host.example/chat")

    def test_a_malformed_chat_bridge_url_is_dropped_at_load_time(self):
        # `htp://` is the realistic typo. Left unvalidated it loads fine and
        # only fails inside urlopen on the first spoken turn — the same silent
        # shape as the bug this field exists to fix. Dropping the override
        # falls back to the working global rather than posting into a hole.
        for bad in ("htp://127.0.0.1:8091/chat", "127.0.0.1:8091/chat", "http://", "ftp://h/x"):
            with self.subTest(bad=bad):
                shim._CFG = {"identities": {"sc": {"chat_bridge_url": bad}}}
                out = shim._load_identities()
                self.assertNotIn("chat_bridge_url", out["sc"])


class TranscriptDirPerKey(unittest.TestCase):
    """Which cwd's project transcripts a key resolves to.

    A second identity's resumable-session listing must come from ITS cwd
    slug, not this instance's default one — otherwise `/v1/sessions/available`
    offers guild B someone else's conversations to resume into.
    """

    def setUp(self):
        self._previous = shim.IDENTITIES
        shim.IDENTITIES = {"111": {"cwd": "/tmp/guild-a"}}

    def tearDown(self):
        shim.IDENTITIES = self._previous

    def test_empty_key_keeps_the_instance_default_cwd(self):
        self.assertEqual(shim.transcript_dir(""), shim.transcript_dir())

    def test_a_configured_guild_key_resolves_under_its_own_cwd(self):
        expected_slug = str(shim.Path("/tmp/guild-a").resolve()).replace("/", "-")
        self.assertTrue(str(shim.transcript_dir("voice:111")).endswith(expected_slug))

    def test_an_unconfigured_voice_key_matches_the_default(self):
        self.assertEqual(shim.transcript_dir("voice:999"), shim.transcript_dir(""))


class AvailableSessions(unittest.TestCase):
    """What the `/sessions/available` listing offers — age window, label.

    Covers the two behaviors that distinguish the listing from a bare uuid
    dump: the two-day activity window that keeps cold sessions out of the
    switch list, and the `custom-title` (sessionName) label that beats the
    first user message whenever the operator set one.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._patch = mock.patch.object(shim, "transcript_dir",
                                        return_value=pathlib.Path(self._dir.name))
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        self._dir.cleanup()

    def _write_transcript(self, sid, age_minutes, records):
        """Write a transcript file with an mtime `age_minutes` in the past."""
        p = pathlib.Path(self._dir.name) / f"{sid}.jsonl"
        p.write_text("".join(json.dumps(r) + "\n" for r in records))
        old = time.time() - age_minutes * 60
        os.utime(p, (old, old))
        return p

    def test_a_session_older_than_the_window_is_excluded(self):
        self._write_transcript("old", 3 * 24 * 60, [
            {"type": "user", "message": {"content": "long ago"}},
        ])
        self._write_transcript("new", 60, [
            {"type": "user", "message": {"content": "just now"}},
        ])
        ids = [a["id"] for a in shim.available_sessions()]
        self.assertIn("new", ids)
        self.assertNotIn("old", ids)

    def test_custom_title_wins_over_the_first_user_message(self):
        self._write_transcript("named", 60, [
            {"type": "custom-title", "customTitle": "My Named Session",
             "sessionId": "named"},
            {"type": "user", "message": {"content": "some prompt that started it"}},
        ])
        [entry] = shim.available_sessions()
        self.assertEqual(entry["label"], "My Named Session")

    def test_first_user_message_is_the_fallback_without_a_custom_title(self):
        self._write_transcript("unnamed", 60, [
            {"type": "user", "message": {"content": "the opening question"}},
        ])
        [entry] = shim.available_sessions()
        self.assertEqual(entry["label"], "the opening question")


class GetSessionStartedFlag(unittest.TestCase):
    """`started` picks `--resume` vs `--session-id` — and a wrong value is
    permanent, not transient.

    The regression: `mark_started` runs only on a turn that SUCCEEDS, so a first
    turn that timed out recorded `started: False` beside a transcript that
    plainly existed. Every retry then re-issued `--session-id` for an id already
    on disk, claude exited instantly with "Session ID … is already in use", and
    the shim rebuilt the same broken command forever. Observed 2026-09-18 on a
    bro thread that stayed dead for the rest of the day while every other
    session on the same shim kept working.

    The transcript is the authority: if the file exists, the session was
    started, whatever the record says.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self._sessions = pathlib.Path(self._dir.name) / "shim-sessions.json"
        self._patch_dir = mock.patch.object(
            shim, "transcript_dir", return_value=pathlib.Path(self._dir.name))
        self._patch_file = mock.patch.object(shim, "SESSIONS_FILE", self._sessions)
        self._patch_dir.start()
        self._patch_file.start()

    def tearDown(self):
        self._patch_file.stop()
        self._patch_dir.stop()
        self._dir.cleanup()

    def _seed(self, key, sid, started):
        self._sessions.write_text(json.dumps({key: {
            "id": sid, "started": started, "created": time.time(), "turns": 0}}))

    def _write_transcript(self, sid):
        (pathlib.Path(self._dir.name) / f"{sid}.jsonl").write_text("{}\n")

    def test_a_transcript_makes_a_not_started_session_started(self):
        # THE REGRESSION. Fails against the pre-fix version, which returned the
        # recorded flag and let the retry collide indefinitely.
        self._seed("thread:1:bro", "eb7c92a5-7d2b-4c43-b982-2f41dfc3ffa4", False)
        self._write_transcript("eb7c92a5-7d2b-4c43-b982-2f41dfc3ffa4")

        _sid, started = shim.get_session("thread:1:bro")
        self.assertTrue(started)

    def test_no_transcript_leaves_a_not_started_session_not_started(self):
        # The other direction: a genuinely fresh session must still be opened
        # with --session-id, or the first turn would try to resume nothing.
        self._seed("thread:2:bro", "11111111-1111-1111-1111-111111111111", False)

        _sid, started = shim.get_session("thread:2:bro")
        self.assertFalse(started)

    def test_the_correction_is_persisted(self):
        # Not just this call: the flag is written back, so a later turn that
        # reads the file directly sees the corrected value too.
        self._seed("thread:3:bro", "22222222-2222-2222-2222-222222222222", False)
        self._write_transcript("22222222-2222-2222-2222-222222222222")
        shim.get_session("thread:3:bro")

        on_disk = json.loads(self._sessions.read_text())
        self.assertTrue(on_disk["thread:3:bro"]["started"])

    def test_a_started_session_keeps_its_id(self):
        self._seed("thread:4:bro", "33333333-3333-3333-3333-333333333333", True)

        sid, started = shim.get_session("thread:4:bro")
        self.assertEqual(sid, "33333333-3333-3333-3333-333333333333")
        self.assertTrue(started)

    def test_a_new_key_still_starts_unstarted(self):
        sid, started = shim.get_session("thread:5:bro")
        self.assertFalse(started)
        self.assertTrue(sid)


class ChatBridgePosting(unittest.TestCase):
    """Which URL a bridged answer actually posts to.

    THE BUG: CHAT_BRIDGE_URL used to be read as a single global, so every
    identity's answer posted to whichever bot owned that default — the
    identity that actually spoke never received its own text, and the bot
    with no live voice session dropped it silently. `post_chat_message` must
    resolve the target per key, the same way persona already does.
    """

    def setUp(self):
        self._previous_identities = shim.IDENTITIES
        self._previous_token = shim.CHAT_BRIDGE_TOKEN
        shim.IDENTITIES = {"sc": {"chat_bridge_url": "http://127.0.0.1:8091/chat"}}
        shim.CHAT_BRIDGE_TOKEN = "test-token"

    def tearDown(self):
        shim.IDENTITIES = self._previous_identities
        shim.CHAT_BRIDGE_TOKEN = self._previous_token

    def test_an_identity_with_a_chat_bridge_url_posts_there(self):
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.post_chat_message("hello", "voice:111:sc")
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(posted_request.full_url, "http://127.0.0.1:8091/chat")

    def test_an_identity_with_no_override_posts_to_the_global_default(self):
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.post_chat_message("hello", "voice:111:unconfigured")
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(posted_request.full_url, shim.CHAT_BRIDGE_URL)

    def test_no_identity_segment_posts_to_the_global_default(self):
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.post_chat_message("hello", "voice:999")
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(posted_request.full_url, shim.CHAT_BRIDGE_URL)

    def test_voice_only_posts_are_marked_in_the_payload(self):
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.post_chat_message("hello", "voice:999", voice_only=True)
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(
            json.loads(posted_request.data.decode()),
            {"text": "hello", "voiceOnly": True})

    def test_ordinary_posts_carry_no_voice_only_flag(self):
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.post_chat_message("hello", "voice:999", voice_only=False)
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(json.loads(posted_request.data.decode()), {"text": "hello"})


class VoiceOnlySwitch(unittest.TestCase):
    """The voice-only switch: silence chat posting per conversation.

    The design mirrors the solo flag — per-key, sticky, default off — because
    the setting describes THIS conversation, not the whole shim. The failure
    direction matters: an unknown key must default to posting ON (the switch
    is opt-in per conversation, and nothing may change for everyone else).
    """

    KEY = "voice:test"

    def setUp(self):
        self._previous = shim.is_chat_off(self.KEY)
        shim.set_chat_off(self.KEY, False)

    def tearDown(self):
        shim.set_chat_off(self.KEY, self._previous)

    def test_unknown_key_defaults_to_chat_posting_on(self):
        # The load-bearing direction: a key the switch never touched must behave
        # exactly as before the feature existed.
        self.assertFalse(shim.is_chat_off("voice:never-seen"))

    def test_set_chat_off_returns_the_previous_value(self):
        self.assertFalse(shim.set_chat_off(self.KEY, True))
        self.assertTrue(shim.set_chat_off(self.KEY, False))

    def test_per_key_state_is_isolated_between_keys(self):
        shim.set_chat_off("voice:111111", True)
        shim.set_chat_off("voice:222222", False)
        self.assertTrue(shim.is_chat_off("voice:111111"))
        self.assertFalse(shim.is_chat_off("voice:222222"))
        self.assertFalse(shim.is_chat_off("voice:999999"))

    def test_apply_chat_switch_recognises_the_off_instruction(self):
        shim._apply_chat_switch("please don't write in the chat anymore", self.KEY)
        self.assertTrue(shim.is_chat_off(self.KEY))

    def test_apply_chat_switch_recognises_the_verbatim_boss_phrasing(self):
        # The exact instruction that started this task, on a live call:
        # "can you stop posting text in the chat? It's enough if you speak to me"
        shim._apply_chat_switch("stop posting text in the chat", self.KEY)
        self.assertTrue(shim.is_chat_off(self.KEY))

    def test_apply_chat_switch_recognises_voice_only(self):
        shim._apply_chat_switch("from now on, voice only please", self.KEY)
        self.assertTrue(shim.is_chat_off(self.KEY))

    def test_apply_chat_switch_recognises_the_on_instruction(self):
        shim._apply_chat_switch("don't write in the chat", self.KEY)
        self.assertTrue(shim.is_chat_off(self.KEY))
        shim._apply_chat_switch("okay you can write in the chat again", self.KEY)
        self.assertFalse(shim.is_chat_off(self.KEY))

    def test_an_ordinary_write_request_does_not_toggle_the_switch(self):
        # "write it in the chat" is the third chat-bridge trigger (wants THIS
        # answer posted), not an instruction about future turns.
        shim._apply_chat_switch("can you write the summary in the chat", self.KEY)
        self.assertFalse(shim.is_chat_off(self.KEY))

    def test_an_unmatched_instruction_leaves_the_switch_where_it_was(self):
        shim.set_chat_off(self.KEY, True)
        shim._apply_chat_switch("what's the weather like", self.KEY)
        self.assertTrue(shim.is_chat_off(self.KEY))

    def test_context_note_is_restated_while_silenced(self):
        # THE 2026-09-03 FIX: a directive alone loses to in-context precedent —
        # the model kept saying "the details are in the chat" into a silenced
        # channel. The mode fact must sit in the prompt (the session history)
        # every silenced turn, so the model cannot drift back into claiming
        # chat copy exists.
        note = shim.chat_mode_context_note(chat_off=True, just_turned_on=False)
        self.assertIn("voice-only", note)
        self.assertIn("Nothing you write is posted", note)


class TextOnlySwitch(unittest.TestCase):
    """The text-only switch: silence SPOKEN output, keep chat posting.

    The mirror of the voice-only switch, with one structural difference that
    carries the whole design: the two flags are a PAIR, written together by
    `set_mode`. `(chat_off, speech_off) = (True, True)` is not a mode — the user
    gets nothing at all and nothing in Discord shows it — so these tests care as
    much about that state being unreachable as about text-only working.
    """

    KEY = "voice:test"

    def setUp(self):
        self._prev_chat = shim.is_chat_off(self.KEY)
        self._prev_speech = shim.is_speech_off(self.KEY)
        shim.set_mode(self.KEY, "voice-text")

    def tearDown(self):
        shim.set_chat_off(self.KEY, self._prev_chat)
        shim.set_speech_off(self.KEY, self._prev_speech)

    def test_unknown_key_defaults_to_speech_on(self):
        # The load-bearing direction: a key the switch never touched must behave
        # exactly as it did before the feature existed.
        self.assertFalse(shim.is_speech_off("voice:never-seen"))

    def test_set_speech_off_returns_the_previous_value(self):
        self.assertFalse(shim.set_speech_off(self.KEY, True))
        self.assertTrue(shim.set_speech_off(self.KEY, False))

    def test_per_key_state_is_isolated_between_keys(self):
        shim.set_mode("voice:111111", "text-only")
        shim.set_mode("voice:222222", "voice-text")
        self.assertTrue(shim.is_speech_off("voice:111111"))
        self.assertFalse(shim.is_speech_off("voice:222222"))
        self.assertFalse(shim.is_speech_off("voice:999999"))

    def test_set_mode_sets_the_pair_for_each_mode(self):
        shim.set_mode(self.KEY, "voice-only")
        self.assertTrue(shim.is_chat_off(self.KEY))
        self.assertFalse(shim.is_speech_off(self.KEY))

        shim.set_mode(self.KEY, "text-only")
        self.assertFalse(shim.is_chat_off(self.KEY))
        self.assertTrue(shim.is_speech_off(self.KEY))

        shim.set_mode(self.KEY, "voice-text")
        self.assertFalse(shim.is_chat_off(self.KEY))
        self.assertFalse(shim.is_speech_off(self.KEY))

    def test_no_mode_reaches_both_flags_off(self):
        # THE INVARIANT. Both off means the assistant is silent on every
        # surface — nothing spoken, nothing posted — with nothing in Discord to
        # show it. Every mode is walked, plus repeats and junk, so this covers
        # the WRITER rather than one call site.
        for mode in ("voice-only", "voice-text", "text-only",
                     "text-only", "voice-only", "nonsense", ""):
            shim.set_mode(self.KEY, mode)
            self.assertFalse(
                shim.is_chat_off(self.KEY) and shim.is_speech_off(self.KEY),
                f"mode {mode!r} reached (chat_off, speech_off) = (True, True)",
            )

    def test_spoken_chat_off_instruction_is_refused_in_text_only(self):
        # The spoken path knows about chat only, so in text-only it would set
        # chat_off on top of speech_off — the illegal pair, reached without
        # anyone choosing it.
        shim.set_mode(self.KEY, "text-only")
        shim._apply_chat_switch("please don't write in the chat anymore", self.KEY)
        self.assertFalse(shim.is_chat_off(self.KEY))
        self.assertTrue(shim.is_speech_off(self.KEY))

    def test_spoken_chat_on_instruction_clears_text_only(self):
        # "write in the chat again" implies speech is on, so it returns the
        # conversation to voice-text rather than leaving it in text-only.
        shim.set_mode(self.KEY, "text-only")
        shim._apply_chat_switch("okay you can write in the chat again", self.KEY)
        self.assertFalse(shim.is_chat_off(self.KEY))
        self.assertFalse(shim.is_speech_off(self.KEY))

    def test_on_text_refuses_the_wire_in_text_only(self):
        # THE INVARIANT, and the one the first cut of this feature missed.
        # `on_text` IS the wire — the `writer.chunk` inside it is the SSE delta
        # speech-to-speech synthesises. `push()` returns before reaching it for
        # the streamed answer, but `speak_holding_line` and
        # `speak_progress_line` call `on_text` DIRECTLY, so a guard on those two
        # callers leaves the leak open for the next filler anyone adds. The
        # guard has to sit in `on_text`, and ahead of the write.
        body = _function_source("on_text")
        self.assertIsNotNone(body, "on_text not found — did it move or get renamed?")
        self.assertIn("if speech_off:", body, "on_text must refuse to write in text-only")
        self.assertLess(
            body.index("if speech_off:"),
            body.index("writer.chunk("),
            "the guard must precede the wire write, not follow it",
        )

    def test_the_fillers_reach_the_wire_only_through_on_text(self):
        # What makes the single guard above sufficient. If a filler grows its
        # own `writer.chunk`, `on_text` no longer covers it and text-only speaks
        # again — silently, on exactly the slow turns the filler exists for.
        for name in ("speak_holding_line", "speak_progress_line"):
            body = _function_source(name)
            self.assertIsNotNone(body, f"{name} not found — did it move or get renamed?")
            self.assertIn("on_text(", body, f"{name} must route through on_text")
            self.assertNotIn(
                "writer.chunk(", body, f"{name} must not write to the wire directly"
            )

    def test_modes_is_the_validated_set(self):
        # do_POST rejects anything outside MODES, so this tuple is the contract
        # the route and the bot both key off.
        self.assertEqual(set(shim.MODES), {"voice-only", "voice-text", "text-only"})

    def test_context_note_announces_the_return_on_the_flip_turn(self):
        # The opposite direction: when posting is turned back on, the model
        # must know before it answers that "the details are in the chat" is
        # true again — otherwise it keeps behaving as if silenced.
        note = shim.chat_mode_context_note(chat_off=False, just_turned_on=True)
        self.assertIn("back ON", note)
        self.assertIn("IS posted", note)

    def test_context_note_is_empty_in_steady_voice_text(self):
        # The default state needs no note: the model's baseline belief already
        # matches it, and the plain CHAT_BRIDGE_DIRECTIVE is in the system
        # prompt. Adding one would just bloat every ordinary prompt.
        self.assertEqual(shim.chat_mode_context_note(False, False), "")

    def test_context_note_restated_even_after_flipping_off_this_turn(self):
        # The instruction's OWN turn is already silenced (the switch flips
        # before the post decision), so it must carry the note too — the very
        # turn where the model might say "okay, I won't write in the chat".
        note = shim.chat_mode_context_note(chat_off=True, just_turned_on=False)
        self.assertTrue(note.endswith("\n\n"), "note is ready to prepend to the prompt")


class MoreLine(unittest.TestCase):
    """The truncation notice, chosen by whether chat posting is silenced.

    The regression: in voice-only mode the SPOKEN_MAX cut still ended with
    "The details are in the chat." — sending the listener to a channel that
    was deliberately silenced. The branch is a module-level helper (`push()` is
    a closure inside `ask()` and would need a live Claude subprocess).
    """

    def test_chat_mode_keeps_the_original_wording(self):
        # The load-bearing direction: with posting on, nothing may change for
        # the listener — the exact string everyone already recognises.
        self.assertEqual(shim._more_line(False), "The details are in the chat.")

    def test_voice_only_mode_points_at_the_transcript(self):
        # Voice-only never posts to the channel, so the written copy is the
        # transcript — the line must say so, not send the listener to a
        # channel where nothing was written.
        self.assertEqual(shim._more_line(True), "The details are in the transcript.")

    def test_the_two_lines_are_not_identical(self):
        # A no-op branch (both lines equal) would silently keep the bug alive
        # while every test above still passes.
        self.assertNotEqual(shim._more_line(True), shim._more_line(False))

    def test_voice_only_line_still_names_a_place_the_detail_went(self):
        # Dropping the line entirely made the cut sound like a fault (the
        # comment at the emission site); the fix must keep pointing somewhere
        # truthful. "transcript" is that place in voice-only mode.
        self.assertIn("transcript", shim._more_line(True).lower())
        self.assertNotIn("chat", shim._more_line(True).lower())


class BargeInSwitch(unittest.TestCase):
    """The barge-in switch: let a turn survive the listener speaking mid-turn.

    Mirrors the voice-only switch — per-key, sticky, default off — because the
    setting describes THIS conversation, not the whole shim. The failure
    direction matters: an unknown key must default to cancellation ON (the
    switch is opt-in per conversation, and nothing may change for everyone
    else).
    """

    KEY = "voice:test"

    def setUp(self):
        self._previous = shim.is_barge_in_off(self.KEY)
        shim.set_barge_in_off(self.KEY, False)

    def tearDown(self):
        shim.set_barge_in_off(self.KEY, self._previous)

    def test_unknown_key_defaults_to_cancellation_on(self):
        # The load-bearing direction: a key the switch never touched must behave
        # exactly as before the feature existed — barge-in cancels the answer.
        self.assertFalse(shim.is_barge_in_off("voice:never-seen"))

    def test_set_barge_in_off_returns_the_previous_value(self):
        self.assertFalse(shim.set_barge_in_off(self.KEY, True))
        self.assertTrue(shim.set_barge_in_off(self.KEY, False))

    def test_per_key_state_is_isolated_between_keys(self):
        shim.set_barge_in_off("voice:111111", True)
        shim.set_barge_in_off("voice:222222", False)
        self.assertTrue(shim.is_barge_in_off("voice:111111"))
        self.assertFalse(shim.is_barge_in_off("voice:222222"))
        self.assertFalse(shim.is_barge_in_off("voice:999999"))

    def test_the_gate_reads_the_flag_off_a_key(self):
        # The shim's turn loop asks `is_barge_in_off(key)` at the exact moment
        # the listener disappears. Turning the flag back on must restore the
        # old behaviour for that key without affecting any other.
        shim.set_barge_in_off(self.KEY, True)
        self.assertTrue(shim.is_barge_in_off(self.KEY))
        shim.set_barge_in_off(self.KEY, False)
        self.assertFalse(shim.is_barge_in_off(self.KEY))


class TranscribeSwitch(unittest.TestCase):
    """The transcription switch: stop the bot writing THIS conversation down.

    Mirrors the other per-key switches — per-key, sticky, default off — because
    the setting describes THIS conversation, not the whole shim. Unlike the
    barge-in and voice-only flags the shim never CONSUMES this one (the bot is
    the writer), but the store still lives here so the posture is queryable
    without a live call and both sides agree on one source. The failure
    direction matters: an unknown key must default to transcription ON (nothing
    changes for anyone who never toggles it).
    """

    KEY = "voice:test"

    def setUp(self):
        self._previous = shim.is_transcribe_off(self.KEY)
        shim.set_transcribe_off(self.KEY, False)

    def tearDown(self):
        shim.set_transcribe_off(self.KEY, self._previous)

    def test_unknown_key_defaults_to_transcription_on(self):
        # The load-bearing direction: a key the switch never touched must behave
        # exactly as before the feature existed — the call is written down.
        self.assertFalse(shim.is_transcribe_off("voice:never-seen"))

    def test_set_transcribe_off_returns_the_previous_value(self):
        self.assertFalse(shim.set_transcribe_off(self.KEY, True))
        self.assertTrue(shim.set_transcribe_off(self.KEY, False))

    def test_per_key_state_is_isolated_between_keys(self):
        shim.set_transcribe_off("voice:111111", True)
        shim.set_transcribe_off("voice:222222", False)
        self.assertTrue(shim.is_transcribe_off("voice:111111"))
        self.assertFalse(shim.is_transcribe_off("voice:222222"))
        self.assertFalse(shim.is_transcribe_off("voice:999999"))

    def test_the_gate_reads_the_flag_off_a_key(self):
        # The /transcribe route reads `is_transcribe_off(key)` for both the
        # query form and the set. Flipping off then on must round-trip for that
        # key without affecting any other.
        shim.set_transcribe_off(self.KEY, True)
        self.assertTrue(shim.is_transcribe_off(self.KEY))
        shim.set_transcribe_off(self.KEY, False)
        self.assertFalse(shim.is_transcribe_off(self.KEY))

    def test_set_transcribe_off_none_clears_the_override(self):
        # `/transcribe default`: None pops the per-key entry so the configured
        # default (transcription ON) is in force again — not a stored False.
        shim.set_transcribe_off(self.KEY, True)
        previous = shim.set_transcribe_off(self.KEY, None)
        self.assertTrue(previous, "clear returns the value it replaced")
        self.assertFalse(shim.is_transcribe_off(self.KEY))


class FlagClearSetters(unittest.TestCase):
    """The setter-level clear contract behind the uniform default paths.

    Each per-key flag store pops on None (mirroring `set_wake_override`), so
    the route's `default`/`clear` values fall back to the configured
    default rather than storing an explicit False — the distinction that makes
    `default` a real restore and not a synonym for `off`.
    """

    KEY = "voice:test"

    def setUp(self):
        self._prev = (
            shim.is_chat_off(self.KEY),
            shim.is_barge_in_off(self.KEY),
            shim.is_transcribe_off(self.KEY),
        )
        shim.set_chat_off(self.KEY, False)
        shim.set_barge_in_off(self.KEY, False)
        shim.set_transcribe_off(self.KEY, False)

    def tearDown(self):
        shim.set_chat_off(self.KEY, self._prev[0])
        shim.set_barge_in_off(self.KEY, self._prev[1])
        shim.set_transcribe_off(self.KEY, self._prev[2])

    def test_chat_off_none_clears_the_override(self):
        shim.set_chat_off(self.KEY, True)
        previous = shim.set_chat_off(self.KEY, None)
        self.assertTrue(previous)
        self.assertFalse(shim.is_chat_off(self.KEY))

    def test_barge_in_off_none_clears_the_override(self):
        shim.set_barge_in_off(self.KEY, True)
        previous = shim.set_barge_in_off(self.KEY, None)
        self.assertTrue(previous)
        self.assertFalse(shim.is_barge_in_off(self.KEY))

    def test_clear_mode_restores_voice_text(self):
        shim.set_mode(self.KEY, "text-only")
        prev_chat, prev_speech = shim.clear_mode(self.KEY)
        self.assertFalse(prev_chat, "text-only leaves chat posting on")
        self.assertTrue(prev_speech, "text-only sets speech off")
        self.assertFalse(shim.is_chat_off(self.KEY))
        self.assertFalse(shim.is_speech_off(self.KEY))

    def test_clear_mode_on_an_untouched_key_is_a_noop(self):
        prev_chat, prev_speech = shim.clear_mode("voice:never-seen")
        self.assertFalse(prev_chat)
        self.assertFalse(prev_speech)
        self.assertFalse(shim.is_chat_off("voice:never-seen"))
        self.assertFalse(shim.is_speech_off("voice:never-seen"))


class VoiceYieldHandover(unittest.TestCase):
    """LAST JOINER WINS: who gets asked to leave voice when the bind changes.

    Three Discord identities share one speech-to-speech slot machine-wide.
    Without this, the loser of a join race stays connected in Discord —
    subscribed to audio, transcribing — while its spoken turns never reach
    the model again. `maybe_yield_voice` is what makes the handover explicit
    instead of a silent, permanently wedged loser.
    """

    def setUp(self):
        self._previous_identities = shim.IDENTITIES
        self._previous_token = shim.CHAT_BRIDGE_TOKEN
        self._previous_bind_count = shim._VOICE_BIND_COUNT
        shim.IDENTITIES = {
            "personal": {"chat_bridge_url": "http://127.0.0.1:8081/chat"},
            "sc": {"chat_bridge_url": "http://127.0.0.1:8091/chat"},
        }
        shim.CHAT_BRIDGE_TOKEN = "test-token"
        shim._VOICE_BIND_COUNT = 0

    def tearDown(self):
        shim.IDENTITIES = self._previous_identities
        shim.CHAT_BRIDGE_TOKEN = self._previous_token
        shim._VOICE_BIND_COUNT = self._previous_bind_count

    def test_first_bind_ever_has_no_previous_holder_and_is_a_no_op(self):
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            shim.maybe_yield_voice(shim.DEFAULT_KEY, "voice:111:personal")
        urlopen.assert_not_called()

    def test_bind_from_a_new_identity_asks_the_previous_holder_to_yield(self):
        # A first bind (personal) establishes a previous holder, then sc binds
        # over it — sc's arrival must ask personal to leave.
        shim.maybe_yield_voice(shim.DEFAULT_KEY, "voice:111:personal")
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.maybe_yield_voice("voice:111:personal", "voice:111:sc")
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(posted_request.full_url, "http://127.0.0.1:8081/voice/yield")
        self.assertEqual(
            json.loads(posted_request.data.decode())["newIdentity"], "sc")

    def test_bind_from_the_same_identity_does_not_ask_it_to_yield(self):
        shim.maybe_yield_voice(shim.DEFAULT_KEY, "voice:111:sc")
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            shim.maybe_yield_voice("voice:111:sc", "voice:222:sc")
        urlopen.assert_not_called()

    def test_an_unreachable_previous_holder_logs_and_still_allows_the_new_bind(self):
        shim.maybe_yield_voice(shim.DEFAULT_KEY, "voice:111:personal")
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.side_effect = OSError("connection refused")
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                # Must not raise — a crashed bot must never wedge voice for
                # the identity taking over.
                shim.maybe_yield_voice("voice:111:personal", "voice:111:sc")
        self.assertIn("notify failed", captured.getvalue())


class VoiceRebind(unittest.TestCase):
    """Shim-startup notify: ask every bot to re-announce its live bind.

    A shim restart drops the in-memory `/voice/bind` pointer, so the first
    spoken turn of a call that was live when it went down classifies against
    `default` and the wake gate rejects it. The shim knows it restarted; only
    the bot knows which calls are live — so `notify_voice_rebind()` asks over
    the same chat-bridge back-edge as the yield handover.
    """

    def setUp(self):
        self._previous_identities = shim.IDENTITIES
        self._previous_token = shim.CHAT_BRIDGE_TOKEN
        self._previous_url = shim.CHAT_BRIDGE_URL

    def tearDown(self):
        shim.IDENTITIES = self._previous_identities
        shim.CHAT_BRIDGE_TOKEN = self._previous_token
        shim.CHAT_BRIDGE_URL = self._previous_url

    def test_no_token_skips_the_notify(self):
        shim.CHAT_BRIDGE_TOKEN = ""
        shim.IDENTITIES = {}
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                shim.notify_voice_rebind()
        urlopen.assert_not_called()
        self.assertIn("CHAT_BRIDGE_TOKEN not set", captured.getvalue())

    def test_no_identities_posts_to_the_global_chat_bridge_url(self):
        shim.CHAT_BRIDGE_TOKEN = "test-token"
        shim.IDENTITIES = {}
        shim.CHAT_BRIDGE_URL = "http://127.0.0.1:8081/chat"
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.notify_voice_rebind()
        posted_request = urlopen.call_args[0][0]
        self.assertEqual(posted_request.full_url, "http://127.0.0.1:8081/voice/rebind")

    def test_identities_post_to_each_explicit_url_plus_the_global_fallback(self):
        shim.CHAT_BRIDGE_TOKEN = "test-token"
        shim.CHAT_BRIDGE_URL = "http://127.0.0.1:8081/chat"
        shim.IDENTITIES = {
            "personal": {"chat_bridge_url": "http://127.0.0.1:8081/chat"},
            "sc": {"chat_bridge_url": "http://127.0.0.1:8091/chat"},
        }
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.read.return_value = b""
            shim.notify_voice_rebind()
        urls = sorted(call[0][0].full_url for call in urlopen.call_args_list)
        self.assertEqual(
            urls,
            [
                "http://127.0.0.1:8081/voice/rebind",
                "http://127.0.0.1:8091/voice/rebind",
            ],
        )

    def test_an_unreachable_bot_logs_and_does_not_block_startup(self):
        shim.CHAT_BRIDGE_TOKEN = "test-token"
        shim.IDENTITIES = {}
        shim.CHAT_BRIDGE_URL = "http://127.0.0.1:8081/chat"
        with mock.patch.object(shim.urllib.request, "urlopen") as urlopen:
            urlopen.side_effect = OSError("connection refused")
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured):
                # Must not raise — a down bot must never block shim startup.
                shim.notify_voice_rebind()
        self.assertIn("notify failed", captured.getvalue())


if __name__ == "__main__":
    unittest.main()


class SoloGate(unittest.TestCase):
    """Whether the wake phrase is armed at all.

    Alone there is no room to interrupt, so the trade the gate was priced on
    ("a false trigger interrupts a room") has nothing on its cost side. This
    changes only WHEN the gate is armed — `is_addressed` is untouched.
    """

    KEY = "voice:test"

    def setUp(self):
        self._previous = shim.is_solo(self.KEY)

    def tearDown(self):
        shim.set_solo(self.KEY, self._previous)

    def test_default_is_armed_so_an_endpoint_never_told_behaves_as_before(self):
        # The load-bearing direction. A shim that predates the route, a bot that
        # fails to post, and a backend that 404s all land here — and all of them
        # must keep demanding the wake phrase rather than answering everything.
        shim.set_solo(self.KEY, False)
        self.assertFalse(shim.is_solo(self.KEY))

    def test_set_solo_returns_the_previous_value(self):
        shim.set_solo(self.KEY, False)
        self.assertFalse(shim.set_solo(self.KEY, True))
        self.assertTrue(shim.set_solo(self.KEY, False))

    def test_solo_does_not_change_what_counts_as_addressed(self):
        # The gate is skipped when solo; the matcher itself must not drift, or
        # the two modes disagree about the same sentence.
        shim.set_solo(self.KEY, True)
        self.assertTrue(shim.is_addressed("hey bot, what's my next task"))
        self.assertFalse(shim.is_addressed("so anyway, as I was saying"))

    def test_a_wake_phrase_is_still_stripped_when_solo(self):
        # Saying it out of habit must not change the question the model is asked.
        shim.set_solo(self.KEY, True)
        self.assertEqual(
            shim.strip_wake_phrase("hey bot, what's my next task").lower().strip(" ,"),
            "what's my next task",
        )

    def test_an_utterance_with_no_phrase_is_unchanged_by_stripping(self):
        # Solo turns go through strip_wake_phrase too, so it has to be a no-op
        # on the ordinary case rather than eating the first words.
        shim.set_solo(self.KEY, True)
        self.assertEqual(shim.strip_wake_phrase("what's my next task"), "what's my next task")

    def test_always_wake_defaults_off(self):
        # VOICE_ALWAYS_WAKE mirrors the bot's voiceAlwaysWake; with nothing set
        # the gate must behave exactly as before (solo can still disarm it).
        self.assertFalse(shim.ALWAYS_WAKE)

    def test_always_wake_overrides_solo_at_the_gate(self):
        # The gate expression the request handler uses: a stale per-key solo
        # state cannot disarm the gate on an instance that opted out. This pins
        # the combination the handler evaluates — the full request path is
        # verified live in a real call, per the repo's voice-verification rule.
        shim.set_solo(self.KEY, True)
        self.assertTrue(shim.is_solo(self.KEY))
        prev = shim.ALWAYS_WAKE
        shim.ALWAYS_WAKE = True
        try:
            self.assertFalse(shim.is_solo(self.KEY) and not shim.ALWAYS_WAKE)
        finally:
            shim.ALWAYS_WAKE = prev

    def test_wake_override_absent_defers_to_the_env_default(self):
        # The third state. No override means the key follows ALWAYS_WAKE, which
        # is what makes `/wakephrase default` a real restore rather than a synonym for
        # `off`.
        self.assertIsNone(shim.wake_override(self.KEY))
        prev = shim.ALWAYS_WAKE
        try:
            shim.ALWAYS_WAKE = True
            self.assertTrue(shim.effective_always_wake(self.KEY))
            shim.ALWAYS_WAKE = False
            self.assertFalse(shim.effective_always_wake(self.KEY))
        finally:
            shim.ALWAYS_WAKE = prev

    def test_wake_override_beats_the_env_default_both_ways(self):
        # The point of the runtime toggle: an admin can force the phrase on an
        # instance whose default is off, and relax it on one whose default is on.
        prev = shim.ALWAYS_WAKE
        try:
            shim.ALWAYS_WAKE = False
            shim.set_wake_override(self.KEY, True)
            self.assertTrue(shim.effective_always_wake(self.KEY))
            shim.ALWAYS_WAKE = True
            shim.set_wake_override(self.KEY, False)
            self.assertFalse(shim.effective_always_wake(self.KEY))
        finally:
            shim.set_wake_override(self.KEY, None)
            shim.ALWAYS_WAKE = prev

    def test_clearing_the_override_restores_the_default(self):
        # `/wakephrase default`. Without the clear, the configured default is unreachable
        # for the life of the process once the command is used at all.
        prev = shim.ALWAYS_WAKE
        try:
            shim.ALWAYS_WAKE = True
            shim.set_wake_override(self.KEY, False)
            self.assertFalse(shim.effective_always_wake(self.KEY))
            previous = shim.set_wake_override(self.KEY, None)
            self.assertFalse(previous, "clear returns the value it replaced")
            self.assertIsNone(shim.wake_override(self.KEY))
            self.assertTrue(shim.effective_always_wake(self.KEY))
        finally:
            shim.set_wake_override(self.KEY, None)
            shim.ALWAYS_WAKE = prev

    def test_wake_override_is_per_key(self):
        # Same reason the solo state is per-key: an override set in a private
        # call must not follow the bot into the next call on another channel.
        other = "voice:G9"
        prev = shim.ALWAYS_WAKE
        try:
            shim.ALWAYS_WAKE = True
            shim.set_wake_override(self.KEY, False)
            self.assertFalse(shim.effective_always_wake(self.KEY))
            self.assertTrue(
                shim.effective_always_wake(other),
                "an untouched key keeps the default",
            )
        finally:
            shim.set_wake_override(self.KEY, None)
            shim.set_wake_override(other, None)
            shim.ALWAYS_WAKE = prev

    def test_relaxing_the_override_cannot_answer_a_shared_room(self):
        # The precedence rule: the override replaces only the always-wake term.
        # Head-count still has to say solo, so `/wakephrase off` in a room with other
        # people leaves the gate armed rather than answering everything said.
        shim.set_solo(self.KEY, False)
        prev = shim.ALWAYS_WAKE
        try:
            shim.ALWAYS_WAKE = True
            shim.set_wake_override(self.KEY, False)
            self.assertFalse(shim.is_solo(self.KEY) and not shim.effective_always_wake(self.KEY))
        finally:
            shim.set_wake_override(self.KEY, None)
            shim.ALWAYS_WAKE = prev

    def test_a_stale_override_is_what_join_must_clear(self):
        # The drift this pins: a voice key outlives the call it was used in, so
        # an override set in a previous call is still here when the next call
        # binds the same key. The bot's fresh Session starts at null and posts
        # solo=True; without the clear the shim answers that with a still-armed
        # gate, and the user sees typing dots and no reply.
        prev = shim.ALWAYS_WAKE
        try:
            shim.ALWAYS_WAKE = False
            shim.set_wake_override(self.KEY, True)  # previous call did `/wakephrase on`
            shim.set_solo(self.KEY, True)  # new call: bot says the room is solo
            self.assertFalse(
                shim.is_solo(self.KEY) and not shim.effective_always_wake(self.KEY),
                "stale override keeps the gate armed while the bot thinks it is not",
            )
            # What join now does before the first syncSolo.
            shim.set_wake_override(self.KEY, None)
            self.assertTrue(
                shim.is_solo(self.KEY) and not shim.effective_always_wake(self.KEY),
                "clearing the override puts both sides back in agreement",
            )
        finally:
            shim.set_wake_override(self.KEY, None)
            shim.ALWAYS_WAKE = prev

    def test_unknown_key_defaults_to_gate_armed(self):
        # THE 2026-08-18 FIX. Before per-key state, a fresh key inherited whatever
        # the previous call had set — a private session's True bled into the
        # Brogrammers join and answered unaddressed speech. An unknown key must
        # evaluate to False (gate armed) so a bot that never posted, or one
        # whose POST was missed, cannot accidentally answer.
        shim.set_solo("voice:other-key", True)
        self.assertFalse(shim.is_solo("voice:never-seen"))

    def test_per_key_state_is_isolated_between_keys(self):
        # The whole point: solo on one voice key must not appear on another.
        # Two identities sharing one guild (the v0.16.0–v0.17.0 design) means
        # two keys against one shim — exactly the shape this guards.
        shim.set_solo("voice:111111", True)
        shim.set_solo("voice:222222", False)
        self.assertTrue(shim.is_solo("voice:111111"))
        self.assertFalse(shim.is_solo("voice:222222"))
        # Disjoint from anything else the test suite might have touched.
        self.assertFalse(shim.is_solo("voice:999999"))

    def test_set_solo_arms_a_fresh_key_to_false_implicitly(self):
        # The setter writes through for known keys; an unknown key's prior value
        # is whatever the default was (False), and set_solo returns that. Pin
        # both halves of the contract here so the reader sees them in one place.
        previous = shim.set_solo("voice:brand-new", True)
        self.assertFalse(previous, 'unknown key defaults to False, returned as previous')
        self.assertTrue(shim.is_solo("voice:brand-new"))
        previous = shim.set_solo("voice:brand-new", False)
        self.assertTrue(previous, 'known key returns its current value as previous')
        self.assertFalse(shim.is_solo("voice:brand-new"))


class LooksFactual(unittest.TestCase):
    """The backstop that forces a consult regardless of what the front tier chose.

    This is the layer that fails toward SLOW. Where it does not match, the only
    thing standing between the user and an invented fact is the front model
    deciding to refuse — and it has now been observed not to, twice, on two
    different models and two different vocabularies.
    """

    def test_the_2026_08_14_infrastructure_fabrication(self):
        # Verbatim from the live transcript. Matched nothing: no interrogative
        # in the first alternation, no `my`/`our`, and neither "benchmark" nor
        # "router" was a known noun. The front tier answered it itself with
        # "No — not yet because the necessary router components are missing",
        # an invention about the user's own setup, spoken aloud.
        self.assertTrue(shim.looks_factual(
            "Can you now give me a complete answer? Can we run the benchmark "
            "against the router?"))

    def test_the_2026_08_04_plural_fabrication(self):
        # The original incident: \btask\b cannot match "tasks", so this reached
        # the front tier and came back with an invented task name, count and
        # due date. Pinned here so the plurals cannot regress.
        self.assertTrue(shim.looks_factual("can you list all active tasks?"))

    def test_infrastructure_nouns_force_a_consult(self):
        # A growing share of spoken questions are about the setup rather than
        # the work. Each of these must reach Claude even if phrased with no
        # interrogative and no possessive.
        for text in (
            "is the router still on the old config",
            "run the benchmark again",
            "which model are we using",
            "the shim seems slow",
            "check the endpoint",
            "how much does the subscription cost",
            "what version shipped",
        ):
            with self.subTest(text=text):
                self.assertTrue(shim.looks_factual(text))

    def test_travel_and_skills_force_a_consult(self):
        # Verbatim from the 2026-08-28 bus-ride transcript. Plain statements
        # with no interrogative, no `my`/`our` and no previously-known noun —
        # the front tier answered each with a spoken "I can't" and the request
        # never reached Claude. Travel and skills are the user's real world;
        # the front model can't know a timetable or write a runbook.
        for text in (
            "I want to take the bus from Taunustein Neuhof to Wiesbaden now.",
            "Maybe use the semantic search and look for bus travel guidelines "
            "that we already have documented in Obsidian.",
            "im in the bus . write the skill now",
            "update runbook with howto find connections from neuoh mittle",
            "find the next train from Neuhof Mitte",
            "what time does the bus to Wiesbaden leave",
        ):
            with self.subTest(text=text):
                self.assertTrue(shim.looks_factual(text))

    def test_small_talk_is_not_dragged_into_a_consult(self):
        # looks_factual returns early for anything the chitchat whitelist
        # matched, so widening the noun list must not cost a greeting its
        # sub-second answer. This is the property that makes broadening safe.
        for text in ("hello", "thanks a lot", "good evening", "how are you",
                     "can you hear me", "bye"):
            with self.subTest(text=text):
                self.assertFalse(shim.looks_factual(text))


class HedgeConsult(unittest.TestCase):
    """A prose "I can't" from the front model is a consult, not an answer.

    The refusal contract says the front model returns {"cannot_answer": true}
    when it can't answer, but it often emits a capability-style prose refusal
    instead. Where _HEDGE fails to recognise it, the denial is spoken verbatim
    and the request never reaches Claude. Each of these is a verbatim front
    reply from the 2026-08-28 bus-ride transcript (or a close variant), and
    each must now be treated as the deferral it is.
    """

    def test_the_2026_08_28_capability_refusals_are_consults(self):
        for reply in (
            "I do not have the capability to ask Lord Gurk.",
            "I cannot write or update a runbook or create a skill or slash command.",
            "I cannot provide real-time transportation schedules or route information.",
            "I cannot create a skill or a slash command.",
            "I do not have the capability to ask Claude Code.",
            "I don't have the ability to do that.",
            "I am not able to look that up.",
        ):
            with self.subTest(reply=reply):
                self.assertTrue(shim._HEDGE.search(reply))

    def test_cannot_is_recognized_not_just_cant(self):
        # \bcan'?t\b matches "can't" only; "cannot" needs its own branch. This
        # was the literal gap — every transcript refusal said "cannot" or
        # "do not have the capability", and none matched.
        self.assertTrue(shim._HEDGE.search("I cannot check the current time."))

    def test_a_real_answer_is_not_a_hedge(self):
        # The other direction: a genuine front-tier answer must never be
        # reclassified as a consult. The bus-line tables the front model is
        # NOT allowed to give are exactly the shape that must not match.
        for reply in (
            "The next bus to Wiesbaden leaves Neuhof Mitte at 15:01.",
            "I'm doing great, thanks.",
            "The details are in the chat.",
            "Your open task is the Armin Meyer one-to-one prep.",
        ):
            with self.subTest(reply=reply):
                self.assertFalse(shim._HEDGE.search(reply))


class ControlRouteAuth(unittest.TestCase):
    """The shared check on every shim route that mutates state.

    Before 2026-09-10 only three admin routes (/voice/wake, /chat/posting,
    /voice/barge) authenticated with CHAT_BRIDGE_TOKEN; the other mutating
    routes — sessions/reset, sessions/bind, voice/bind, voice/solo,
    turns/typed, chat/completions — accepted any local caller. One check
    (`control_authorized`) now guards every route in do_POST, and the DoD for
    the task requires all four cases pinned: valid token, wrong token, absent
    token, and the empty-token refusal.
    """

    def setUp(self):
        self._previous_token = shim.CHAT_BRIDGE_TOKEN
        shim.CHAT_BRIDGE_TOKEN = "test-token"

    def tearDown(self):
        shim.CHAT_BRIDGE_TOKEN = self._previous_token

    def test_valid_token_is_authorized(self):
        self.assertTrue(shim.control_authorized("Bearer test-token"))

    def test_wrong_token_is_refused(self):
        self.assertFalse(shim.control_authorized("Bearer not-the-token"))

    def test_absent_token_is_refused(self):
        self.assertFalse(shim.control_authorized(""))

    def test_empty_configured_token_refuses_everything(self):
        # Fail-closed is the point: a shim that lost its secret must refuse
        # every mutating route, not admit anyone. Even a "correct" bearer is
        # refused when the configured token is empty.
        shim.CHAT_BRIDGE_TOKEN = ""
        self.assertFalse(shim.control_authorized("Bearer test-token"))

    def test_handler_wires_the_check_to_the_authorization_header(self):
        # The handler method reads the raw Authorization header into the same
        # check — the wiring is what makes the guard reach every route.
        handler = shim.Handler.__new__(shim.Handler)
        handler.headers = {"Authorization": "Bearer test-token"}
        self.assertTrue(handler._control_authorized())
        handler.headers = {"Authorization": "Bearer nope"}
        self.assertFalse(handler._control_authorized())
        handler.headers = {}
        self.assertFalse(handler._control_authorized())

    def test_do_POST_refuses_without_a_token(self):
        # The guard runs before any route logic, so a refused request must
        # return 401 without touching any route — even with no body and no
        # session store. Also pins the refusal LOG LINE (the task's SC3
        # evidence): a missing token must be diagnosable from shim.log, not
        # indistinguishable from a broken route.
        handler = shim.Handler.__new__(shim.Handler)
        handler.path = "/v1/sessions/reset"
        handler.headers = {}
        handler.rfile = io.BytesIO(b"")
        handler.wfile = io.BytesIO()
        handler.requestline = "POST /v1/sessions/reset HTTP/1.1"
        handler.request_version = "HTTP/1.1"
        handler.command = "POST"
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            handler.do_POST()
        self.assertEqual(handler.wfile.getvalue().split(b" ")[1], b"401")
        self.assertIn("missing or wrong token — refused", captured.getvalue())

    def test_do_POST_refusal_logs_the_unset_token_reason(self):
        # SC3: an unset token refuses with a DISTINGUISHABLE log line — a
        # config gap (nothing on the shim side can fix it) reads differently
        # from a caller sending a wrong/missing header.
        shim.CHAT_BRIDGE_TOKEN = ""
        handler = shim.Handler.__new__(shim.Handler)
        handler.path = "/v1/sessions/reset"
        handler.headers = {}
        handler.rfile = io.BytesIO(b"")
        handler.wfile = io.BytesIO()
        handler.requestline = "POST /v1/sessions/reset HTTP/1.1"
        handler.request_version = "HTTP/1.1"
        handler.command = "POST"
        captured = io.StringIO()
        with contextlib.redirect_stdout(captured):
            handler.do_POST()
        self.assertEqual(handler.wfile.getvalue().split(b" ")[1], b"401")
        self.assertIn("CHAT_BRIDGE_TOKEN not set — refusing every mutating route", captured.getvalue())


class VoiceStateRoute(unittest.TestCase):
    """GET /voice/state — the /status back-edge for the runtime toggles.

    GET is deliberately unauthenticated (it only observes; the control-plane
    guard gates do_POST). The route reads the same four per-key stores the
    POST routes write, so a flip through /interrupt, /mode, /wakephrase or
    /transcribe shows up here on the next /status.
    """

    KEY = "voice:test"

    def setUp(self):
        self._prev = (
            shim.wake_override(self.KEY),
            shim.is_chat_off(self.KEY),
            shim.is_barge_in_off(self.KEY),
            shim.is_transcribe_off(self.KEY),
        )
        shim.set_wake_override(self.KEY, None)
        shim.set_chat_off(self.KEY, False)
        shim.set_barge_in_off(self.KEY, False)
        shim.set_transcribe_off(self.KEY, False)

    def tearDown(self):
        shim.set_wake_override(self.KEY, self._prev[0])
        shim.set_chat_off(self.KEY, self._prev[1])
        shim.set_barge_in_off(self.KEY, self._prev[2])
        shim.set_transcribe_off(self.KEY, self._prev[3])

    def _get_state(self, headers):
        handler = shim.Handler.__new__(shim.Handler)
        handler.path = "/v1/voice/state"
        handler.headers = headers
        handler.wfile = io.BytesIO()
        handler.requestline = "GET /v1/voice/state HTTP/1.1"
        handler.request_version = "HTTP/1.1"
        handler.command = "GET"
        handler.do_GET()
        return json.loads(handler.wfile.getvalue().split(b"\r\n\r\n")[-1])

    def test_defaults_report_every_flag_positive(self):
        state = self._get_state({"X-Session-Key": self.KEY})
        self.assertEqual(state["key"], self.KEY)
        self.assertEqual(state["wake"], shim.ALWAYS_WAKE)
        self.assertIsNone(state["wake_override"])
        self.assertTrue(state["posting"])
        self.assertTrue(state["interrupt"])
        self.assertTrue(state["transcribe"])

    def test_flips_show_up_in_the_same_shape_the_routes_write(self):
        shim.set_wake_override(self.KEY, False)
        shim.set_chat_off(self.KEY, True)
        shim.set_barge_in_off(self.KEY, True)
        shim.set_transcribe_off(self.KEY, True)
        state = self._get_state({"X-Session-Key": self.KEY})
        self.assertFalse(state["wake"])
        self.assertFalse(state["posting"])
        self.assertFalse(state["interrupt"])
        self.assertFalse(state["transcribe"])

    def test_an_unknown_key_returns_the_shim_defaults(self):
        # An idle /status has no live call key; the shim answers an unknown key
        # with its defaults, which is exactly what the next call starts with.
        state = self._get_state({})
        self.assertEqual(state["key"], shim.DEFAULT_KEY)
        self.assertEqual(state["wake"], shim.ALWAYS_WAKE)
        self.assertTrue(state["posting"])
        self.assertTrue(state["interrupt"])
        self.assertTrue(state["transcribe"])


class FlagClearPaths(unittest.TestCase):
    """The uniform clear path on every per-key flag route.

    The flag standardization task gives all four per-conversation toggles
    (`/wakephrase`, `/interrupt`, `/transcribe`, `/mode`) one on/off/default
    contract. `/voice/wake` already had the clear path; these tests pin the
    same `default`/`clear` → pop-the-override behaviour on the other
    routes, and prove the cleared state shows up on the /voice/state back-edge
    (the SC2 verification hook).
    """

    KEY = "voice:test"

    def setUp(self):
        self._prev_token = shim.CHAT_BRIDGE_TOKEN
        shim.CHAT_BRIDGE_TOKEN = "test-token"
        self._prev = (
            shim.is_chat_off(self.KEY),
            shim.is_barge_in_off(self.KEY),
            shim.is_transcribe_off(self.KEY),
        )
        shim.set_chat_off(self.KEY, False)
        shim.set_barge_in_off(self.KEY, False)
        shim.set_transcribe_off(self.KEY, False)
        shim.clear_mode(self.KEY)

    def tearDown(self):
        shim.set_chat_off(self.KEY, self._prev[0])
        shim.set_barge_in_off(self.KEY, self._prev[1])
        shim.set_transcribe_off(self.KEY, self._prev[2])
        shim.CHAT_BRIDGE_TOKEN = self._prev_token

    def _post(self, path, headers):
        handler = shim.Handler.__new__(shim.Handler)
        handler.path = path
        handler.headers = dict(headers, Authorization="Bearer test-token")
        handler.rfile = io.BytesIO(b"")
        handler.wfile = io.BytesIO()
        handler.requestline = f"POST {path} HTTP/1.1"
        handler.request_version = "HTTP/1.1"
        handler.command = "POST"
        handler.do_POST()
        body = handler.wfile.getvalue().split(b"\r\n\r\n")[-1]
        return json.loads(body)

    def _state(self):
        handler = shim.Handler.__new__(shim.Handler)
        handler.path = "/v1/voice/state"
        handler.headers = {"X-Session-Key": self.KEY}
        handler.wfile = io.BytesIO()
        handler.requestline = "GET /v1/voice/state HTTP/1.1"
        handler.request_version = "HTTP/1.1"
        handler.command = "GET"
        handler.do_GET()
        return json.loads(handler.wfile.getvalue().split(b"\r\n\r\n")[-1])

    def test_barge_default_clears_the_override_and_reports_cancel_on(self):
        shim.set_barge_in_off(self.KEY, True)
        body = self._post("/v1/voice/barge", {"X-Session-Key": self.KEY, "X-Barge-In": "default"})
        self.assertTrue(body["cancel"])
        self.assertTrue(body["cleared"])
        self.assertFalse(shim.is_barge_in_off(self.KEY))
        self.assertTrue(self._state()["interrupt"])

    def test_barge_clear_is_a_synonym_and_auto_is_rejected(self):
        # `clear` is accepted alongside `default`; the legacy `/wakephrase auto`
        # spelling was REMOVED by the follow-up — `auto` must reject, not clear.
        shim.set_barge_in_off(self.KEY, True)
        body = self._post("/v1/voice/barge",
                          {"X-Session-Key": self.KEY, "X-Barge-In": "clear"})
        self.assertTrue(body["cleared"])
        self.assertFalse(shim.is_barge_in_off(self.KEY))
        shim.set_barge_in_off(self.KEY, True)
        body = self._post("/v1/voice/barge",
                          {"X-Session-Key": self.KEY, "X-Barge-In": "auto"})
        self.assertEqual(body["error"]["message"], "bad X-Barge-In: 'auto' (want on|off|default)")
        self.assertTrue(shim.is_barge_in_off(self.KEY), "rejected value must not mutate")

    def test_transcribe_default_clears_the_override_and_reports_on(self):
        shim.set_transcribe_off(self.KEY, True)
        body = self._post("/v1/voice/transcribe",
                          {"X-Session-Key": self.KEY, "X-Transcribe": "default"})
        self.assertTrue(body["transcribe"])
        self.assertTrue(body["cleared"])
        self.assertFalse(shim.is_transcribe_off(self.KEY))
        self.assertTrue(self._state()["transcribe"])

    def test_chat_posting_default_clears_the_override_and_reports_posting(self):
        shim.set_chat_off(self.KEY, True)
        body = self._post("/v1/chat/posting",
                          {"X-Session-Key": self.KEY, "X-Chat-Posting": "default"})
        self.assertTrue(body["posting"])
        self.assertTrue(body["cleared"])
        self.assertFalse(shim.is_chat_off(self.KEY))
        self.assertTrue(self._state()["posting"])

    def test_mode_default_clears_both_flags_and_reports_voice_text(self):
        shim.set_mode(self.KEY, "text-only")
        body = self._post("/v1/mode", {"X-Session-Key": self.KEY, "X-Mode": "default"})
        self.assertEqual(body["mode"], "voice-text")
        self.assertTrue(body["cleared"])
        state = self._state()
        self.assertTrue(state["posting"])
        self.assertTrue(state["speech"])

    def test_mode_clear_is_a_synonym_and_auto_is_rejected(self):
        shim.set_mode(self.KEY, "voice-only")
        body = self._post("/v1/mode", {"X-Session-Key": self.KEY, "X-Mode": "clear"})
        self.assertTrue(body["cleared"])
        self.assertTrue(self._state()["posting"])
        body = self._post("/v1/mode", {"X-Session-Key": self.KEY, "X-Mode": "auto"})
        self.assertIn("unknown mode", body["error"]["message"])
        self.assertTrue(self._state()["posting"], "rejected value must not mutate")

    def test_bare_barge_post_is_still_the_query_form(self):
        # SC3: the query form survives the clear path — a headerless POST
        # reports the posture without changing it.
        shim.set_barge_in_off(self.KEY, True)
        body = self._post("/v1/voice/barge", {"X-Session-Key": self.KEY})
        self.assertFalse(body["cancel"])
        self.assertTrue(shim.is_barge_in_off(self.KEY), "query form must not mutate")

    def test_bare_transcribe_post_is_still_the_query_form(self):
        shim.set_transcribe_off(self.KEY, True)
        body = self._post("/v1/voice/transcribe", {"X-Session-Key": self.KEY})
        self.assertFalse(body["transcribe"])
        self.assertTrue(shim.is_transcribe_off(self.KEY), "query form must not mutate")

    def test_bad_values_still_reject_with_the_new_contract_in_the_message(self):
        body = self._post("/v1/voice/barge",
                          {"X-Session-Key": self.KEY, "X-Barge-In": "sometimes"})
        self.assertEqual(body["error"]["message"], "bad X-Barge-In: 'sometimes' (want on|off|default)")
        body = self._post("/v1/voice/transcribe",
                          {"X-Session-Key": self.KEY, "X-Transcribe": "maybe"})
        self.assertEqual(body["error"]["message"],
                         "bad X-Transcribe: 'maybe' (want on|off|default)")


class UtcIsoStamp(unittest.TestCase):
    """The shim's turn line carries a wall-clock stamp the bot's logs can join on.

    The regression is a silent one. The turn duration was always measured, but
    on `time.monotonic()`, which shares no origin with the ISO timestamps the
    bot writes — so a slow voice turn could not be placed on the turn it
    belonged to. If the stamp's shape drifts (a `+00:00` suffix instead of `Z`,
    a dropped millisecond field), the join stops matching and every downstream
    attribution goes quiet rather than wrong, which is the worse failure.
    """

    def test_stamp_matches_the_shape_the_bot_writes(self):
        # THE CONTRACT. The bot emits `"ts":"2026-09-16T19:28:55.057Z"`; the
        # join is a string comparison against exactly this shape.
        self.assertRegex(shim._utc_iso(),
                         r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

    def test_ask_claude_actually_emits_the_stamp(self):
        # Pins the WIRING, not just the helper: a stamp that is computed and
        # never printed correlates nothing.
        src = _function_source("ask_claude")
        self.assertIn("began_iso = _utc_iso()", src)
        self.assertIn("{began_iso} {time.monotonic() - began:.1f}s", src)


class HoldMaxBeatsTheBotsStallClip(unittest.TestCase):
    """The shim's no-tool filler must reach the wire before the bot's own clip.

    Two timers in two processes, both defaulting to 8.0s until 2026-09-17. On a
    turn where the agent took >8s to emit its first tool_use they fired together
    and the BOT's clip won the tie, telling the user the assistant was "still
    getting the audio ready" while the agent was in fact working. Nothing in
    either file expressed the relationship, so nothing caught the collision —
    which is what this test exists to prevent recurring.
    """

class NonVoiceTurnDetection(unittest.TestCase):
    """A cross-session message injected mid-call must never be spoken.

    Observed 2026-09-13 14:27Z: the assistant spoke a peer's nuke-status reply
    into a live call in place of the user's open-tasks question, which then
    arrived late. The shim drives one long-lived `claude` process per session
    key and reads ONE stream from it, so the injected turn's events interleave
    with the spoken turn's and the shim speaks them as the answer.

    The origin marker exists only on the USER entry in the transcript:
    `{kind: "peer"}` for a cross-session message, `{kind: "task-notification"}`
    for an internal notice, and ABSENT for a turn the human spoke. The stream
    carries nothing. These pin that reading, because getting it backwards
    either mutes the call or speaks a stranger's conversation into it.
    """

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.path = pathlib.Path(self._dir.name) / "session.jsonl"

    def _write(self, *entries, newline=True):
        with self.path.open("a") as fh:
            for e in entries:
                fh.write(json.dumps(e) + ("\n" if newline else ""))

    def _user(self, origin=None, text="hello"):
        e = {"type": "user", "message": {"role": "user", "content": text}}
        if origin is not None:
            e["origin"] = origin
        return e

    def test_a_peer_turn_is_detected(self):
        self._write(self._user({"kind": "peer", "from": "uds:/tmp/cc-socks/1.sock",
                                "name": "Rebuild Nuke Cluster"}))
        found, _ = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertTrue(found, "an injected peer turn must be detected")

    def test_a_spoken_turn_is_not_detected(self):
        self._write(self._user())
        found, _ = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertFalse(found, "a spoken turn carries no origin and must pass")

    def test_a_task_notification_is_detected(self):
        # Not a peer, but equally not something the human said — an internal
        # notice spoken into a call is the same defect with a different source.
        self._write(self._user({"kind": "task-notification"}))
        found, _ = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertTrue(found)

    def test_an_unknown_origin_kind_is_treated_as_non_voice(self):
        # The safe direction: a future kind we do not know is more likely to be
        # machinery than a human, and muting beats speaking traffic the
        # listener cannot see.
        self._write(self._user({"kind": "something-new"}))
        found, _ = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertTrue(found)

    def test_assistant_entries_do_not_trip_the_gate(self):
        # The assistant's OWN entries carry no origin. If they tripped the gate
        # every turn would mute itself.
        self._write({"type": "assistant", "message": {"role": "assistant",
                                                      "content": [{"type": "text", "text": "hi"}]}})
        found, _ = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertFalse(found)

    def test_a_partial_trailing_line_is_left_for_the_next_call(self):
        # The writer appends while we read, so the last line is routinely
        # incomplete. Judging it would either crash or mis-read it — so it is
        # skipped, unconsumed, and picked up once complete.
        line = json.dumps(self._user({"kind": "peer"}))
        with self.path.open("a") as fh:
            fh.write(line[:len(line) // 2])      # half a line, no newline
        found, offset = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertFalse(found, "an incomplete line must not be judged")
        self.assertEqual(offset, 0, "and must not be consumed")
        # The writer finishes the line; the same offset now sees it.
        with self.path.open("a") as fh:
            fh.write(line[len(line) // 2:] + "\n")
        found, _ = shim._transcript_has_non_voice_turn(self.path, offset)
        self.assertTrue(found, "the completed line must be picked up")

    def test_offset_advances_so_lines_are_not_reparsed(self):
        self._write(self._user(), {"type": "assistant"})
        found, offset = shim._transcript_has_non_voice_turn(self.path, 0)
        self.assertFalse(found)
        self.assertGreater(offset, 0)
        # Re-reading from the reported offset sees nothing new.
        found, again = shim._transcript_has_non_voice_turn(self.path, offset)
        self.assertFalse(found)
        self.assertEqual(again, offset)

    def test_a_missing_transcript_is_not_an_error(self):
        # Before the first turn there is no file; the watcher starts anyway.
        found, offset = shim._transcript_has_non_voice_turn(
            pathlib.Path(self._dir.name) / "nope.jsonl", 0)
        self.assertFalse(found)
        self.assertEqual(offset, 0)


class PeerTurnGatePrecedesSpeech(unittest.TestCase):
    """`push()` is the ONE route from model text to the speaker.

    So the gate belongs there and nowhere else — gating at the stream reader
    would leave the holdish and cap paths unguarded, and gating in the request
    handler would miss the streamed text entirely. This asserts the guard is
    present and comes before the first thing that can reach the wire.
    """

    def test_push_gates_on_a_non_voice_turn(self):
        src = _function_source("push")
        self.assertIsNotNone(src, "push() not found — did it move?")
        self.assertIn("peer_seen.is_set()", src,
                      "push() must drop text once a non-voice turn is seen")
        gate = src.index("peer_seen.is_set()")
        lead_in = src.index("lead_in = part.rstrip()")
        self.assertLess(gate, lead_in,
                        "the gate must precede the lead-in path, which also "
                        "reaches on_text")

    def test_the_first_utterance_rechecks_synchronously(self):
        # The watcher polls, so a fast peer reply could emit inside its window.
        # The first utterance must re-read rather than trust the flag.
        src = _function_source("push")
        self.assertIn("peer_check_now()", src)

    def test_the_watcher_is_bounded_by_the_turn_deadline(self):
        # Without a deadline every turn leaks a thread stat-ing a transcript.
        src = _function_source("ask")
        self.assertIsNotNone(src)
        self.assertIn("deadline = time.time() + TIMEOUT", src,
                      "the peer watcher must not outlive its turn")


class HoldMaxBeatsTheBotsStallClip(unittest.TestCase):
    """The shim's no-tool filler must reach the wire before the bot's own clip.

    Two timers in two processes, both defaulting to 8.0s until 2026-09-17. On a
    turn where the agent took >8s to emit its first tool_use they fired together
    and the BOT's clip won the tie, telling the user the assistant was "still
    getting the audio ready" while the agent was in fact working. Nothing in
    either file expressed the relationship, so nothing caught the collision —
    which is what this test exists to prevent recurring.
    """

    def test_hold_max_lands_before_the_bots_stall_threshold(self):
        config_js = (pathlib.Path(shim.__file__).resolve().parent.parent
                     / "src" / "config.js").read_text()
        m = re.search(r"VOICE_STALL_THRESHOLD_MS\s*\|\|\s*'(\d+)'", config_js)
        self.assertIsNotNone(
            m, "bot stall-threshold default not found — did src/config.js move?")
        bot_seconds = int(m.group(1)) / 1000.0
        self.assertLess(
            shim.HOLD_MAX, bot_seconds,
            f"shim HOLD_MAX ({shim.HOLD_MAX}s) must fire before the bot's stall "
            f"clip ({bot_seconds}s), or the bot's misleading clip wins the tie")
