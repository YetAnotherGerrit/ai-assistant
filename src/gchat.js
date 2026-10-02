'use strict';

const config = require('./config');
const log = require('./log');
const { conversationKey, converse } = require('./llm');

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

/**
 * The scope that posts the reply.
 *
 * `chat.bot` is an app-scoped token that needs no administrator approval. There
 * is deliberately no read scope: listing a thread's messages needs a scope only
 * a Google Workspace administrator can grant, and `spaces.messages.list` rejects
 * `chat.bot` outright (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, verified 2026-10-02).
 * Without that grant the read took a 403 on every turn for no benefit, so it was
 * removed and the bot answers from the mention alone. The CHANGELOG entry names
 * the scope that was dropped.
 */
const CHAT_WRITE_SCOPES = ['https://www.googleapis.com/auth/chat.bot'];

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
  const spaceId = String(spaceName).replace(/\/+$/, '').split('/').pop() || '';
  let threadId = 'space';
  if (threadName) threadId = String(threadName).replace(/\/+$/, '').split('/').pop() || 'space';
  // Only the namespace and id are this transport's business; the core builds the
  // string. `alwaysIdentity` is what keeps the trailing segment even with no
  // IDENTITY set — see `conversationKey`.
  return conversationKey('gchat', `${spaceId}_${threadId}`, { alwaysIdentity: true });
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
 * The placeholder posted the moment an allowlisted mention arrives, BEFORE the
 * shim is called.
 *
 * It exists so the thread is never silent while a turn runs — a demo turn that
 * investigates and writes code takes minutes. Once the turn ends it is edited
 * into a one-line status (see `turnStatus`) rather than deleted: Chat renders a
 * tombstone ("Message deleted by its author") for any deleted message, which is
 * more noise than the placeholder it removed.
 */
const THINKING_TEXT = '🤔 thinking…';

/**
 * The one-line status the placeholder is edited into once the turn ends.
 *
 * Carrying the elapsed time is what makes the artifact worth keeping: it is the
 * one thing the thread cannot otherwise show about a turn that took minutes.
 * Pure, so a test pins the wording without a clock.
 */
function turnStatus({ ms, failed = false }) {
  // Floor at 1s: "generated in 0s" reads as a bug rather than as "fast".
  const seconds = Math.max(1, Math.round(ms / 1000));
  return failed ? `Turn failed after ${seconds}s` : `Answer was generated in ${seconds}s`;
}

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
 * A bearer token for the Chat API under one scope set.
 *
 * Shared by the reply path and the thread-read path so credential handling
 * exists once. `google-auth-library` is required lazily: a Discord-only
 * deployment never enables this transport and must not pay for the dependency.
 */
async function chatAccessToken(scopes) {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ keyFile: config.gchatSaCredentials, scopes });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

/**
 * Post a text reply via the Chat API, threaded to the source message when
 * possible. Mirrors the Python bot: reply into the existing thread when the
 * event carries a thread name, fall back to a new thread with that name.
 */
async function postChatReply({ spaceName, threadName, text }) {
  const token = await chatAccessToken(CHAT_WRITE_SCOPES);

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
 * Edit a message the app itself posted.
 *
 * `chat.bot` covers the app's OWN messages, so the scope that posts also
 * patches — no user auth, and no second credential path. `updateMask=text` is
 * required: without it the PATCH is read as a full replace and Chat rejects the
 * partial body.
 */
async function patchChatMessage({ messageName, text }) {
  const token = await chatAccessToken(CHAT_WRITE_SCOPES);
  const params = new URLSearchParams({ updateMask: 'text' });
  const res = await fetch(`https://chat.googleapis.com/v1/${messageName}?${params}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`chat api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Delete a message the app itself posted.
 *
 * Used only on the transient-failure path, where the turn is NOT over: Pub/Sub
 * redelivers it and the retry posts its own placeholder, so a status line left
 * here would sit beside the retry's 🤔.
 */
async function deleteChatMessage({ messageName }) {
  const token = await chatAccessToken(CHAT_WRITE_SCOPES);
  const res = await fetch(`https://chat.googleapis.com/v1/${messageName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`chat api ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/**
 * Edit the turn's placeholder to its closing status.
 *
 * Called only AFTER the outcome message is posted, so a failed answer never
 * removes the placeholder and leaves the thread silent — the exact failure this
 * feature exists to prevent.
 *
 * Best-effort by design: the answer is already in the thread by the time this
 * runs, so a failed edit must never turn a delivered answer into a failed turn.
 * A missing placeholder — its own post failed, so the turn never got one — is a
 * no-op rather than an error.
 *
 * `patch` is injected so a test can assert the call without a Chat API round
 * trip.
 */
async function setPlaceholder(placeholder, text, patch = patchChatMessage) {
  if (!placeholder?.name) return;
  await patch({ messageName: placeholder.name, text }).catch((e) =>
    log.error('gchat placeholder edit failed', { error: e.message }),
  );
}

/**
 * Remove the turn's placeholder — transient failures only, see `deleteChatMessage`.
 *
 * `remove` is injected for the same test reason as `setPlaceholder`'s `patch`.
 */
async function clearPlaceholder(placeholder, remove = deleteChatMessage) {
  if (!placeholder?.name) return;
  await remove({ messageName: placeholder.name }).catch((e) =>
    log.error('gchat placeholder delete failed', { error: e.message }),
  );
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
    // The gate runs BEFORE converse(): a turn reaches a Claude Code session with
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
    // The turn's placeholder, once posted. Held out here so the catch can close
    // it out; stays null while the placeholder post itself is the thing that
    // failed, which the helpers below treat as a no-op.
    let placeholder = null;
    // When the model call started, so the closing status can report how long the
    // answer took. Null until `converse` is reached.
    let startedAt = null;
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
      // Answer the mention immediately with the placeholder, BEFORE the shim
      // call. A demo turn takes minutes, and without this the thread is silent
      // for the whole of it. The answer lands as its own message beside it.
      placeholder = await postChatReply({
        spaceName: event.spaceName,
        threadName: event.threadName,
        text: THINKING_TEXT,
      });
      // Answer from the mention alone. Google Chat delivers only @mentions, and
      // reading what was said between them needs a scope only a Workspace
      // administrator can grant — without it every turn took a 403 for no
      // benefit. The session already remembers the rest of the conversation, so
      // no history is supplied.
      startedAt = Date.now();
      const answer = await converse({
        sessionKey: key,
        text: event.argumentText,
        system: SYSTEM_DIRECTIVE,
      });
      const elapsedMs = Date.now() - startedAt;
      await postChatReply({
        spaceName: event.spaceName,
        threadName: event.threadName,
        text: answer,
      });
      // Only now that the answer is in the thread — see setPlaceholder.
      await setPlaceholder(placeholder, turnStatus({ ms: elapsedMs }));
      message.ack();
    } catch (e) {
      log.error('gchat turn failed', { error: e.message, permanent: Boolean(e.permanent) });
      const elapsedMs = startedAt === null ? 0 : Date.now() - startedAt;
      if (e.permanent) {
        // Retrying cannot fix a misconfiguration, so redelivering only rebuilds
        // the loop. Ack and say so in-thread rather than going silent. The
        // notice is best-effort — a failed one must not resurrect the nack.
        await postChatReply({
          spaceName: event.spaceName,
          threadName: event.threadName,
          text: 'Sorry, the Data Assistant is misconfigured and cannot answer right now.',
        }).catch((noticeError) =>
          log.error('gchat error notice failed', { error: noticeError.message }),
        );
        await setPlaceholder(placeholder, turnStatus({ ms: elapsedMs, failed: true }));
        message.ack();
        return;
      }
      // A transient failure is redelivered and the retry posts its own
      // placeholder, so a status line here would sit beside the retry's 🤔.
      await clearPlaceholder(placeholder);
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
  THINKING_TEXT,
  turnStatus,
  patchChatMessage,
  deleteChatMessage,
  setPlaceholder,
  clearPlaceholder,
  startGchat,
};
