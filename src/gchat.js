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
 * Posted when a turn outlives `config.gchatProgressAfterMs`.
 *
 * Short on purpose: it is a liveness signal, not content. The answer follows in
 * the same thread, and a second paragraph here would only compete with it.
 */
const PROGRESS_TEXT =
  'Working on it… this one is taking a while. The answer will land in this thread.';

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
 * Run `run()`, calling `onProgress()` once if it has not settled within
 * `afterMs`.
 *
 * The timer is cleared the moment `run()` settles, so a fast turn posts
 * nothing — that threshold is the point, not a detail. A slow turn posts
 * exactly once: the timer is armed once and never re-armed.
 *
 * An in-flight progress post is awaited before returning, so it is always in
 * the thread BEFORE the answer that follows. The post is best-effort — a
 * failure is logged and never fails the turn, because a courtesy notice must
 * never be able to lose an answer.
 *
 * `schedule`/`cancel` are injected so a test can drive the clock instead of
 * waiting out a real threshold.
 */
async function withProgress({
  afterMs,
  onProgress,
  run,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let pending = null;
  const timer = schedule(() => {
    pending = Promise.resolve()
      .then(onProgress)
      .catch((e) => log.error('gchat progress post failed', { error: e.message }));
  }, afterMs);
  try {
    return await run();
  } finally {
    cancel(timer);
    if (pending) await pending;
  }
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
      // Answer from the mention alone. Google Chat delivers only @mentions, and
      // reading what was said between them needs a scope only a Workspace
      // administrator can grant — without it every turn took a 403 for no
      // benefit. The session already remembers the rest of the conversation, so
      // no history is supplied.
      const answer = await withProgress({
        afterMs: config.gchatProgressAfterMs,
        onProgress: () =>
          postChatReply({
            spaceName: event.spaceName,
            threadName: event.threadName,
            text: PROGRESS_TEXT,
          }),
        run: () =>
          converse({
            sessionKey: key,
            text: event.argumentText,
            system: SYSTEM_DIRECTIVE,
          }),
      });
      await postChatReply({
        spaceName: event.spaceName,
        threadName: event.threadName,
        text: answer,
      });
      message.ack();
    } catch (e) {
      log.error('gchat turn failed', { error: e.message, permanent: Boolean(e.permanent) });
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
        message.ack();
        return;
      }
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
  PROGRESS_TEXT,
  withProgress,
  startGchat,
};
