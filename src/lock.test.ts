import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { InstanceLock } from './lock.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-lock-'));
}

test('the first bridge takes the lock and records its pid', () => {
  const lock = new InstanceLock(scratch());
  lock.acquire();

  assert.equal(readFileSync(lock.path, 'utf8').trim(), String(process.pid));
  lock.release();
  assert.equal(existsSync(lock.path), false);
});

test('a second bridge is refused while the first holds it', () => {
  const dir = scratch();
  const first = new InstanceLock(dir);
  first.acquire();

  // Same pid would look like "ours", so plant a different live pid: pid 1
  // always exists and is never us.
  writeFileSync(join(dir, 'bridge.pid'), '1\n');

  const second = new InstanceLock(dir);
  assert.throws(() => second.acquire(), /already running \(pid 1\)/);

  // The refusal must not have destroyed the incumbent's lock file.
  assert.equal(existsSync(join(dir, 'bridge.pid')), true);
});

test('the error tells you how to stop the other bridge', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'bridge.pid'), '1\n');

  assert.throws(() => new InstanceLock(dir).acquire(), (err: Error) => {
    assert.match(err.message, /kill 1/);
    assert.match(err.message, /Slack splits events across both/);
    return true;
  });
});

test('a pidfile from a crashed bridge is reclaimed, not fatal', () => {
  const dir = scratch();
  // A PID that cannot be running: the kernel never assigns 0x7FFFFFFF.
  writeFileSync(join(dir, 'bridge.pid'), '2147483647\n');

  const lock = new InstanceLock(dir);
  lock.acquire();

  assert.equal(readFileSync(lock.path, 'utf8').trim(), String(process.pid));
});

test('a corrupt pidfile is reclaimed rather than wedging startup', () => {
  const dir = scratch();
  writeFileSync(join(dir, 'bridge.pid'), 'not-a-pid\n');

  const lock = new InstanceLock(dir);
  lock.acquire();

  assert.equal(readFileSync(lock.path, 'utf8').trim(), String(process.pid));
});

test('release does not remove a lock a successor already holds', () => {
  const dir = scratch();
  const lock = new InstanceLock(dir);
  lock.acquire();

  // Simulate a successor having taken over the file.
  writeFileSync(join(dir, 'bridge.pid'), '1\n');
  lock.release();

  assert.equal(readFileSync(join(dir, 'bridge.pid'), 'utf8').trim(), '1');
});

test('release is safe when the lock was never acquired', () => {
  const lock = new InstanceLock(scratch());
  assert.doesNotThrow(() => lock.release());
});
