import type { App } from '@slack/bolt';

type WebClient = App['client'];

/** Slack's section/context text limit is 3000; leave room for the header line. */
const MAX_CHARS = 2800;

/** Tool lines kept visible before the list starts collapsing from the top. */
const MAX_LINES = 12;

/**
 * Slack rate-limits `chat.update` per channel, and a tool burst can fire far
 * faster than that. Updates are coalesced onto this interval: the message may
 * lag a call or two behind, but it never 429s and never drops the final state
 * (`seal` always writes what's outstanding).
 */
const MIN_INTERVAL_MS = 1200;

/**
 * One rolling Slack message for a run's tool-call activity.
 *
 * A single turn can make 100 tool calls. Posting one message each means 100
 * notifications for what is really one unit of work, which is what this
 * replaces: the first call posts a message, and every later call rewrites
 * THAT message with `chat.update` — which Slack does not re-notify on.
 *
 * The message is sealed (and a fresh one started) whenever the agent says
 * something, so a thread still reads chronologically: activity, reply, more
 * activity — rather than one message mutating above text that came after it.
 */
export class ActivityLog {
  private lines: string[] = [];
  private ts: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** All Slack writes run through this chain so two flushes can't interleave. */
  private chain: Promise<void> = Promise.resolve();
  private lastWritten = '';
  private lastFlush = 0;

  constructor(
    private readonly client: WebClient,
    private readonly channel: string,
    private readonly threadTs: string,
    private readonly minIntervalMs: number = MIN_INTERVAL_MS,
  ) {}

  /** Record a tool call. Never throws and never blocks the caller. */
  add(line: string): void {
    this.lines.push(line);
    if (this.timer) return; // a write is already queued; it'll pick this up
    const wait = Math.max(0, this.minIntervalMs - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.chain = this.chain.then(() => this.write());
    }, wait);
  }

  /**
   * Write anything outstanding and stop reusing this message, so the next
   * `add` opens a new one. Awaited at the points where ordering matters —
   * before assistant text and before the run's closing line.
   */
  async seal(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.chain = this.chain.then(() => this.write());
    await this.chain;
    this.ts = null;
    this.lines = [];
    this.lastWritten = '';
  }

  private async write(): Promise<void> {
    if (this.lines.length === 0) return;
    const body = this.render();
    if (body === this.lastWritten) return;
    try {
      if (this.ts === null) {
        const posted = await this.client.chat.postMessage({
          channel: this.channel,
          thread_ts: this.threadTs,
          text: body,
          blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: body }] }],
        });
        this.ts = (posted.ts as string | undefined) ?? null;
      } else {
        await this.client.chat.update({
          channel: this.channel,
          ts: this.ts,
          text: body,
          blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: body }] }],
        });
      }
      this.lastWritten = body;
    } catch {
      // Purely cosmetic: a failed post or update must never break the run.
    }
    this.lastFlush = Date.now();
  }

  /** Newest calls win: an old call scrolling off matters less than the tail. */
  private render(): string {
    const shown = this.lines.slice(-MAX_LINES);
    const hidden = this.lines.length - shown.length;
    const head =
      hidden > 0 ? `_…${hidden} earlier call${hidden === 1 ? '' : 's'}_\n` : '';
    const body = head + shown.join('\n');
    return body.length > MAX_CHARS ? `${body.slice(0, MAX_CHARS - 1)}…` : body;
  }
}
