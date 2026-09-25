#!/usr/bin/env node
'use strict';

const { Client, GatewayIntentBits, Partials, REST, Routes, MessageFlags } = require('discord.js');
const config = require('./config');
const voice = require('./voice');
const text = require('./text');
const { sessionKeyFor, setMode, setInterrupt, setTranscribe, getVoiceState } = require('./llm');
const {
  buildCommands,
  commandFor,
  VOICE_DISABLED_REPLY,
  COMMAND_NAME,
} = require('./slash-commands');
const log = require('./log');
const { startHealthServer, isReady } = require('./health');
const gchat = require('./gchat');

const problems = config.check();
if (problems.length) {
  for (const p of problems) log.error('bad config', { problem: p });
  process.exit(2);
}

// Readiness = the gateway is actually connected AND the bot holds a guild.
// Liveness deliberately does NOT check either: a Discord outage should drain
// traffic, not restart pods. The guild-count clause is the hardening for the
// silent-skip failure (see the isReady doc block in health.js): a bot that
// reached ready with an empty guild cache registers nothing and must not
// report healthy.
let gatewayReady = false;
let draining = false;
let gchatReady = false;
let getGuildCount = () => 0;

const health = startHealthServer({
  host: config.healthHost,
  port: config.healthPort,
  build: config.build,
  isReady: () =>
    isReady({
      gatewayReady,
      guildCount: getGuildCount(),
      gchatEnabled: config.gchatEnabled,
      gchatReady,
      draining,
    }),
});

// Optional Google Chat transport. Started alongside the Discord client when
// GCHAT_ENABLED=1; it shares the same session engine and identity, and a
// Discord-only instance never touches it.
let gchatHandle = null;
if (config.gchatEnabled) {
  try {
    gchatHandle = gchat.startGchat();
    gchatReady = true;
    log.info('gchat transport started', {
      subscription: config.gchatSubscription,
      identity: config.identity,
    });
  } catch (e) {
    log.error('gchat transport failed to start', { error: e.message });
  }
}

const commands = buildCommands({
  voiceEnabled: config.voiceEnabled,
  mode: config.slashCommandMode,
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel], // required to receive DMs
});
// Readiness reads the live cache size, not a snapshot: after a shard resume the
// cache repopulates as guilds arrive, and a bot that was kicked everywhere must
// not stay green on a stale count.
getGuildCount = () => client.guilds.cache.size;

client.once('clientReady', async () => {
  gatewayReady = true;
  log.info('ready', {
    bot: client.user.tag,
    endpoint: config.baseUrl,
    model: config.model,
    voice: config.voiceEnabled ? 'enabled' : 'disabled',
    // Named as the reason rather than the value when off: `s2s: null` reads as
    // a missing setting, which is the wrong thing to go looking for.
    s2s: config.voiceEnabled ? config.s2sUrl : 'not used (VOICE_ENABLED=false)',
    allowed: config.allowedUserIds.length,
    admins: config.adminUserIds.length,
    version: config.build.version,
    chatBridge: Boolean(config.chatBridgeToken),
  });

  // The empty-cache case is the exact failure that hid a week of stale slash
  // commands: with a gateway intent rejected, discord.js delivers no guild
  // objects and the registration loop below silently iterates nothing. Make it
  // loud instead of invisible.
  if (client.guilds.cache.size === 0) {
    log.warn('ready with zero guilds — no commands registered');
  }

  // A previous process may have died while in a voice channel, leaving the bot
  // visible there with nothing driving it. Clear that before anything else.
  for (const guild of client.guilds.cache.values()) {
    const ghost = await voice.evictGhost(guild).catch(() => null);
    if (ghost) log.warn('evicted leftover voice connection', { guild: guild.name, channel: ghost });
  }

  // If that process died mid-call, put the bot back in it. Deliberately after
  // the eviction above: that is what removes the dead process's ghost, so the
  // rejoin replaces it rather than racing it. A voice-disabled instance has no
  // call to restore, and restoreCall never throws, so boot cannot fail here.
  if (config.voiceEnabled) {
    await voice.restoreCall(client).catch(() => null);
  }

  // Guild-scoped registration applies immediately; global takes ~an hour.
  const rest = new REST().setToken(config.discordToken);
  for (const guild of client.guilds.cache.values()) {
    // A guild left out of SLASH_COMMAND_GUILD_IDS is PUT an empty list, not
    // skipped: Discord keeps a guild's previous command list until it is
    // overwritten, so skipping would leave yesterday's commands advertised
    // forever. Writing [] is what actually retracts them.
    const wanted = config.registersSlashCommands(guild.id) ? commands : [];
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: wanted });
      log.info(wanted.length ? 'commands registered' : 'commands withheld', {
        guild: guild.name,
        count: wanted.length,
      });
    } catch (e) {
      log.error('command registration failed', { guild: guild.name, error: e.message });
    }
  }
});

// Gateway drops mean "stop sending me traffic", not "restart me".
client.on('shardDisconnect', () => {
  gatewayReady = false;
});
client.on('shardResume', () => {
  gatewayReady = true;
});
client.on('shardReady', () => {
  gatewayReady = true;
});

// Arrivals and departures go into the transcript, and display names are
// refreshed as people arrive — they are otherwise resolved only at join time.
client.on('voiceStateUpdate', (oldState, newState) => {
  try {
    voice.noteVoiceState(oldState, newState);
  } catch (e) {
    log.warn('voice state note failed', { error: e.message });
  }
});

client.on('interactionCreate', async (i) => {
  // Logged before any filtering: when a slash command hangs on "Sending
  // command…", the only question that matters is whether it reached this
  // process at all. Silence here means Discord never delivered it, and no
  // amount of reading the handler will show that.
  log.info('interaction received', {
    type: i.type,
    command: i.commandName ?? null,
    user: i.user?.tag ?? null,
  });
  if (!i.isChatInputCommand()) return;

  // A command in the other mode's shape is a stale entry from the guild's
  // previous list, and is answered rather than left hanging.
  const cmd = commandFor(i, config.slashCommandMode);
  if (cmd === null) {
    return i.reply({
      content:
        config.slashCommandMode === 'single'
          ? `That command is gone — use \`/${COMMAND_NAME}\` instead.`
          : `\`/${COMMAND_NAME}\` is gone — its subcommands are top-level commands here.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!config.isAllowed(i.user.id)) {
    log.warn('slash command dropped', { command: cmd, user: i.user.tag, id: i.user.id });
    return i.reply({ content: 'Not authorised.', flags: MessageFlags.Ephemeral });
  }

  // The authorisation. In `multi` mode Discord hides the commands from members
  // without ManageGuild, but hiding is a client affordance: a ManageGuild
  // holder outside ADMIN_USER_IDS still sees them. In `single` mode /ben is
  // visible to everyone. Either way this check — not Discord's picker — is
  // what keeps session and voice control to ADMIN_USER_IDS.
  if (!config.isAdmin(i.user.id)) {
    log.warn('slash command refused — not an admin', {
      command: cmd,
      user: i.user.tag,
      id: i.user.id,
    });
    return i.reply({
      content: 'That command is admin-only. You can still talk to me by mentioning me.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (cmd === 'status') {
    // Deferred: the checks open sockets to the shim and to speech-to-speech,
    // which can exceed the 3s interaction deadline when one of them is exactly
    // the thing that is broken.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { report } = require('./status');
    return i.editReply(await report(client, sessionKeyFor(i.channel, i.user.id)));
  }

  // Belt and braces: with voice disabled these are not registered, but Discord
  // keeps a guild's previous command list until the new one is PUT, so an
  // instance restarted into text-only can still receive them for a moment.
  if (
    (cmd === 'join' ||
      cmd === 'leave' ||
      cmd === 'cancel' ||
      cmd === 'wakephrase' ||
      cmd === 'interrupt' ||
      cmd === 'transcribe') &&
    !config.voiceEnabled
  ) {
    return i.reply({ content: VOICE_DISABLED_REPLY, flags: MessageFlags.Ephemeral });
  }

  if (cmd === 'wakephrase') {
    const session = voice.sessions.get(i.guildId);
    if (!session || session.closed) {
      return i.reply({
        content: 'No live call here — the wake gate only applies while I am in a voice channel.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const mode = i.options.getString('mode');
    const describe = (override) =>
      override === null
        ? `the default (following VOICE_ALWAYS_WAKE, currently **${config.voiceAlwaysWake ? 'on' : 'off'}**)`
        : `**${override ? 'on' : 'off'}**`;

    // Bare invocation is the query form — report, change nothing.
    if (mode === null) {
      return i.reply({
        content:
          `Wake phrase: ${describe(session.wakeOverride)}. ` +
          `Right now I ${session.solo ? 'answer unprompted (you are alone)' : 'need the wake phrase'}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // The POST reaches the shim, so it can outlast the 3s interaction deadline
    // if the endpoint is exactly what is unwell. `default` clears the override;
    // `on`/`off` set it.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const value = mode === 'default' ? null : mode === 'on';
    const res = await voice.setWakeOverride(i.guildId, value);
    if (!res.ok) {
      return i.editReply(
        res.unsupported
          ? 'That endpoint has no /voice/wake route — the wake phrase stays as it is.'
          : `Could not change it: ${res.error}. Wake phrase unchanged.`,
      );
    }
    return i.editReply(
      `Wake phrase: ${describe(value)}. ` +
        `I ${res.solo ? 'now answer unprompted while you are alone' : 'need the wake phrase to answer'}.`,
    );
  }

  if (cmd === 'join') {
    const channel = i.member?.voice?.channel;
    if (!channel) {
      return i.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
    }
    await i.reply({ content: `Joining ${channel.name}…`, flags: MessageFlags.Ephemeral });
    try {
      const session = await voice.join(channel);
      await i.followUp({ content: `Listening in ${channel.name}.`, flags: MessageFlags.Ephemeral });
      // Say it out loud in the channel: recording should never be silent, even
      // on a server where everyone present already knows.
      if (session?.transcript && config.announceTranscription) {
        await i.channel
          ?.send(`🎙️ Transcribing **${channel.name}** — every speaker is written down.`)
          .catch(() => {});
      }
    } catch (e) {
      log.error('voice join failed', { error: e.message });
      await i.followUp({
        content: `Could not join: ${e.message}. A connection stuck in "signalling" is usually permissions.`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  if (cmd === 'new' || cmd === 'sessions' || cmd === 'switch') {
    // Deferred: each of these calls the endpoint, which can outlast the 3s
    // interaction deadline precisely when the endpoint is the thing misbehaving.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = sessionKeyFor(i.channel, i.user.id);
    const { newSession, sessionsList, switchSession } = require('./commands');
    if (cmd === 'new') return i.editReply(await newSession(key));
    if (cmd === 'sessions') return i.editReply(await sessionsList(key));
    return i.editReply(await switchSession(key, i.options.getString('id')));
  }

  if (cmd === 'mode') {
    // Not deferred: this is one localhost POST to the shim, far inside the 3s
    // deadline — but it does reach the network, so the reply still goes
    // ephemeral and still tells the user which mode the conversation is now in.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = sessionKeyFor(i.channel, i.user.id);
    const mode = i.options.getString('mode');
    // One sentence per mode, phrased as what the conversation now does. The
    // three modes are one pair of flags, so describing them flag-by-flag
    // ("posting on, speech off") would read as two settings rather than one.
    const describes = {
      'voice-only': 'I speak and never post to the channel',
      'voice-text': 'I speak and post to the channel',
      'text-only': 'I post to the channel and never speak',
    };
    // Bare invocation is the query form — report the current posture without
    // changing it, like the other three toggles.
    if (mode === null) {
      const state = await getVoiceState(key);
      if (!state.ok) {
        const reason = state.error || 'the endpoint is unreachable';
        return i.editReply(`Could not read the mode (${reason}).`);
      }
      const current = !state.posting ? 'voice-only' : !state.speech ? 'text-only' : 'voice-text';
      return i.editReply(`This conversation is currently **${current}**: ${describes[current]}.`);
    }
    // The three named modes are the whole value space — /mode deliberately has
    // no on|off|default aliases: its states are all explicit and nameable, so
    // the default (voice-text) is reachable by naming it, and an `off` would be
    // ambiguous (off = stop posting? stop speaking?) on a command that sets a
    // pair of flags. The bare query form above reports the current state.
    const result = await setMode(mode, key);
    if (!result.ok) {
      const reason = result.unsupported
        ? 'the backend does not support per-conversation modes'
        : result.error || 'the endpoint is unreachable';
      return i.editReply(`Could not switch mode (${reason}). Mode stays as it was.`);
    }
    return i.editReply(`This conversation is now **${mode}**: ${describes[mode]}.`);
  }

  if (cmd === 'interrupt') {
    // Same shape as /mode, deliberately not /wakephrase: the flag lives on the
    // shim keyed per conversation, not on a live Session, so no call needs to
    // be up to flip it. One localhost POST to the shim, far inside the 3s
    // deadline — still deferred because it reaches the network, and still
    // ephemeral so the reply is not written into the call's chat.
    //
    // Bare invocation is the query form: no `mode` option means the shim
    // reports the current posture without changing it, so "is it off right
    // now?" is answerable without a third command — same shape as /wakephrase.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = sessionKeyFor(i.channel, i.user.id);
    const mode = i.options.getString('mode');
    // `default` is the clear form, distinct from the bare-command query (`null`).
    const result = await setInterrupt(
      mode === null ? null : mode === 'default' ? 'default' : mode === 'on',
      key,
    );
    if (!result.ok) {
      const reason = result.unsupported
        ? 'the backend does not support runtime interrupt toggles'
        : result.error || 'the endpoint is unreachable';
      return i.editReply(`Could not change it (${reason}). Interrupt stays as it was.`);
    }
    const cancel = result.cancel ?? mode !== 'off';
    return i.editReply(
      mode === 'default'
        ? 'Interrupt is back to the default (**on**): speaking over me mid-turn still cuts the answer off.'
        : cancel
          ? 'Interrupt is **on**: speaking over me mid-turn still cuts the answer off.'
          : 'Interrupt is **off**: speaking over me no longer discards the answer I am producing — it still completes and reaches the chat.',
    );
  }

  if (cmd === 'transcribe') {
    // Same shape as /interrupt, deliberately not /wakephrase: the flag lives on
    // the shim keyed per conversation, so no call needs to be up to flip it —
    // but the GATE is this bot's own transcript writer, so a live session gets
    // its local mirror updated only after the shim took the change.
    //
    // Bare invocation is the query form: no `mode` option means the shim
    // reports the current posture without changing it, so "are we being
    // written down right now?" is answerable without a third command.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const key = sessionKeyFor(i.channel, i.user.id);
    const mode = i.options.getString('mode');
    // `default` is the clear form, distinct from the bare-command query (`null`).
    const result = await setTranscribe(
      mode === null ? null : mode === 'default' ? 'default' : mode === 'on',
      key,
    );
    if (!result.ok) {
      const reason = result.unsupported
        ? 'the backend does not support runtime transcription toggles'
        : result.error || 'the endpoint is unreachable';
      return i.editReply(`Could not change it (${reason}). Transcription stays as it is.`);
    }
    // Adopt locally only if the shim took it. No live session (e.g. bare query
    // from the call's text chat after the call already ended) simply leaves
    // the store authoritative for the next join, which clears it anyway.
    const session = voice.sessions.get(i.guildId);
    if (session && !session.closed) session.setTranscribing(result.transcribe);
    const writing = result.transcribe;
    return i.editReply(
      mode === 'default'
        ? 'Transcription is back to the default (**on**): every speaker is written down again.'
        : writing
          ? 'Transcription is **on**: every speaker is written down again.'
          : 'Transcription is **off**: nothing more is written down for this call.',
    );
  }

  if (cmd === 'leave') {
    const left = voice.leave(i.guildId, 'command');
    await i.reply({
      content: left ? 'Left.' : 'Not in a voice channel.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (cmd === 'cancel') {
    // The typed counterpart to barge-in, for when the listener does not want
    // to talk over the assistant. Same shape as /leave rather than /interrupt:
    // it touches only local playback state, so there is no shim round trip and
    // no deferral to spend.
    //
    // Deliberately NOT gated on `config.interruptResponse`, unlike the
    // `speech_started` path. That switch decides whether SPEAKING cancels a
    // turn; this is an explicit operator action, and gating it would leave
    // /cancel unavailable in exactly the case it exists for — barge-in turned
    // off. This is the only stop path that ignores the switch.
    const session = voice.sessions.get(i.guildId);
    if (!session || session.closed) {
      return i.reply({
        content: 'Not in a voice channel.',
        flags: MessageFlags.Ephemeral,
      });
    }
    if (!session.cancelPlayback()) {
      return i.reply({
        content: 'Nothing is playing right now.',
        flags: MessageFlags.Ephemeral,
      });
    }
    log.info('slash command: /cancel — stopping playback', {
      guildId: i.guildId,
      user: i.user.tag,
    });
    return i.reply({ content: 'Stopped.', flags: MessageFlags.Ephemeral });
  }
});

text.register(client);

function shutdown(signal) {
  if (draining) return;
  draining = true; // fail readiness first, so k8s stops routing to us
  log.info('shutting down', { signal });

  const timer = setTimeout(() => {
    log.error('graceful shutdown timed out, forcing exit', {
      timeoutMs: config.shutdownTimeoutMs,
    });
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  // Leave voice BEFORE tearing down the gateway, and give the voice-state
  // update a moment to actually reach Discord. Destroying the client straight
  // away cuts the connection first, leaving the bot as a ghost participant
  // that a later process then has to evict.
  for (const id of [...voice.sessions.keys()]) voice.leave(id, 'shutdown');
  for (const guild of client.guilds.cache.values()) {
    voice.evictGhost(guild).catch(() => {});
  }
  if (gchatHandle) gchatHandle.close().catch(() => {});
  setTimeout(() => {
    client.destroy();
    health.close(() => {
      clearTimeout(timer);
      log.info('shutdown complete');
      process.exit(0);
    });
  }, 600).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: String(reason) });
  process.exit(1);
});
// A single bad voice packet must not take the bot down. Discord's decryption
// layer throws asynchronously, from a UDP callback with no listener to catch it,
// so it surfaces here rather than anywhere it could be handled locally. Observed
// mid-conversation: "Failed to decrypt: DecryptionFailed(
// UnencryptedWhenPassthroughDisabled)" killed the process and the call simply
// stopped, with the last thing in the log being a normal transcript line.
//
// Deliberately narrow. Exiting on an unknown exception is right — the process
// state is unknowable — so only this known-recoverable class is survived, and it
// is still logged every time.
const RECOVERABLE = /Failed to decrypt|DecryptionFailed|Unencrypted/i;

// Transient network faults, survivable ONLY once the gateway has connected at
// least once. Observed 2026-08-05: the laptop slept, and "Opening handshake has
// timed out" arrived from inside `ws` with no listener to catch it, killing a
// bot that had been running fine for eight hours. `make run` exited and nothing
// brought it back, so the first anyone knew was `/join` doing nothing.
//
// The `connectedOnce` condition is the whole point. After login, discord.js
// reconnects on its own and swallowing the throw lets it. BEFORE login there is
// nothing to reconnect — surviving would leave a process that is alive, passing
// liveness, and permanently disconnected, which is strictly worse than exiting,
// because a crash is at least visible.
const RECOVERABLE_NET =
  /Opening handshake has timed out|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|WebSocket was closed/i;

let connectedOnce = false;
client.once('clientReady', () => {
  connectedOnce = true;
});

process.on('uncaughtException', (err) => {
  if (RECOVERABLE.test(err?.message ?? '')) {
    log.warn('dropped an undecryptable voice packet', { error: err.message });
    return;
  }
  if (connectedOnce && RECOVERABLE_NET.test(err?.message ?? '')) {
    // Readiness already reports the disconnect, so traffic drains while
    // discord.js retries. Logged at error level: it is not routine.
    log.error('survived a gateway network fault, waiting for reconnect', { error: err.message });
    gatewayReady = false;
    return;
  }
  log.error('uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

client.login(config.discordToken);
