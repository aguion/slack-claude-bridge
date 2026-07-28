import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

interface SessionRecord {
  id: string;
  /** Epoch ms of the last write, used to prune the oldest threads. */
  updatedAt: number;
}

/** Keep the state file bounded; oldest threads fall off first. */
const MAX_SESSIONS = 500;

/**
 * Maps a Slack thread to a Claude Code session so follow-up replies resume the
 * same conversation instead of starting cold.
 *
 * Deliberately a small JSON file rather than a database: the whole point of
 * this bridge is that it runs on your laptop with no infrastructure.
 */
export class SessionStore {
  private readonly file: string;
  private data: Record<string, SessionRecord>;

  /**
   * Threads we've accepted work for but haven't got a session ID back for yet.
   * Without this there's a window between "user @-mentions the bot" and the
   * SDK's `init` message where a fast thread reply looks like it belongs to a
   * thread we don't own, and gets silently dropped.
   */
  private claimed = new Set<string>();

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'sessions.json');
    this.data = this.read();
  }

  private read(): Record<string, SessionRecord> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
    if (typeof raw !== 'object' || raw === null) return {};

    const out: Record<string, SessionRecord> = {};
    for (const [key, value] of Object.entries(raw)) {
      // v1 wrote a bare session ID string; keep those readable.
      if (typeof value === 'string') {
        out[key] = { id: value, updatedAt: 0 };
      } else if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as SessionRecord).id === 'string'
      ) {
        const rec = value as SessionRecord;
        out[key] = {
          id: rec.id,
          updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
        };
      }
    }
    return out;
  }

  private flush(): void {
    // Write-then-rename so a crash mid-write cannot truncate the file.
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }

  private prune(): void {
    const keys = Object.keys(this.data);
    if (keys.length <= MAX_SESSIONS) return;
    keys
      .sort((a, b) => this.data[a]!.updatedAt - this.data[b]!.updatedAt)
      .slice(0, keys.length - MAX_SESSIONS)
      .forEach((key) => delete this.data[key]);
  }

  static key(channel: string, threadTs: string): string {
    return `${channel}:${threadTs}`;
  }

  get(channel: string, threadTs: string): string | undefined {
    return this.data[SessionStore.key(channel, threadTs)]?.id;
  }

  set(channel: string, threadTs: string, sessionId: string): void {
    const key = SessionStore.key(channel, threadTs);
    this.data[key] = { id: sessionId, updatedAt: Date.now() };
    this.claimed.delete(key);
    this.prune();
    this.flush();
  }

  /**
   * Mark a thread as ours before the agent has produced a session ID, so
   * replies that arrive during startup aren't mistaken for unrelated chatter.
   */
  claim(channel: string, threadTs: string): void {
    this.claimed.add(SessionStore.key(channel, threadTs));
  }

  clear(channel: string, threadTs: string): void {
    const key = SessionStore.key(channel, threadTs);
    this.claimed.delete(key);
    if (key in this.data) {
      delete this.data[key];
      this.flush();
    }
  }

  /** True if this thread is one we've already accepted work in. */
  has(channel: string, threadTs: string): boolean {
    const key = SessionStore.key(channel, threadTs);
    return this.claimed.has(key) || key in this.data;
  }
}

/**
 * Serialises work per thread. Two messages fired into the same thread would
 * otherwise race on the same resumed session and corrupt its history.
 */
export class ThreadQueue {
  private chains = new Map<string, Promise<unknown>>();
  /**
   * Bumped by `cancelPending`. A task compares the generation it was enqueued
   * under against the current one and skips itself if they differ, so `stop`
   * drops the backlog instead of just cancelling the message in flight.
   */
  private generations = new Map<string, number>();

  /** Resolves to `undefined` if the task was cancelled before it started. */
  run<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
    const enqueuedAt = this.generations.get(key) ?? 0;
    const guarded = async (): Promise<T | undefined> => {
      if ((this.generations.get(key) ?? 0) !== enqueuedAt) return undefined;
      return task();
    };

    const prior = this.chains.get(key) ?? Promise.resolve();
    const next = prior.then(guarded, guarded);

    // Keep the chain alive but never let a rejection poison the next task, and
    // drop the entry once the thread goes idle so the map doesn't grow forever.
    let settled: Promise<void>;
    settled = next.then(
      () => {
        if (this.chains.get(key) === settled) this.chains.delete(key);
      },
      () => {
        if (this.chains.get(key) === settled) this.chains.delete(key);
      },
    );
    this.chains.set(key, settled);

    return next;
  }

  /**
   * Drop everything queued for this thread that hasn't started yet. The task
   * already running is unaffected — cancel that through its abort controller.
   */
  cancelPending(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  /** Number of threads with work queued or running. Exposed for tests. */
  get activeThreads(): number {
    return this.chains.size;
  }
}
