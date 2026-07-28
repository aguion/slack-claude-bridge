import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { SessionStore, ThreadQueue } from './store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'scb-test-'));
}

test('SessionStore round-trips a session across instances', () => {
  const dir = tempDir();
  new SessionStore(dir).set('C1', '111.1', 'sess-a');

  const reopened = new SessionStore(dir);
  assert.equal(reopened.get('C1', '111.1'), 'sess-a');
  assert.ok(reopened.has('C1', '111.1'));
});

test('SessionStore reads the v1 bare-string format', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ 'C1:111.1': 'legacy' }));

  assert.equal(new SessionStore(dir).get('C1', '111.1'), 'legacy');
});

test('SessionStore survives a corrupt state file', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'sessions.json'), 'not json{');

  const store = new SessionStore(dir);
  assert.equal(store.get('C1', '111.1'), undefined);
});

test('a claimed thread is owned before any session ID exists', () => {
  const store = new SessionStore(tempDir());

  assert.equal(store.has('C1', '111.1'), false);
  store.claim('C1', '111.1');
  assert.ok(store.has('C1', '111.1'), 'claim should mark the thread as ours');
  // Still no resumable session — the agent has not reported one yet.
  assert.equal(store.get('C1', '111.1'), undefined);
});

test('clear releases both the claim and the stored session', () => {
  const store = new SessionStore(tempDir());
  store.claim('C1', '111.1');
  store.set('C1', '111.1', 'sess-a');

  store.clear('C1', '111.1');
  assert.equal(store.has('C1', '111.1'), false);
  assert.equal(store.get('C1', '111.1'), undefined);
});

test('SessionStore prunes the oldest threads past the cap', () => {
  const dir = tempDir();
  const store = new SessionStore(dir);
  for (let i = 0; i < 520; i++) store.set('C1', `ts-${i}`, `sess-${i}`);

  const onDisk = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'));
  assert.equal(Object.keys(onDisk).length, 500);
  assert.equal(store.get('C1', 'ts-519'), 'sess-519', 'newest kept');
  assert.equal(store.get('C1', 'ts-0'), undefined, 'oldest pruned');
});

test('ThreadQueue runs one task at a time per thread, in order', async () => {
  const queue = new ThreadQueue();
  const events: string[] = [];

  const task = (name: string) => async () => {
    events.push(`start:${name}`);
    await new Promise((r) => setTimeout(r, 5));
    events.push(`end:${name}`);
  };

  await Promise.all([
    queue.run('k', task('a')),
    queue.run('k', task('b')),
  ]);

  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('ThreadQueue keeps separate threads concurrent', async () => {
  const queue = new ThreadQueue();
  let running = 0;
  let peak = 0;

  const task = async () => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
  };

  await Promise.all([queue.run('a', task), queue.run('b', task)]);
  assert.equal(peak, 2);
});

test('a rejected task does not poison the next one', async () => {
  const queue = new ThreadQueue();
  const failed = queue.run('k', async () => {
    throw new Error('boom');
  });
  await assert.rejects(failed, /boom/);

  assert.equal(await queue.run('k', async () => 'ok'), 'ok');
});

test('cancelPending drops queued work but not the running task', async () => {
  const queue = new ThreadQueue();
  const ran: string[] = [];
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((r) => (releaseFirst = r));

  const first = queue.run('k', async () => {
    ran.push('first');
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
  });
  const second = queue.run('k', async () => {
    ran.push('second');
  });

  await firstStarted;
  queue.cancelPending('k');

  await first;
  assert.equal(await second, undefined, 'cancelled task resolves undefined');
  assert.deepEqual(ran, ['first'], 'queued task must not run');
});

test('work enqueued after a cancel still runs', async () => {
  const queue = new ThreadQueue();
  queue.cancelPending('k');
  assert.equal(await queue.run('k', async () => 'ok'), 'ok');
});

test('ThreadQueue forgets threads once they go idle', async () => {
  const queue = new ThreadQueue();
  await queue.run('k', async () => 'ok');
  // Let the bookkeeping continuation settle.
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.activeThreads, 0);
});
