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
 * Two scopes, because the Chat API splits reading a thread from answering in it.
 *
 * `chat.bot` is what posts the reply — an app-scoped token that needs no
 * administrator approval. `spaces.messages.list` rejects it outright
 * (`ACCESS_TOKEN_SCOPE_INSUFFICIENT`, verified 2026-10-02), so reading a thread
 * needs `chat.app.messages.readonly` instead — which a Google Workspace
 * administrator must grant once, and which returns only PUBLIC messages.
 */
const CHAT_WRITE_SCOPES = ['https://www.googleapis.com/auth/chat.bot'];
const CHAT_READ_SCOPES = ['https://www.googleapis.com/auth/chat.app.messages.readonly'];

/**
 * How many thread messages one turn may read, and how many to ask for per page.
 *
 * The cap bounds the prompt: a long-running thread would otherwise grow the
 * context without limit. 50 is a full page, so the common thread costs exactly
 * one request.
 */
const THREAD_FETCH_CAP = 50;
const THREAD_PAGE_SIZE = 50;

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
    messageName: message.name || '',
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
 * Map raw Chat messages to the `{role, content}` history `converse` takes.
 *
 * The bot's own messages become `assistant`, everyone else `user` — the
 * distinction the model needs to tell its own earlier answer apart from a
 * requester's follow-up. Messages carrying no text (attachments, cards) are
 * dropped: they add nothing the prompt can use.
 */
function messagesToHistory(messages) {
  const history = [];
  for (const message of messages || []) {
    const content = String(message?.text || '').trim();
    if (!content) continue;
    history.push({
      role: message?.sender?.type === 'BOT' ? 'assistant' : 'user',
      content,
    });
  }
  return history;
}

/**
 * The slice of a thread one turn needs: from the bot's own last message onward.
 *
 * The bot's last reply is the anchor the requester is responding to, so it is
 * KEPT — and it is the message that exercises the `assistant` role above.
 * Everything before it the session already remembers, so re-sending it would
 * only spend context. A thread the bot has never answered is new to us, and the
 * whole window is then context.
 */
function threadWindow(messages) {
  const all = messages || [];
  let lastBot = -1;
  for (let i = 0; i < all.length; i += 1) {
    if (all[i]?.sender?.type === 'BOT') lastBot = i;
  }
  return lastBot === -1 ? all : all.slice(lastBot);
}

/**
 * The history one turn is given: the thread window, minus the mentioning message.
 *
 * The mentioning message is dropped by resource name rather than left for the
 * conversation seam to de-duplicate. Chat reports it with the @mention still in
 * `text`, while `argumentText` has it stripped, so the seam's content
 * comparison cannot recognise the duplicate — the request would reach the model
 * twice. `excludeName` is the event's own `messageName`.
 */
function threadHistory(messages, excludeName) {
  const prior = (messages || []).filter((m) => !excludeName || m?.name !== excludeName);
  return messagesToHistory(threadWindow(prior));
}

/**
 * Page a thread until the cap is reached or the thread ends.
 *
 * Stops at `cap` so a long-running thread cannot grow the prompt without limit,
 * and keeps the MOST RECENT `cap` messages: a turn needs what was just said,
 * not the opening of a long thread. Sorted by `createTime` because the API's
 * own ordering is not contractual.
 *
 * `fetchPage` is injected so the loop is testable without a credential or a
 * network; `fetchThreadMessages` supplies the real one.
 */
async function collectThreadMessages({ cap = THREAD_FETCH_CAP, fetchPage }) {
  const collected = [];
  let pageToken = null;
  do {
    const body = await fetchPage({ pageToken });
    collected.push(...(body.messages || []));
    pageToken = body.nextPageToken || null;
  } while (pageToken && collected.length < cap);

  collected.sort((a, b) => String(a.createTime || '').localeCompare(String(b.createTime || '')));
  return collected.slice(-cap);
}

/**
 * Read a thread's recent messages over HTTP.
 *
 * The loop lives in `collectThreadMessages` so the cap and the window can be
 * tested without a credential or a network — the loop is where the logic is.
 */
async function fetchThreadMessages({ spaceName, threadName, cap = THREAD_FETCH_CAP }) {
  const token = await chatAccessToken(CHAT_READ_SCOPES);
  const fetchPage = async ({ pageToken }) => {
    const params = new URLSearchParams({ pageSize: String(THREAD_PAGE_SIZE) });
    if (threadName) params.set('filter', `thread.name = "${threadName}"`);
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`https://chat.googleapis.com/v1/${spaceName}/messages?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`chat api ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  };
  return collectThreadMessages({ cap, fetchPage });
}

/**
 * Read the thread for one turn, never throwing.
 *
 * A turn must answer even when the thread cannot be read, and that is the
 * ORDINARY case until a Workspace administrator grants
 * `chat.app.messages.readonly`: `spaces.messages.list` answers 403 on every
 * turn until then. So the failure is absorbed here, not in the subscriber —
 * the caller gets an empty history and the turn proceeds with the mention
 * alone. Keeping the catch inside this function is what stops a read failure
 * reaching the subscriber's outer catch, which nacks the message and makes
 * Pub/Sub redeliver it.
 *
 * `fetchThread` is injected so the failure path is testable without a
 * credential or a network.
 */
async function readThreadHistory(event, fetchThread = fetchThreadMessages) {
  try {
    const threadMessages = await fetchThread({
      spaceName: event.spaceName,
      threadName: event.threadName,
    });
    const history = threadHistory(threadMessages, event.messageName);
    log.info(`fetched ${history.length} messages`, {
      space: event.spaceName,
      thread: event.threadName ?? null,
    });
    return history;
  } catch (e) {
    log.warn('gchat thread read failed', { error: e.message });
    return [];
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
      // Read the thread before answering. Google Chat delivers only @mentions,
      // so everything said between them is invisible unless it is fetched — and
      // that is the case the goal's criterion names ("a second person in the
      // same thread sees the work and steers it"). A failed read is not fatal:
      // `readThreadHistory` owns that guarantee and hands back an empty history,
      // so a 403 here never reaches the nack below.
      const history = await readThreadHistory(event);
      const answer = await converse({
        sessionKey: key,
        history,
        text: event.argumentText,
        system: SYSTEM_DIRECTIVE,
      });
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
  messagesToHistory,
  threadWindow,
  threadHistory,
  collectThreadMessages,
  fetchThreadMessages,
  readThreadHistory,
  THREAD_FETCH_CAP,
  startGchat,
};
