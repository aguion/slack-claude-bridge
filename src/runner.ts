import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { App } from '@slack/bolt';
import { ActivityLog } from './activity.js';
import type { ApprovalBroker } from './approvals.js';
import type { Config, ProjectConfig } from './config.js';
import type { SessionStore } from './store.js';
import { chunk, describeTool, formatCost, formatDuration } from './format.js';
import { agentEnv } from './githubauth.js';
import { classifyGitCommand } from './gitgate.js';
import { buildSystemPromptAppend } from './policy.js';

type WebClient = App['client'];

const run = promisify(execFile);

/**
 * The branch `cwd` is on, or undefined if it can't be read. Undefined is safe:
 * `classifyGitCommand` gates an unresolvable push target rather than guessing.
 */
async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : undefined;
  } catch {
    return undefined;
  }
}

export interface RunRequest {
  channel: string;
  threadTs: string;
  userId: string;
  prompt: string;
  project: ProjectConfig;
}

/**
 * Runs one Claude Code turn against a local repo and streams the result into a
 * Slack thread.
 *
 * Session continuity comes from `resume`: the first message in a thread starts
 * a fresh session, and every later message in that same thread picks it back
 * up, so follow-ups like "no, use the other helper" land in context.
 */
export class Runner {
  /** Live runs keyed by thread, so `stop` can cancel them. */
  private active = new Map<string, AbortController>();

  constructor(
    private readonly client: WebClient,
    private readonly config: Config,
    private readonly sessions: SessionStore,
    private readonly approvals: ApprovalBroker,
  ) {}

  /** Cancel the in-flight run for a thread. Returns false if none was running. */
  cancel(channel: string, threadTs: string): boolean {
    const key = `${channel}:${threadTs}`;
    const controller = this.active.get(key);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async say(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    for (const part of chunk(text)) {
      await this.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        // Claude writes standard Markdown — `**bold**`, `#` headings,
        // `[text](url)` — none of which Slack's legacy mrkdwn understands, so
        // in the plain `text` field it renders as literal punctuation. The
        // `markdown` block takes CommonMark as-is. `text` stays as the
        // notification fallback.
        text: part,
        blocks: [{ type: 'markdown', text: part }],
        // Never let Claude's output ping people.
        parse: 'none',
        link_names: false,
      });
    }
  }

  private async context(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
      blocks: [
        { type: 'context', elements: [{ type: 'mrkdwn', text }] },
      ],
    });
  }

  async run(req: RunRequest): Promise<void> {
    const key = `${req.channel}:${req.threadTs}`;
    const controller = new AbortController();
    this.active.set(key, controller);

    const resumeId = this.sessions.get(req.channel, req.threadTs);
    let sessionId = resumeId;
    let sawText = false;
    // One rolling message for this run's tool calls, instead of one message
    // (and one notification) per call. Sealed before anything else is posted
    // so the thread still reads in order.
    const activity = new ActivityLog(this.client, req.channel, req.threadTs);

    // Acknowledge immediately — agent turns can run for minutes, and silence
    // in Slack is indistinguishable from a crashed bot.
    await this.context(
      req.channel,
      req.threadTs,
      resumeId
        ? `:arrows_counterclockwise: Resuming in \`${req.project.label ?? req.project.cwd}\``
        : `:sparkles: Starting in \`${req.project.label ?? req.project.cwd}\``,
    );

    try {
      const response = query({
        prompt: req.prompt,
        options: {
          cwd: req.project.cwd,
          abortController: controller,
          maxTurns: this.config.maxTurns,
          // Scoped GitHub credential + no Slack secrets. See githubauth.ts.
          env: agentEnv(process.env, this.config.githubToken),
          // The `preset` form appends to Claude Code's own system prompt. A
          // bare string would replace it outright and lose the built-in tool
          // guidance, which is not what we want here.
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: buildSystemPromptAppend(req.project.appendSystemPrompt),
          },
          // 'auto' lets the SDK's classifier clear routine calls itself and
          // only escalates what it can't — the Slack buttons stay in place for
          // anything the classifier refuses to decide.
          permissionMode: req.project.permissionMode ?? this.config.permissionMode,
          ...(req.project.model ? { model: req.project.model } : {}),
          ...(resumeId ? { resume: resumeId } : {}),
          // Defaults to ['project'] so the repo's CLAUDE.md is loaded. Note
          // that any `permissions.allow` rule in a loaded settings file
          // pre-approves that tool inside the SDK, so `canUseTool` below never
          // runs for it and no Slack prompt appears. See README § Security.
          settingSources: this.config.settingSources,
          // Read-only tools run unattended; everything else hits the buttons.
          allowedTools: req.project.allowedTools ?? [
            'Read',
            'Glob',
            'Grep',
            'TodoWrite',
          ],
          // A PreToolUse hook is the only hard gate here: `allowedTools`
          // entries and the 'auto' classifier can both clear a call before
          // `canUseTool` is ever consulted, and a `permissions.allow` rule in
          // the repo's own settings can too. A hook runs first regardless, so
          // this is where pushing to GitHub is policed. 'deny' short-circuits
          // the call outright; 'ask' falls through to the Slack buttons below.
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  async (hookInput) => {
                    if (
                      hookInput.hook_event_name !== 'PreToolUse' ||
                      hookInput.tool_name !== 'Bash'
                    ) {
                      return { continue: true };
                    }
                    const command = (hookInput.tool_input as { command?: unknown } | null)?.command;
                    if (typeof command !== 'string') return { continue: true };

                    const verdict = classifyGitCommand(command, {
                      currentBranch: await currentBranch(req.project.cwd),
                    });
                    if (verdict.decision === 'pass') return { continue: true };

                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: verdict.decision,
                        permissionDecisionReason: verdict.reason,
                      },
                    };
                  },
                ],
              },
            ],
          },
          canUseTool: async (toolName, input, opts) =>
            this.approvals.request({
              channel: req.channel,
              threadTs: req.threadTs,
              toolName,
              input,
              title: opts.title,
              description: opts.description,
              suggestions: opts.suggestions,
              signal: opts.signal,
            }),
        },
      });

      for await (const message of response) {
        if (controller.signal.aborted) break;

        switch (message.type) {
          case 'system':
            if (message.subtype === 'init') {
              sessionId = message.session_id;
              this.sessions.set(req.channel, req.threadTs, sessionId);
            } else if (message.subtype === 'local_command_output') {
              // A local slash command (`/usage`, and skills that resolve
              // locally) bypasses the model loop entirely, so its output
              // arrives here and nowhere else. Dropping it would leave the
              // thread showing a run that started and finished in silence.
              if (message.content.trim()) {
                sawText = true;
                await activity.seal();
                await this.say(req.channel, req.threadTs, message.content);
              }
            }
            break;

          case 'assistant': {
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text.trim()) {
                sawText = true;
                await activity.seal();
                await this.say(req.channel, req.threadTs, block.text);
              } else if (block.type === 'tool_use') {
                activity.add(
                  `:wrench: \`${block.name}\` — ${describeTool(
                    block.name,
                    (block.input ?? {}) as Record<string, unknown>,
                  )}`,
                );
              }
            }
            break;
          }

          case 'result': {
            await activity.seal();
            if (message.subtype === 'success') {
              // The final `result` text repeats the last assistant turn, so
              // only post it when nothing else made it through.
              if (!sawText && message.result.trim()) {
                await this.say(req.channel, req.threadTs, message.result);
              }
              await this.context(
                req.channel,
                req.threadTs,
                `:white_check_mark: Done · ${message.num_turns} turns · ` +
                  `${formatDuration(message.duration_ms)} · ` +
                  `${formatCost(message.total_cost_usd)}`,
              );
            } else {
              await this.context(
                req.channel,
                req.threadTs,
                `:warning: Ended early (\`${message.subtype}\`). ` +
                  `Reply in this thread to continue.`,
              );
            }
            break;
          }

          default:
            // Partial messages, hook events, task updates — not surfaced.
            break;
        }
      }
    } catch (err) {
      await activity.seal();
      if (controller.signal.aborted) {
        await this.context(
          req.channel,
          req.threadTs,
          ':octagonal_sign: Stopped. The session is kept — reply here to pick it back up.',
        );
      } else {
        const detail = err instanceof Error ? err.message : String(err);
        await this.context(
          req.channel,
          req.threadTs,
          `:x: Run failed: ${detail}`,
        );
      }
    } finally {
      // The loop can `break` on abort without reaching `result` or the catch,
      // which would strand the last few tool lines unwritten. Sealing an
      // already-sealed log is a no-op.
      await activity.seal();
      // Do NOT abortAll() here — the broker is shared across threads, and
      // other threads may have prompts legitimately awaiting an answer. Each
      // pending prompt is already tied to its own run's abort signal.
      this.active.delete(key);
    }
  }
}
