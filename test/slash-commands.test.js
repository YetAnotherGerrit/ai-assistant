'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildCommands } = require('../src/slash-commands');

// "Which commands exist" is exactly the kind of decision that regresses in
// silence: nothing throws, nothing logs, the guild's list is simply wrong and
// nobody notices until someone types a command that should not have been
// offered. Both directions are asserted, because the default mattering is the
// whole reason the flag defaults to true.

// Everything is a subcommand of the single /ben command, so "which commands
// exist" means "which subcommands /ben carries".
const subcommands = (opts) => buildCommands(opts)[0].options;
const names = (opts) => subcommands(opts).map((c) => c.name);

// Every command that exists only because this instance can hear. Kept as one
// list so adding a voice command means updating this in exactly one place —
// `wakephrase` was added here after it shipped as the third member and the old
// hard-coded `join`/`leave` filter turned it into a text-surface regression.
const VOICE_ONLY = ['join', 'leave', 'cancel', 'wakephrase', 'interrupt', 'transcribe'];

test('voice enabled advertises the voice commands', () => {
  const n = names({ voiceEnabled: true });
  for (const c of VOICE_ONLY) {
    assert.ok(n.includes(c), `${c} should be registered`);
  }
});

test('voice disabled advertises none of the voice commands', () => {
  const n = names({ voiceEnabled: false });
  for (const c of VOICE_ONLY) {
    assert.equal(n.includes(c), false, `${c} must not be advertised without voice`);
  }
});

test('disabling voice removes only the voice commands', () => {
  const enabled = names({ voiceEnabled: true });
  const disabled = names({ voiceEnabled: false });
  assert.deepEqual(
    enabled.filter((n) => !VOICE_ONLY.includes(n)),
    disabled,
    'the text surface must be identical in both modes',
  );
  // Named explicitly so removing one of these from the array is a test failure
  // rather than a silently smaller command list — the failure mode that left
  // `new` and `sessions` unreachable for weeks.
  for (const n of ['status', 'new', 'sessions', 'switch', 'mode']) {
    assert.ok(disabled.includes(n), `${n} must survive with voice disabled`);
  }
});

test('/interrupt advertises the on/off/default choices', () => {
  // The uniform contract: `on` (default) cancels the in-flight answer when the
  // listener speaks mid-turn, `off` lets it finish, `default` clears the
  // per-key override. A choice silently dropping from the list is exactly the
  // class of regression the other tests here exist to catch.
  const interrupt = subcommands({ voiceEnabled: true }).find((c) => c.name === 'interrupt');
  assert.ok(interrupt, '/interrupt must be registered');
  const choices = interrupt.options[0].choices.map((c) => c.value);
  assert.deepEqual(choices.sort(), ['default', 'off', 'on']);
});

test('/transcribe advertises the on/off/default choices', () => {
  // The uniform contract: `on` (default) writes every speaker down, `off`
  // stops writing this call, `default` clears the per-key override. A choice
  // silently dropping from the list is exactly the class of regression the
  // other tests here exist to catch.
  const transcribe = subcommands({ voiceEnabled: true }).find((c) => c.name === 'transcribe');
  assert.ok(transcribe, '/transcribe must be registered');
  assert.equal(transcribe.options[0].required, false, 'bare invocation is the query form');
  const choices = transcribe.options[0].choices.map((c) => c.value);
  assert.deepEqual(choices.sort(), ['default', 'off', 'on']);
});

test('/cancel takes no options — it is a momentary action, not a state toggle', () => {
  // /wakephrase, /interrupt and /transcribe are all per-key STATE toggles whose
  // bare invocation is the query form. /cancel is not: it stops the reply being
  // spoken right now and holds no state to query, so it is shaped like
  // /join and /leave instead. An option appearing here would mean someone
  // rebuilt it as a toggle, which is the regression this pins down.
  const cancel = subcommands({ voiceEnabled: true }).find((c) => c.name === 'cancel');
  assert.ok(cancel, '/cancel must be registered');
  assert.equal(cancel.options.length, 0, '/cancel must take no options');
});

test('/wakephrase advertises the on/off/default choices', () => {
  // The uniform contract replaces the old `auto` picker choice with `default`.
  // `auto` was removed entirely by the follow-up (handler + shim reject it) —
  // `default` is the one clear spelling.
  const wakephrase = subcommands({ voiceEnabled: true }).find((c) => c.name === 'wakephrase');
  assert.ok(wakephrase, '/wakephrase must be registered');
  assert.equal(wakephrase.options[0].required, false, 'bare invocation is the query form');
  const choices = wakephrase.options[0].choices.map((c) => c.value);
  assert.deepEqual(choices.sort(), ['default', 'off', 'on']);
});

test('/mode advertises exactly the three named modes', () => {
  // The names the user can type ARE the contract: `voice-only` silences chat
  // posting, `voice-text` does both, `text-only` silences speech. The three
  // named states are the WHOLE value space — no on|off|default aliases (the
  // default is reachable by naming `voice-text`). A choice that silently
  // drops from the list — or an alias that creeps back in — is exactly the
  // class of regression the other tests here exist to catch.
  const mode = subcommands({ voiceEnabled: true }).find((c) => c.name === 'mode');
  assert.ok(mode, '/mode must be registered');
  assert.equal(mode.options[0].required, false, 'bare invocation is the query form');
  const choices = mode.options[0].choices.map((c) => c.value);
  assert.deepEqual(choices.sort(), ['text-only', 'voice-only', 'voice-text']);
});

// One top-level command, not a dozen: generic names like /new and /status
// collide with every other bot on the server.
test('registers exactly one top-level command, /ben', () => {
  const { COMMAND_NAME } = require('../src/slash-commands');
  assert.equal(COMMAND_NAME, 'ben');
  for (const voiceEnabled of [true, false]) {
    const commands = buildCommands({ voiceEnabled });
    assert.equal(commands.length, 1, `exactly one command (voiceEnabled=${voiceEnabled})`);
    assert.equal(commands[0].name, 'ben');
  }
});

test('every /ben option is a subcommand', () => {
  const { ApplicationCommandOptionType } = require('discord.js');
  for (const c of subcommands({ voiceEnabled: true })) {
    assert.equal(c.type, ApplicationCommandOptionType.Subcommand, `${c.name} must be a subcommand`);
  }
});

// Visible to every member of the guild. The authorisation is config.isAllowed
// and config.isAdmin in index.js, not Discord's picker — a permission gate
// creeping back in would silently hide /ben from the people meant to see it.
test('/ben carries no default member permission gate', () => {
  for (const voiceEnabled of [true, false]) {
    const [ben] = buildCommands({ voiceEnabled });
    assert.equal(ben.default_member_permissions ?? null, null);
  }
});
