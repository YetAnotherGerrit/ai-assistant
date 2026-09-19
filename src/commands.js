'use strict';

const { resetSession, listSessions, bindSession, availableSessions } = require('./llm');
const { DEFAULT_SESSION_KEY } = require('./llm');
const log = require('./log');

/**
 * Session commands, shared by both transports.
 *
 * The bodies live here rather than in the slash handler because slash commands
 * are interactions and interactions are a separate Discord subsystem — during
 * the 2026-08-04 outage every one was dropped while messages flowed. Anything
 * worth doing is worth being able to type.
 */

const DISCORD_LIMIT = 2000;
const clip = (s) => (s.length > DISCORD_LIMIT ? `${s.slice(0, DISCORD_LIMIT - 3)}...` : s);

function age(minutes) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.round(minutes / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** Start a fresh conversation here. The old session is left on disk, not deleted. */
async function newSession(key) {
  try {
    const r = await resetSession(key);
    log.info('session reset', { key, previous: r.previous || null });
    // The old id is quoted deliberately: "fresh start" reads as destruction, and
    // this is the one line that shows the previous conversation still exists.
    return r.previous
      ? `Fresh start here. The previous session is still on disk — \`switch ${r.previous}\` returns to it.`
      : 'Fresh start here.';
  } catch (e) {
    return `Could not reset: ${e.message}`;
  }
}

/** What is bound where, and what could be switched to. */
async function sessionsList(hereKey) {
  const out = [];
  const boundTo = new Map();
  try {
    const { sessions = [] } = await listSessions();
    for (const s of sessions) boundTo.set(s.id, s.key);
    const show = (label, s) =>
      `• ${label} \`${s.key}\` — \`${s.id}\`, ${s.live ? 'warm' : 'cold'}, ${s.turns} turn(s)`;
    const here = sessions.find((s) => s.key === hereKey);
    const voice = sessions.find((s) => s.key === DEFAULT_SESSION_KEY);
    out.push('**Bound now**');
    if (here) out.push(show('here', here));
    else out.push(`• here \`${hereKey}\` — none yet`);
    if (voice && voice.key !== hereKey) out.push(show('voice', voice));
  } catch (e) {
    return `Could not list sessions: ${e.message}`;
  }

  try {
    const { available = [] } = await availableSessions();
    if (available.length) {
      out.push('', '**Switch to** — `switch <id>`');
      // Every session the shim returns (active in the last two days, newest
      // first) fits until a line would blow Discord's message limit — the
      // shim window is the real filter, the char budget the only cap.
      let size = out.join('\n').length;
      for (const a of available) {
        const label = a.label ? ` — "${a.label}"` : '';
        // Marked rather than hidden: switching to a taken id is refused, so
        // offering it unannotated invites a failure. Seeing WHERE a session
        // already lives is also the answer to "which one is the voice one".
        const taken = boundTo.get(a.id);
        const note = taken ? ` — **already \`${taken}\`**` : '';
        const line = `• \`${a.id}\`${label} — ${a.turns} turn(s), ${age(a.age_minutes)} ago${note}`;
        if (size + line.length + 1 > DISCORD_LIMIT) break;
        out.push(line);
        size += line.length + 1;
      }
    }
  } catch {
    // An endpoint without the route is fine; the bound list above still stands.
  }
  return clip(out.join('\n'));
}

const ID_SHAPE = /^[0-9a-f]{4,8}(-[0-9a-f-]*)?$/i;

/**
 * Point this conversation at an existing session.
 *
 * Accepts a prefix as well as a full id. A uuid is 36 characters and this is a
 * phone-first surface — retyping one by hand is the kind of friction that stops
 * a feature being used at all. The prefix must be unambiguous; two matches ask
 * rather than guess, because guessing here silently continues the wrong
 * conversation.
 */
async function switchSession(key, id) {
  const clean = (id ?? '').trim().replace(/^`|`$/g, '');
  if (!clean) return 'Give me a session id — `sessions` lists them.';
  // Shape-checked here so free text (a slash-command option takes anything)
  // fails with something a human can act on, rather than being handed to the
  // endpoint and coming back as a filesystem path.
  if (!ID_SHAPE.test(clean)) {
    return `\`${clean}\` is not a session id. Run \`sessions\` for the list — ids look like \`b1f506b0\`.`;
  }

  let target = clean;
  if (clean.length < 36) {
    try {
      const { available = [] } = await availableSessions();
      const hits = available.filter((a) => a.id.startsWith(clean.toLowerCase()));
      if (hits.length === 0)
        return `Nothing starts with \`${clean}\`. Run \`sessions\` for the list.`;
      if (hits.length > 1) {
        return `\`${clean}\` matches ${hits.length} sessions — give me more of it:\n${hits
          .map((h) => `• \`${h.id}\`${h.label ? ` — "${h.label}"` : ''}`)
          .join('\n')}`;
      }
      target = hits[0].id;
    } catch {
      // No /sessions/available on this endpoint: fall through with what was
      // typed and let the bind itself decide.
    }
  }

  try {
    const r = await bindSession(key, target);
    log.info('session switched', { key, id: target, previous: r.previous || null });
    return `This conversation now continues \`${target}\`. Its history is already there — say something to pick it up.`;
  } catch (e) {
    // The shim's refusals name their reason, which is what a reader needs — but
    // they also carry absolute paths that mean nothing in a chat window and
    // reveal more of the host than a Discord reply should. Every refusal states
    // one, each behind a different preposition ("in <dir>" when the lookup
    // missed, "under <dir>" for the widened search, "at <file>" when a
    // transcript has no recorded cwd), so strip the path and keep the sentence.
    const why = e.message.replace(/ (?:in|under|at) \/\S+/g, '');
    return `Could not switch: ${why}`;
  }
}

module.exports = { newSession, sessionsList, switchSession };
