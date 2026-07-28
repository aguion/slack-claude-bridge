import { randomUUID } from 'node:crypto';
import type { App } from '@slack/bolt';
import type {
  PermissionResult,
  PermissionUpdate,
} from '@anthropic-ai/claude-agent-sdk';
import { describeTool, toolDetail } from './format.js';

type WebClient = App['client'];

export type Decision = 'approve' | 'always' | 'deny';

/**
 * What happened to a button click. `stale` means the prompt is no longer
 * pending — usually because the bridge restarted, or the run already ended.
 */
export type DecisionOutcome = 'settled' | 'stale' | 'forbidden';

interface Pending {
  /** Settles the promise exactly once and rewrites the Slack prompt. */
  settle: (result: PermissionResult, note: string) => void;
  toolName: string;
  suggestions: PermissionUpdate[];
}

export interface ApprovalRequest {
  channel: string;
  threadTs: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Prompt sentence supplied by the SDK, when present. */
  title?: string;
  description?: string;
  suggestions?: PermissionUpdate[];
  signal: AbortSignal;
}

/**
 * Renders Claude's permission prompts as Block Kit buttons in the Slack thread
 * and blocks the agent until somebody clicks one.
 *
 * Every prompt is fail-closed: an abort, a timeout, or no answer at all
 * resolves to `deny`. The agent never proceeds because nobody replied.
 */
export class ApprovalBroker {
  private pending = new Map<string, Pending>();
  /** In-flight prompt rewrites, so shutdown can wait for them to land. */
  private updates = new Set<Promise<void>>();

  constructor(
    private readonly client: WebClient,
    private readonly allowedUsers: Set<string>,
    private readonly timeoutSec: number,
  ) {}

  async request(req: ApprovalRequest): Promise<PermissionResult> {
    const nonce = randomUUID();
    const summary = describeTool(req.toolName, req.input);

    const posted = await this.client.chat.postMessage({
      channel: req.channel,
      thread_ts: req.threadTs,
      text: `Approval needed: ${req.toolName}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*Approval needed* — \`${req.toolName}\`\n` +
              (req.title ? `${req.title}\n` : '') +
              (req.description ? `_${req.description}_\n` : '') +
              toolDetail(req.toolName, req.input),
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              action_id: 'tool_approve',
              style: 'primary',
              text: { type: 'plain_text', text: 'Approve once' },
              value: nonce,
            },
            {
              type: 'button',
              action_id: 'tool_always',
              text: { type: 'plain_text', text: 'Always in this session' },
              value: nonce,
            },
            {
              type: 'button',
              action_id: 'tool_deny',
              style: 'danger',
              text: { type: 'plain_text', text: 'Deny' },
              value: nonce,
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `Auto-denies in ${this.timeoutSec}s · ${summary}`,
            },
          ],
        },
      ],
    });

    const messageTs = posted.ts as string;

    return new Promise<PermissionResult>((resolve) => {
      let done = false;

      const settle = (result: PermissionResult, note: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        this.pending.delete(nonce);
        this.finalise(req.channel, messageTs, req.toolName, note);
        resolve(result);
      };

      const timer = setTimeout(() => {
        settle(
          {
            behavior: 'deny',
            message:
              'Nobody answered the approval prompt in Slack before it timed ' +
              'out. Ask again if this step is still needed.',
          },
          '⏳ Timed out — denied',
        );
      }, this.timeoutSec * 1000);

      const onAbort = () => {
        settle(
          { behavior: 'deny', message: 'The run was cancelled from Slack.' },
          '🛑 Cancelled',
        );
      };
      req.signal.addEventListener('abort', onAbort, { once: true });

      this.pending.set(nonce, {
        settle,
        toolName: req.toolName,
        suggestions: req.suggestions ?? [],
      });
    });
  }

  /** Called by the Bolt action handler when a button is clicked. */
  handleDecision(
    nonce: string,
    decision: Decision,
    userId: string,
  ): DecisionOutcome {
    const entry = this.pending.get(nonce);
    // Stale button: the run ended, or the bridge restarted and lost the
    // in-memory prompt. The caller tells the clicker rather than no-op'ing.
    if (!entry) return 'stale';

    // Someone off the allowlist clicked. Ignore rather than settle, so the
    // owner can still decide before the timeout fires.
    if (!this.allowedUsers.has(userId)) return 'forbidden';

    if (decision === 'deny') {
      entry.settle(
        { behavior: 'deny', message: `Denied by <@${userId}> in Slack.` },
        `❌ Denied by <@${userId}>`,
      );
      return 'settled';
    }

    const grantForSession =
      decision === 'always' && entry.suggestions.length > 0;

    entry.settle(
      {
        behavior: 'allow',
        ...(grantForSession ? { updatedPermissions: entry.suggestions } : {}),
      },
      grantForSession
        ? `✅ Approved by <@${userId}> — won't ask again this session`
        : `✅ Approved by <@${userId}>`,
    );
    return 'settled';
  }

  /** Deny everything outstanding — used when a run is cancelled or crashes. */
  abortAll(reason = 'Run ended.'): void {
    for (const entry of [...this.pending.values()]) {
      entry.settle(
        { behavior: 'deny', message: reason },
        '🛑 Run ended before a decision',
      );
    }
  }

  /** Wait for the prompt rewrites queued by `settle` to reach Slack. */
  async flush(): Promise<void> {
    await Promise.all([...this.updates]);
  }

  /** Replace the prompt with a static record of what was decided. */
  private finalise(
    channel: string,
    ts: string,
    toolName: string,
    note: string,
  ): void {
    const update: Promise<void> = this.client.chat
      .update({
        channel,
        ts,
        text: note,
        blocks: [
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `${note} · \`${toolName}\`` }],
          },
        ],
      })
      .then(
        () => undefined,
        // A failed cosmetic update must never block the agent.
        () => undefined,
      )
      .finally(() => {
        this.updates.delete(update);
      });

    this.updates.add(update);
  }
}
