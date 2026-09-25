'use strict';

const config = require('./config');
const log = require('./log');
const { chat, sessionKeyFor } = require('./llm');
const voice = require('./voice');
const { chunk, DISCORD_LIMIT } = require('./discord-chunk');
const { VOICE_DISABLED_REPLY } = require('./slash-commands');

/** Rebuild conversation history from the channel itself — no local state to lose. */
async function history(channel, botId) {
  const fetched = await channel.messages.fetch({ limit: config.historyLimit });
  return [...fetched.values()]
    .reverse()
    .filter((m) => m.content && (m.author.id === botId || config.isAllowed(m.author.id)))
    .map((m) => ({ role: m.author.id === botId ? 'assistant' : 'user', content: m.content }));
}

/**
 * Which voice channel is this user in, anywhere the bot can see?
 *
 * A DM carries no guild, so `msg.member` is null and the voice state has to be
 * looked up across guilds. The cache is usually warm from GuildVoiceStates;
 * the fetch is the fallback for a member the bot has not seen speak yet.
 */
async function voiceChannelOf(client, userId) {
  for (const [, guild] of client.guilds.cache) {
    const member =
      guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
    if (member?.voice?.channel) return member.voice.channel;
  }
  return null;
}

/**
 * Reply to a voice command, tolerating a failed reply.
 *
 * A reply can be rejected by Discord itself (160002: the bot lacks "Read
 * Message History" in the guild) — and on 2026-09-04 that rejection escaped
 * this async handler, hit index.js's unhandledRejection handler, and exited(1).
 * launchd restarted the bot, the startup evictGhost disconnected the voice
 * connection, and the next /leave found no session: join worked, leave never
 * did, and the process crash-looped on every attempt. The voice action itself
 * (join/leave) has already happened by the time we reply — the reply is
 * confirmation, not the operation — so a failed reply is logged and swallowed,
 * never allowed to take the bot down.
 */
async function safeVoiceReply(msg, text) {
  try {
    await msg.reply(text);
  } catch (e) {
    log.warn('voice reply failed', { error: e.message });
  }
}

/** `join` / `leave` typed as a message — same effect as the slash command. */
async function handleVoiceCommand(msg, client, cmd) {
  // Refused with a reason rather than ignored. The slash commands are not
  // registered on a text-only instance, but the typed forms cost nothing to
  // answer, and someone who types `join` because it worked elsewhere deserves
  // to be told why it did not, rather than watching the bot say nothing.
  if (!config.voiceEnabled) {
    log.info('voice command refused, voice disabled', { cmd, user: msg.author.tag });
    return safeVoiceReply(msg, VOICE_DISABLED_REPLY);
  }

  const voice = require('./voice');
  if (cmd === 'leave') {
    const guildId = msg.guild?.id ?? [...client.guilds.cache.keys()][0];
    const left = guildId ? voice.leave(guildId, 'command') : false;
    log.info('voice command via text', { cmd, ok: left });
    return safeVoiceReply(msg, left ? 'Left the voice channel.' : 'I am not in a voice channel.');
  }

  const channel = msg.member?.voice?.channel ?? (await voiceChannelOf(client, msg.author.id));
  if (!channel) {
    return safeVoiceReply(msg, 'Join a voice channel first, then say join.');
  }
  try {
    const session = await voice.join(channel);
    log.info('voice command via text', { cmd, channel: channel.name });
    await safeVoiceReply(msg, `Listening in ${channel.name}.`);
    if (session?.transcript && config.announceTranscription) {
      await channel
        .send(`🎙️ Transcribing **${channel.name}** — every speaker is written down.`)
        .catch(() => {});
    }
  } catch (e) {
    log.error('voice join via text failed', { error: e.message });
    await safeVoiceReply(msg, `Could not join: ${e.message}`);
  }
}

/** A thread this bot started — messages in it are turns, no mention needed. */
function isOwnThread(channel, botId) {
  return Boolean(channel?.isThread?.() && channel.ownerId === botId);
}

/**
 * Remove the bot's own address from a message, in either form it can take.
 *
 * `<@id>` / `<@!id>` is the user mention; `<@&roleId>` is a role mention, which
 * Discord's autocomplete offers as a second, visually identical entry for a bot
 * that has a managed role. Both mean "I am talking to you" and neither is part
 * of the question, so both come out.
 *
 * `myRoles` is the bot's own role cache, and only those ids are stripped — a
 * mention of some other group is content the user meant to write.
 *
 * Exported for tests: the id-interpolated regexes are exactly the kind of thing
 * that works on the case it was written against and silently misses `<@!id>`.
 */
function stripAddress(content, botId, myRoles, everyoneId) {
  let out = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '');
  for (const id of myRoles?.keys?.() ?? []) {
    if (id === everyoneId) continue;
    out = out.replace(new RegExp(`<@&${id}>`, 'g'), '');
  }
  return out;
}

/**
 * Where the answer goes.
 *
 * In a guild channel, the first mention opens a thread and everything after
 * lives there: the channel stays clean, follow-ups need no `@`, and history
 * fetches are naturally scoped to the conversation instead of to whatever else
 * the channel was discussing.
 *
 * DMs are returned as-is — Discord has no threads in DMs.
 */
async function conversationChannel(msg, botId) {
  if (!msg.guild) return msg.channel;
  if (isOwnThread(msg.channel, botId)) return msg.channel;
  if (!msg.channel.threads) return msg.channel; // e.g. already a forum post
  try {
    return await msg.startThread({
      name:
        msg.content
          .replace(/<@!?\d+>/g, '')
          .trim()
          .slice(0, 90) || 'assistant',
      autoArchiveDuration: 1440,
    });
  } catch (e) {
    // Missing Create Threads permission is not worth losing the answer over.
    log.warn('could not start thread, replying in channel', { error: e.message });
    return msg.channel;
  }
}

function register(client) {
  client.on('messageCreate', async (msg) => {
    // Logged before any filtering, as a liveness probe for the gateway itself:
    // when slash commands hang with nothing arriving, the question is whether
    // ANY event is being delivered or only interactions are broken. Without
    // this, a message that gets filtered out looks identical to a dead socket.
    log.debug('message seen', {
      dm: !msg.guild,
      author: msg.author?.tag ?? null,
      bot: Boolean(msg.author?.bot),
    });

    // Anything written in a voice channel's own text chat goes into that
    // channel's transcript, alongside what was said aloud. One record for the
    // conversation rather than two half-records — which is what makes "have a
    // look at the link I just posted" answerable: the link is in the file the
    // session already reads, in chronological place among the speech.
    //
    // Everyone is captured, matching the audio side: who may DRIVE the bot is
    // the allowlist's business, who gets WRITTEN DOWN is the transcript's.
    if (!msg.author.bot && msg.content) {
      const transcript = voice.transcriptFor(msg.guild?.id, msg.channel?.id);
      if (transcript) {
        // Marked, because the two have different reliability: a spoken line is
        // STT output and can be wrong — real speech once became "when they have
        // something that's the young job" — while a typed line is exact. A
        // reader deciding whether to act on a pasted path or URL needs to know
        // which it is holding.
        transcript.writeText(
          msg.member?.displayName ?? msg.author.username,
          `(typed) ${msg.content}`,
        );
        log.debug('transcript: text captured', { author: msg.author.tag });
      }
    }

    if (msg.author.bot) return;

    // Answer DMs, mentions in a guild, and anything inside a thread we opened.
    //
    // A ROLE mention counts too, and only a role the bot actually holds.
    // Discord's autocomplete offers the bot user and the bot's managed role as
    // two visually identical entries — same name, same avatar, one blue pill —
    // and picking the role produces `<@&roleId>`, which lands in
    // `mentions.roles` and never in `mentions.users`. Before this, choosing the
    // wrong one of two indistinguishable entries meant the message was dropped
    // with no reply and no log line. Scoped to roles the bot holds so that
    // mentioning some unrelated group does not summon it.
    const isDM = !msg.guild;
    const myRoles = msg.guild?.members?.me?.roles?.cache;
    // `@everyone` is a role the bot HOLDS, and its id is the guild id. discord.js
    // reports it via `mentions.everyone` rather than `mentions.roles`, so this
    // exclusion is belt-and-braces — but the failure it guards against is every
    // `@everyone` ping in the server summoning the assistant, which is too large
    // to leave resting on a library detail nothing here asserts.
    const everyoneId = msg.guild?.id;
    const mentionedByRole =
      Boolean(myRoles) && msg.mentions.roles.some((r) => r.id !== everyoneId && myRoles.has(r.id));
    const mentioned = msg.mentions.users.has(client.user.id) || mentionedByRole;
    const inOwnThread = isOwnThread(msg.channel, client.user.id);
    if (!isDM && !mentioned && !inOwnThread) {
      // Debug, not info: the bot sees every message in every channel it can
      // read, so this is the common case and would drown the log at any louder
      // level. It exists at all because four separate "the bot ignored me"
      // hunts this month ended at a filter that returned without saying so —
      // an unaddressed message and a misrouted one look identical from outside.
      log.debug('text: not addressed, ignoring', {
        channel: msg.channel.id,
        roleMentions: msg.mentions.roles.size,
      });
      return;
    }

    if (!config.isAllowed(msg.author.id)) {
      log.warn('text message dropped', { user: msg.author.tag, id: msg.author.id });
      return;
    }

    // Strip the address, whichever form it took. The role form has to go too:
    // left in, the model receives a literal `<@&1533564399195918399>` at the
    // front of the question and either echoes it back or treats it as content.
    // Only the bot's own roles are stripped — a mention of some other group is
    // part of what the user wrote.
    const content = stripAddress(msg.content, client.user.id, myRoles, everyoneId).trim();
    if (!content) return;
    log.info('text in', { user: msg.author.tag, content: content.slice(0, 80) });

    // Voice control over text as well as slash commands. Slash commands are
    // delivered as INTERACTIONS, a separate Discord subsystem from messages —
    // during an API outage on 2026-08-04 the gateway stayed up and messages flowed
    // normally while every interaction was silently dropped, so `/join` hung with
    // no way to start voice at all. Two transports for the same action removes
    // that single point of failure, and typing "join" is no worse than the slash
    // command anyway.
    // The reply stays in the channel rather than opening a thread, so the key is
    // the one this channel/DM already answers on — not a new one.
    const hereKey = sessionKeyFor(msg.channel, msg.author.id);

    const cmd = content.match(/^\/?\s*(join|leave|status|selfcheck|new|sessions)\s*$/i);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      if (name === 'status' || name === 'selfcheck') {
        const { report } = require('./status');
        return msg.reply(await report(client, hereKey));
      }
      if (name === 'new' || name === 'sessions') {
        const { newSession, sessionsList } = require('./commands');
        return msg.reply(name === 'new' ? await newSession(hereKey) : await sessionsList(hereKey));
      }
      return handleVoiceCommand(msg, client, name);
    }

    // `switch <id>` takes an argument, so it cannot join the bare-word set. The
    // id shape is required in the pattern: "switch to the other approach" is a
    // sentence for Claude, not a command.
    const sw = content.match(/^\/?\s*switch\s+`?([0-9a-f-]{8,36})`?\s*$/i);
    if (sw) {
      const { switchSession } = require('./commands');
      return msg.reply(await switchSession(hereKey, sw[1]));
    }

    let target = msg.channel;
    try {
      target = await conversationChannel(msg, client.user.id);

      // A typed turn landing in the text chat of a channel with a LIVE call
      // is answered ALOUD, not in text: push it into the s2s socket the call
      // already holds and let the existing playback path speak the reply.
      // The rule is deliberately simple and content-blind — "this channel is
      // a live call right now" — so the medium never depends on how the
      // question was phrased (see the "predictable" success criterion on
      // [[Typed messages cannot be answered aloud]]). Everywhere else (DM,
      // thread, guild channel with no live call) keeps answering in text,
      // exactly as before.
      const liveCall = voice.liveSessionFor(msg.guild?.id, target.id);
      if (liveCall) {
        const result = await liveCall.speak(content);
        if (result.ok) {
          log.info('text: typed turn routed into live call for a spoken reply', {
            channel: target.id,
          });
          // No typing indicator started here on purpose: the session raises it
          // on `response.created` for EVERY answer it produces, spoken or
          // typed (see Session.showTyping). Starting a second one here would
          // be a duplicate that only covers one of the two surfaces.
          return;
        }
        log.warn('text: could not speak typed turn, answering nothing', {
          channel: target.id,
          reason: result.reason,
        });
        // Recorded so a reader of the transcript sees why a typed line has no
        // answer following it, rather than assuming it was ignored.
        liveCall.transcript?.writeText(
          config.assistantLabel,
          `(voice reply failed: ${result.reason})`,
        );
        await target
          .send(`Could not speak that right now (${result.reason}). Try again in a moment.`)
          .catch(() => {});
        return;
      }

      await target.sendTyping();
      const typing = setInterval(() => target.sendTyping().catch(() => {}), 8000);

      // Read history from the thread, not the parent channel — that is the
      // point of threading. A brand-new thread has none, so fall back to the
      // message itself.
      const messages = await history(target, client.user.id).catch(() => []);
      if (messages.at(-1)?.content !== content) messages.push({ role: 'user', content });

      // Key the conversation to the thread/DM/channel so separate threads get
      // separate sessions and can run at the same time.
      const sessionKey = sessionKeyFor(target, msg.author.id);

      let answer;
      try {
        answer = await chat(messages, { sessionKey });
      } finally {
        clearInterval(typing);
      }

      log.info('text out', { chars: answer.length, preview: answer.slice(0, 80) });
      for (const part of chunk(answer)) await target.send(part);

      // A message typed during a live call is answered in the channel, but
      // that reply was never recorded — only the QUESTION side is captured
      // above, so the transcript of a call read one-sided. `target` is the
      // voice channel itself when this is voice's text chat (it has no
      // threads, see conversationChannel), so its id matches the live
      // session's channelId.
      const replyTranscript = voice.transcriptFor(msg.guild?.id, target.id);
      if (replyTranscript) replyTranscript.writeText(config.assistantLabel, answer);
    } catch (e) {
      log.error('text error', { error: e.message });
      await target
        .send(`error talking to the endpoint: ${e.message}`.slice(0, DISCORD_LIMIT))
        .catch(() => {});
    }
  });
}

module.exports = { register, chunk, stripAddress };
