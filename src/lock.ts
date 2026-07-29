import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Single-instance guard.
 *
 * Two bridges on the same Slack app is not a harmless duplicate: Slack
 * load-balances Socket Mode events across every open connection, so a second
 * process silently takes roughly half of all traffic. If it is running older
 * code or a stale allowlist, the symptom is a bot that works intermittently
 * and ignores people at random — with nothing in the log of the process you
 * happen to be watching.
 *
 * `open(…, 'wx')` is the atomic part: create-if-absent, fail if present. A
 * pidfile left behind by a crash is detected by probing the recorded PID and
 * reclaimed, so a hard kill never wedges the next start.
 */
export class InstanceLock {
  private readonly file: string;
  private held = false;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'bridge.pid');
  }

  get path(): string {
    return this.file;
  }

  /** Throws if another live bridge already holds the lock. */
  acquire(): void {
    // Two passes at most: the first can legitimately lose to a stale pidfile,
    // which we then clear. A second EEXIST means a live owner or a real race.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.file, 'wx');
        try {
          writeSync(fd, `${process.pid}\n`);
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

        const owner = this.readOwner();
        if (owner !== undefined && owner !== process.pid && isAlive(owner)) {
          throw new Error(
            `another bridge is already running (pid ${owner}).\n` +
              `  Slack splits events across both, so they would each answer ` +
              `part of the traffic.\n` +
              `  Stop it first:  kill ${owner}\n` +
              `  Lock file:      ${this.file}`,
          );
        }
        // Stale (owner gone, or unreadable garbage) — reclaim it.
        try {
          unlinkSync(this.file);
        } catch {
          // Someone else got there first; the retry will sort it out.
        }
      }
    }
    throw new Error(
      `could not acquire ${this.file} — another bridge is starting at the same moment`,
    );
  }

  /** Best-effort release. Safe to call when the lock was never taken. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    try {
      // Only remove it if it is still ours, so we never delete the lock a
      // successor has already taken.
      if (this.readOwner() === process.pid) unlinkSync(this.file);
    } catch {
      // Already gone, or not ours to remove.
    }
  }

  private readOwner(): number | undefined {
    try {
      const pid = Number(readFileSync(this.file, 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Signal 0 probes for existence without delivering anything. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
