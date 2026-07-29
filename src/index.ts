import pkg from '@slack/bolt';
const { App, LogLevel } = pkg;

import { loadConfig, projectFor } from './config.js';
import { InstanceLock } from './lock.js';
import { SessionStore, ThreadQueue } from './store.js';
import { ApprovalBroker, type Decision } from './approvals.js';
import { Runner } from './runner.js';
import { toolDetail } from './format.js';

const config = loadConfig();

// Before opening a socket: a second connection would silently take half the
// events, so refuse to be the second bridge rather than corrupt the traffic.
const lock = new InstanceLock(config.stateDir);
try {
  lock.acquire();
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const app = new App({
  token: config.botToken,
  appToken: config.appToken,
  socketMode: true,
  logLevel:
    process.env.LOG_LEVEL === 'debug' ? LogLevel.DEBUG : LogLevel.INFO,
});

const sessions = new SessionStore(config.stateDir);
const queue = new ThreadQueue();
const approvals = new ApprovalBroker(
  app.client,
  config.allowedUsers,
  config.approvalTimeoutSec,
);
const runner = new Runner(app.client, config, sessions, approvals);

/**
 * Message subtypes we still treat as a user talking to us. Everything else
 * (joins, topic changes, edits, deletions) is noise.
 */
const HANDLED_SUBTYPES = new Set(['file_share', 'thread_broadcast']);

/** Strip the leading `<@U123>` mention from an app_mention body. */
function stripMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, '').trim();
}

interface Incoming {
  channel: string;
  threadTs: string;
  user: string;
  text: string;
}

async function handleIncoming(msg: Incoming): Promise<void> {
  if (!config.allowedUsers.has(msg.user)) {
    console.warn(`Ignoring message from non-allowlisted user ${msg.user}`);
    return;
  }

  const text = msg.text.trim();
  if (!text) return;

  const key = `${msg.channel}:${msg.threadTs}`;

  // --- control words, handled before anything reaches the agent ---
  const lower = text.toLowerCase();

  if (lower === 'stop' || lower === 'cancel') {
    // Drop the backlog first: cancelling only the in-flight run would let the
    // next queued message start the moment this one aborts.
    queue.cancelPending(key);
    const stopped = runner.cancel(msg.channel, msg.threadTs);
    await app.client.chat.postMessage({
      channel: msg.channel,
      thread_ts: msg.threadTs,
      text: stopped
        ? 'Stopping… any queued messages in this thread are dropped too.'
        : 'Nothing is running in this thread.',
    });
    return;
  }

  if (lower === 'reset' || lower === 'new') {
    queue.cancelPending(key);
    sessions.clear(msg.channel, msg.threadTs);
    await app.client.chat.postMessage({
      channel: msg.channel,
      thread_ts: msg.threadTs,
      text: 'Session cleared. The next message starts fresh.',
    });
    return;
  }

  const project = projectFor(config, msg.channel);
  if (!project) {
    await app.client.chat.postMessage({
      channel: msg.channel,
      thread_ts: msg.threadTs,
      text:
        `No project is mapped to this channel (\`${msg.channel}\`). Add it to ` +
        `projects.json and restart the bridge.`,
    });
    return;
  }

  // Claim the thread now rather than when the SDK reports a session ID, so a
  // reply typed while the agent is still starting up isn't dropped.
  sessions.claim(msg.channel, msg.threadTs);

  // One run at a time per thread — concurrent runs would race on the same
  // resumed session and scramble its history.
  await queue.run(key, () =>
    runner.run({
      channel: msg.channel,
      threadTs: msg.threadTs,
      userId: msg.user,
      prompt: text,
      project,
    }),
  );
}

// Mentions in a channel start (or continue) a thread. Slack does not dispatch
// app_mention for DMs — those arrive as message.im below.
app.event('app_mention', async ({ event }) => {
  const e = event as unknown as {
    channel: string;
    ts: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    bot_id?: string;
  };
  if (e.bot_id || !e.user) return;
  await handleIncoming({
    channel: e.channel,
    threadTs: e.thread_ts ?? e.ts,
    user: e.user,
    text: stripMention(e.text ?? ''),
  });
});

// Plain replies inside a thread we already own, plus DMs. This is what makes
// the conversation feel like a session instead of a series of one-shots.
app.message(async ({ message }) => {
  const m = message as unknown as {
    channel: string;
    channel_type?: string;
    ts: string;
    thread_ts?: string;
    user?: string;
    text?: string;
    bot_id?: string;
    subtype?: string;
  };

  if (m.bot_id || !m.user || !m.text) return;
  if (m.subtype && !HANDLED_SUBTYPES.has(m.subtype)) return;

  const isDm = m.channel_type === 'im';
  const threadTs = m.thread_ts ?? m.ts;

  if (isDm && !config.allowDms) {
    // Say so rather than ignoring, but only to people who could otherwise use
    // the bot — everyone else stays unaware it's listening at all.
    if (config.allowedUsers.has(m.user)) {
      await app.client.chat.postMessage({
        channel: m.channel,
        text:
          'DMs are disabled for this bridge. Mention me in a mapped channel ' +
          'instead — a channel maps to a specific repo, a DM does not.',
      });
    }
    return;
  }

  // In channels, only react to threads we've already started — otherwise the
  // bot would answer every message in the room.
  if (!isDm && !sessions.has(m.channel, threadTs)) return;

  // A threaded reply that also @-mentions us would otherwise run twice. Safe
  // to skip this check in DMs, where app_mention never fires.
  if (!isDm && /<@[^>]+>/.test(m.text)) return;

  await handleIncoming({
    channel: m.channel,
    threadTs,
    user: m.user,
    text: m.text,
  });
});

// "Show full input" — the prompt only carries one line, so the rest lives in a
// modal rather than in the thread where it would bury the buttons.
app.action('tool_details', async ({ ack, body }) => {
  await ack();
  const b = body as {
    trigger_id?: string;
    user?: { id?: string };
    channel?: { id?: string };
    actions?: { value?: string }[];
  };
  const nonce = b.actions?.[0]?.value;
  const userId = b.user?.id;
  if (!nonce || !userId || !b.trigger_id) return;
  if (!config.allowedUsers.has(userId)) return;

  const call = approvals.peek(nonce);
  if (!call) {
    if (b.channel?.id) {
      await app.client.chat
        .postEphemeral({
          channel: b.channel.id,
          user: userId,
          text: 'That prompt has already been decided, so its input is gone.',
        })
        .catch(() => undefined);
    }
    return;
  }

  await app.client.views
    .open({
      trigger_id: b.trigger_id,
      view: {
        type: 'modal',
        // Slack caps modal titles at 24 characters.
        title: { type: 'plain_text', text: call.toolName.slice(0, 24) },
        close: { type: 'plain_text', text: 'Close' },
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: toolDetail(call.toolName, call.input),
            },
          },
        ],
      },
    })
    .catch((err) => console.error('views.open failed:', err));
});

// Approval buttons.
for (const [actionId, decision] of Object.entries({
  tool_approve: 'approve',
  tool_always: 'always',
  tool_deny: 'deny',
} satisfies Record<string, Decision>)) {
  app.action(actionId, async ({ ack, body, payload }) => {
    await ack();
    const nonce = (payload as { value?: string }).value;
    const b = body as {
      user?: { id?: string };
      channel?: { id?: string };
      message?: { thread_ts?: string; ts?: string };
    };
    const userId = b.user?.id;
    if (!nonce || !userId) return;

    const outcome = approvals.handleDecision(nonce, decision as Decision, userId);
    if (outcome === 'settled') return;

    // Tell the clicker why nothing happened. A silent no-op looks like a bug,
    // and stale buttons outlive any restart of the bridge.
    const channel = b.channel?.id;
    if (!channel) return;
    await app.client.chat
      .postEphemeral({
        channel,
        user: userId,
        thread_ts: b.message?.thread_ts ?? b.message?.ts,
        text:
          outcome === 'stale'
            ? 'That approval prompt is no longer active — the run ended or the bridge restarted.'
            : 'You are not on this bridge’s allowlist, so that button does nothing.',
      })
      .catch(() => undefined);
  });
}

app.error(async (error) => {
  console.error('Bolt error:', error);
});

await app.start();

console.log(
  `Slack ↔ Claude Code bridge running (Socket Mode), pid ${process.pid}.`,
);
console.log(`  projects:  ${Object.keys(config.projects).join(', ')}`);
console.log(`  allowlist: ${[...config.allowedUsers].join(', ')}`);
console.log(`  state:     ${config.stateDir}`);
console.log(`  approvals: ${config.permissionMode}`);
console.log(`  dms:       ${config.allowDms ? 'allowed' : 'disabled'}`);
console.log(
  `  settings:  ${
    config.settingSources.length
      ? config.settingSources.join(', ')
      : '(none — CLAUDE.md not loaded)'
  }`,
);

let shuttingDown = false;
const shutdown = async (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nShutting down…');
  approvals.abortAll('The bridge is shutting down.');
  // Let the prompt rewrites land so no thread is left showing live buttons.
  await approvals.flush();
  await app.stop().catch(() => undefined);
  lock.release();
  process.exit(code);
};

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

// Without these a stray rejection or throw kills the bridge silently, and the
// thread just stops replying with no explanation anywhere.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  void shutdown(1);
});
