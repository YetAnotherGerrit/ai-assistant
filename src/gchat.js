'use strict';

const config = require('./config');
const log = require('./log');
const { chat } = require('./llm');

/**
 * Google Chat transport — the OPTIONAL second surface of the assistant.
 *
 * Off by default (GCHAT_ENABLED unset → the service behaves exactly as before,
 * Discord only). Enabled, it subscribes to the Data Assistant's Pub/Sub
 * subscription, answers each message through the SAME session engine the
 * Discord surface uses (llm.chat → shim, X-Session-Key), and replies in-thread
 * via the Chat API. Session keys are `gchat:<spaceId>_<threadId>:<identity>`,
 * disjoint from Discord's `thread:`/`dm:`/`channel:`/`voice:` keyspaces, so the
 * two surfaces never share a conversation (goal SC2).
 *
 * Sender-gated: a message whose address is not on `GCHAT_ALLOWED_EMAILS` gets a
 * short refusal in-thread and never reaches the session engine, which can read
 * the Data Assistant vault.
 *
 * Mirrors the verified Python port (openbrain-googlechatbot, 2026-09-04):
 * envelope parse, session keys, per-message triage verdict log line,
 * threading-aware reply, reply-then-ack (a failed reply nacks → redelivery,
 * no silent drops).
 */

const CHAT_SCOPES = ['https://www.googleapis.com/auth/chat.bot'];

const SYSTEM_DIRECTIVE =
  "You are the Data Assistant, the Data Platform team's front door in Google Chat. " +
  "Answer the requester's request in plain text, concisely. " +
  'No status panels — no lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED and ' +
  'no "You:"/"Next:" lines. Markdown is fine. If you cannot answer or need more ' +
  'input, say so plainly rather than inventing anything.';

/**
 * Parse a Workspace-Add-on MESSAGE event envelope.
 *
 * Returns null for non-CHAT events (Workspace Add-ons also fire from Gmail /
 * Docs) so the caller can ack-and-skip without crashing.
 */
function parseEvent(payload) {
  let data;
  try {
    data = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (data?.commonEventObject?.hostApp !== 'CHAT') return null;
  const chatPayload = data?.chat?.messagePayload;
  if (!chatPayload) return null;
  const message = chatPayload.message || {};
  const space = chatPayload.space || {};
  return {
    spaceName: space.name || '',
    threadName: message.thread?.name ?? null,
    senderEmail: data.chat?.user?.email || '',
    argumentText: message.argumentText || '',
  };
}

/**
 * The shim session key for a Google Chat thread.
 *
 * `gchat:<spaceId>_<threadId>:<identity>` — exactly three colon segments,
 * identity last (the shim splits on ':' and takes the last segment as the
 * identity). Google Chat gives slash-separated resource names
 * (`spaces/AAA/threads/BBB`), so only the trailing ids are joined with '_'.
 * A missing thread (DM / unthreaded) degrades to `<spaceId>_space`.
 *
 * The `gchat:` prefix keeps the Chat keyspace disjoint from Discord's, so the
 * two surfaces cannot collide on a session (goal SC2).
 */
function gchatSessionKey(spaceName, threadName) {
  const identity = config.identity;
  const spaceId = String(spaceName).replace(/\/+$/, '').split('/').pop() || '';
  let threadId = 'space';
  if (threadName) threadId = String(threadName).replace(/\/+$/, '').split('/').pop() || 'space';
  return `gchat:${spaceId}_${threadId}:${identity}`;
}

/**
 * Triage verdict per handled message — the goal SC1 evidence log line.
 *
 * This slice answers everything directly, so any non-empty request is `shape`.
 * An empty request has nothing to act on — the requester must say what they
 * actually want.
 */
function classify(text) {
  if (!String(text).trim()) return 'ask-requester';
  return 'shape';
}

/**
 * What a sender who is not on the allowlist gets back, in-thread.
 *
 * Names a human rather than a process: the requester's only useful next step is
 * to ask for access, and "you are not on the allowlist" alone leaves them with
 * nowhere to go.
 */
const REFUSAL_TEXT =
  'Sorry, you have to be on the Data Assistant allowlist to use me — ask Benjamin Borbe for access.';

/**
 * Is this sender allowed to drive the Chat surface?
 *
 * Case-insensitive: Google reports the address in the account's own casing
 * (`Alice@Seibert.Group`), so a byte compare would refuse the very people on
 * the list. Fails closed — an empty list allows nobody, and a payload carrying
 * no `chat.user.email` has no sender to match, so it is refused too.
 *
 * Lives here rather than on `config` because the guide keeps config data-only
 * (`node/config/data-not-behaviour`): `config.gchatAllowedEmails` is the data,
 * this is the rule.
 */
function isAllowedSender(email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return config.gchatAllowedEmails.some((allowed) => allowed.toLowerCase() === normalized);
}

/**
 * Post a text reply via the Chat API, threaded to the source message when
 * possible. Mirrors the Python bot: reply into the existing thread when the
 * event carries a thread name, fall back to a new thread with that name.
 */
async function postChatReply({ spaceName, threadName, text }) {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    keyFile: config.gchatSaCredentials,
    scopes: CHAT_SCOPES,
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  const body = { text };
  const params = new URLSearchParams();
  if (threadName) {
    body.thread = { name: threadName };
    params.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  }
  const url = `https://chat.googleapis.com/v1/${spaceName}/messages${
    params.toString() ? `?${params}` : ''
  }`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Start the Pub/Sub pull subscriber. Returns `{ close, subscription }` so the
 * caller can hook graceful shutdown.
 *
 * Reply-then-ack ordering, same as the Python bot: a failed reply nacks and
 * Pub/Sub redelivers, so a transient outage produces visible duplicates rather
 * than silent drops. One message at a time (flowControl maxMessages=1); the
 * library's default maxExtensionTime (60 min) extends the 600s ack deadline
 * far beyond a Claude turn, so long answers are never redelivered mid-turn.
 */
function startGchat() {
  const { PubSub } = require('@google-cloud/pubsub');
  const pubsub = new PubSub({
    projectId: config.gchatProject,
    keyFilename: config.gchatSaCredentials,
  });
  const subscription = pubsub.subscription(config.gchatSubscription);
  subscription.setOptions({ flowControl: { maxMessages: 1 } });

  subscription.on('message', async (message) => {
    const event = parseEvent(message.data);
    if (!event) {
      message.ack();
      return;
    }
    const key = gchatSessionKey(event.spaceName, event.threadName);
    // The gate runs BEFORE chat(): a turn reaches a Claude Code session with
    // vault and repo access, so a sender who is not on the list must not get
    // one. `refused` is its own verdict rather than a classify() result, so the
    // log line tells a gated sender apart from an ordinary turn.
    const allowed = isAllowedSender(event.senderEmail);
    const verdict = allowed ? classify(event.argumentText) : 'refused';
    log.info('gchat message', {
      verdict,
      sender: event.senderEmail,
      space: event.spaceName,
      thread: event.threadName ?? null,
      sessionKey: key,
    });
    try {
      if (!allowed) {
        await postChatReply({
          spaceName: event.spaceName,
          threadName: event.threadName,
          text: REFUSAL_TEXT,
        });
        message.ack();
        return;
      }
      const answer = await chat(
        [
          { role: 'system', content: SYSTEM_DIRECTIVE },
          { role: 'user', content: event.argumentText },
        ],
        { sessionKey: key },
      );
      await postChatReply({
        spaceName: event.spaceName,
        threadName: event.threadName,
        text: answer,
      });
      message.ack();
    } catch (e) {
      log.error('gchat turn failed', { error: e.message });
      message.nack();
    }
  });

  subscription.on('error', (e) => log.error('gchat subscriber error', { error: e.message }));
  subscription.on('close', () => log.warn('gchat subscriber closed'));

  return { close: () => subscription.close(), subscription };
}

module.exports = {
  parseEvent,
  gchatSessionKey,
  classify,
  isAllowedSender,
  REFUSAL_TEXT,
  startGchat,
};
