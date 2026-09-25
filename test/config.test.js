'use strict';

const test = require('node:test');
const assert = require('node:assert');

test('allowlist fails closed when unset', () => {
  delete process.env.ALLOWED_USER_IDS;
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.equal(config.isAllowed('123'), false, 'nobody is allowed by default');
  assert.ok(config.check().some((p) => /ALLOWED_USER_IDS/.test(p)));
});

test('allowlist accepts only listed senders', () => {
  process.env.ALLOWED_USER_IDS = ' 111, 222 ';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.ok(config.isAllowed('111'));
  assert.ok(config.isAllowed('222'));
  assert.equal(config.isAllowed('333'), false);
});

// Voice defaults ON: an existing deployment upgrading onto this must behave
// identically with nothing set. Failing the other way would silently take
// voice away from the laptop instance on a routine release.
test('voice is enabled when VOICE_ENABLED is unset', () => {
  delete process.env.VOICE_ENABLED;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceEnabled, true);
});

test('voice can be disabled by any of the usual falsey spellings', () => {
  for (const raw of ['0', 'false', 'no', 'off', 'FALSE', '"0"']) {
    process.env.VOICE_ENABLED = raw;
    delete require.cache[require.resolve('../src/config')];
    assert.equal(require('../src/config').voiceEnabled, false, `VOICE_ENABLED=${raw}`);
  }
  delete process.env.VOICE_ENABLED;
});

// VOICE_ALWAYS_WAKE defaults OFF: existing instances must behave identically
// with nothing set (solo calls keep answering unprompted).
test('voiceAlwaysWake defaults off when unset', () => {
  delete process.env.VOICE_ALWAYS_WAKE;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceAlwaysWake, false);
});

test('voiceAlwaysWake accepts the usual truthy spellings', () => {
  for (const raw of ['1', 'true', 'yes', 'on', 'TRUE', '"1"']) {
    process.env.VOICE_ALWAYS_WAKE = raw;
    delete require.cache[require.resolve('../src/config')];
    assert.equal(require('../src/config').voiceAlwaysWake, true, `VOICE_ALWAYS_WAKE=${raw}`);
  }
  delete process.env.VOICE_ALWAYS_WAKE;
});

// Unset must reproduce v0.16.0 exactly — an existing single-identity
// deployment upgrading onto this must see no behaviour change at all.
test('identity is empty when IDENTITY is unset', () => {
  delete process.env.IDENTITY;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').identity, '');
});

test('identity is read verbatim from IDENTITY, trimmed', () => {
  process.env.IDENTITY = '  sc  ';
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').identity, 'sc');
  delete process.env.IDENTITY;
});

// The transcript label must reproduce today's format when IDENTITY is unset —
// a single-identity install upgrading onto this sees no change at all.
test('assistantLabel falls back to the bot name when IDENTITY is unset', () => {
  delete process.env.IDENTITY;
  delete process.env.BOT_NAME;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').assistantLabel, 'Assistant');
});

test('assistantLabel is the identity when set, even if BOT_NAME differs', () => {
  process.env.IDENTITY = 'sc';
  process.env.BOT_NAME = 'Assistant';
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').assistantLabel, 'sc');
  delete process.env.IDENTITY;
  delete process.env.BOT_NAME;
});

// The admin tier is a SUBSET of the allowlist, and both fail closed. The two
// directions matter independently: an empty ADMIN_USER_IDS must not mean
// "everyone is an admin" (the failure that hands session control to a guest),
// and being allowed must not imply being an admin (the failure that makes the
// second tier decorative).
test('unset ADMIN_USER_IDS inherits the allowlist', () => {
  delete process.env.ADMIN_USER_IDS;
  process.env.ALLOWED_USER_IDS = '111,222';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.ok(config.isAdmin('111'), 'an upgrading deployment keeps its slash commands');
  assert.ok(config.isAdmin('222'));
  assert.equal(config.isAdmin('999'), false, 'still bounded by the allowlist');
});

test('empty ADMIN_USER_IDS means no admins', () => {
  process.env.ALLOWED_USER_IDS = '111,222';
  process.env.ADMIN_USER_IDS = '';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.equal(config.isAdmin('111'), false, 'explicitly empty is not "inherit"');
  assert.ok(config.isAllowed('111'), 'the mention surface is untouched');
});

test('admin tier is independent of the allowlist', () => {
  process.env.ALLOWED_USER_IDS = ' 111, 222 ';
  process.env.ADMIN_USER_IDS = ' 111 ';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.ok(config.isAllowed('111') && config.isAdmin('111'), 'admin is also allowed');
  assert.ok(config.isAllowed('222'), '222 keeps the mention surface');
  assert.equal(config.isAdmin('222'), false, 'allowed must not imply admin');
});

// Empty = every guild, because that is the behaviour every existing install
// has today; a release that started withholding commands from an unconfigured
// deployment would look exactly like the bot breaking.
test('slash commands register everywhere when no guild list is set', () => {
  delete process.env.SLASH_COMMAND_GUILD_IDS;
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.ok(config.registersSlashCommands('any-guild'));
});

test('slash commands register only in listed guilds', () => {
  process.env.SLASH_COMMAND_GUILD_IDS = ' 555, 666 ';
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.ok(config.registersSlashCommands('555'));
  assert.equal(config.registersSlashCommands('777'), false, 'unlisted guild gets no commands');
});

test('slash command mode defaults to multi, the legacy surface', () => {
  delete process.env.SLASH_COMMAND_MODE;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').slashCommandMode, 'multi');
});

test('slash command mode accepts single, case- and space-insensitively', () => {
  process.env.SLASH_COMMAND_MODE = ' Single ';
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').slashCommandMode, 'single');
  delete process.env.SLASH_COMMAND_MODE;
});

// A typo must not silently register the shape the operator did not ask for.
test('an unknown slash command mode fails startup', () => {
  process.env.SLASH_COMMAND_MODE = 'singel';
  delete require.cache[require.resolve('../src/config')];
  assert.throws(() => require('../src/config'), /SLASH_COMMAND_MODE/);
  delete process.env.SLASH_COMMAND_MODE;
  delete require.cache[require.resolve('../src/config')];
});

// The release timeout is named for an EMPTY ROOM, not for silence: the trigger
// is `humansIn(channel) === 0`. The old name said "idle" and misled exactly that
// way during the 2026-09-25 live run — the operator sat in the channel expecting
// a silent release that could never fire while they were still present.
test('the release timeout reads the empty-room name', () => {
  delete process.env.VOICE_IDLE_RELEASE_MS;
  process.env.VOICE_EMPTY_ROOM_RELEASE_MS = '12345';
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceEmptyRoomReleaseMs, 12345);
  delete process.env.VOICE_EMPTY_ROOM_RELEASE_MS;
});

// Kept so an existing local.env that still sets the old name does not silently
// fall back to the 1h default — a config that quietly stops applying is worse
// than a rename.
test('the old idle name is still honoured as a fallback', () => {
  delete process.env.VOICE_EMPTY_ROOM_RELEASE_MS;
  process.env.VOICE_IDLE_RELEASE_MS = '6789';
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceEmptyRoomReleaseMs, 6789);
  delete process.env.VOICE_IDLE_RELEASE_MS;
});

test('the new empty-room name wins when both are set', () => {
  process.env.VOICE_EMPTY_ROOM_RELEASE_MS = '111';
  process.env.VOICE_IDLE_RELEASE_MS = '222';
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceEmptyRoomReleaseMs, 111);
  delete process.env.VOICE_EMPTY_ROOM_RELEASE_MS;
  delete process.env.VOICE_IDLE_RELEASE_MS;
});

test('the release timeout defaults to one hour with neither name set', () => {
  delete process.env.VOICE_EMPTY_ROOM_RELEASE_MS;
  delete process.env.VOICE_IDLE_RELEASE_MS;
  delete require.cache[require.resolve('../src/config')];
  assert.equal(require('../src/config').voiceEmptyRoomReleaseMs, 3600000);
});
