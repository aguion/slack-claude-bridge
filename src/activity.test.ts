import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ActivityLog } from './activity.js';

interface Call { method: string; ts?: string; text: string }

function fakeClient(opts: { failUpdate?: boolean } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const client = {
    chat: {
      postMessage: async (a: Record<string, unknown>) => {
        calls.push({ method: 'post', text: a.text as string });
        return { ts: `ts-${++seq}` };
      },
      update: async (a: Record<string, unknown>) => {
        if (opts.failUpdate) throw new Error('rate limited');
        calls.push({ method: 'update', ts: a.ts as string, text: a.text as string });
        return {};
      },
    },
  };
  // The real WebClient has a far wider surface; the log only touches these two.
  return { client: client as never, calls };
}

test('a burst of tool calls posts once and updates that same message', async () => {
  const { client, calls } = fakeClient();
  const log = new ActivityLog(client, 'C1', '111.1', 0);

  log.add('one');
  await log.seal();
  assert.deepEqual(calls.map((c) => c.method), ['post']);

  const log2 = new ActivityLog(client, 'C1', '111.1', 0);
  log2.add('a');
  await log2.seal();
  log2.add('b');
  log2.add('c');
  await log2.seal();

  const posts = calls.filter((c) => c.method === 'post').length;
  assert.equal(posts, 3, 'one post per sealed message, not per tool call');
});

test('later calls update rather than post again', async () => {
  const { client, calls } = fakeClient();
  const log = new ActivityLog(client, 'C1', '111.1', 0);

  log.add('first');
  await log.seal();

  // A fresh log reuses one message across many adds without sealing between.
  const log2 = new ActivityLog(client, 'C1', '111.1', 0);
  log2.add('a');
  await new Promise((r) => setTimeout(r, 5));
  log2.add('b');
  await new Promise((r) => setTimeout(r, 5));
  log2.add('c');
  await log2.seal();

  const after = calls.slice(1);
  assert.equal(after[0].method, 'post', 'first add posts');
  assert.ok(after.slice(1).every((c) => c.method === 'update'), 'rest update');
  const targets = new Set(after.slice(1).map((c) => c.ts));
  assert.equal(targets.size, 1, 'every update rewrites the same message');
  assert.equal(after.at(-1)!.text, 'a\nb\nc', 'the message accumulates');
});

test('sealing ends the message so the next add starts a new one', async () => {
  const { client, calls } = fakeClient();
  const log = new ActivityLog(client, 'C1', '111.1', 0);

  log.add('before reply');
  await log.seal();
  log.add('after reply');
  await log.seal();

  assert.deepEqual(calls.map((c) => c.method), ['post', 'post']);
  assert.equal(calls[1].text, 'after reply', 'the new message starts empty');
});

test('a long run collapses the oldest calls instead of growing forever', async () => {
  const { client, calls } = fakeClient();
  const log = new ActivityLog(client, 'C1', '111.1', 0);

  for (let i = 1; i <= 40; i++) log.add(`call ${i}`);
  await log.seal();

  const text = calls.at(-1)!.text;
  assert.match(text, /^_…28 earlier calls_/);
  assert.ok(text.includes('call 40'), 'the newest call is visible');
  assert.ok(!text.includes('call 1\n'), 'the oldest scrolled off');
  assert.ok(text.length <= 2800);
});

test('a Slack failure is swallowed so it cannot break the run', async () => {
  const { client } = fakeClient({ failUpdate: true });
  const log = new ActivityLog(client, 'C1', '111.1', 0);

  log.add('a');
  await new Promise((r) => setTimeout(r, 5));
  log.add('b');
  await log.seal(); // must not reject
});

test('nothing is posted when no tool ever ran', async () => {
  const { client, calls } = fakeClient();
  const log = new ActivityLog(client, 'C1', '111.1', 0);
  await log.seal();
  assert.equal(calls.length, 0);
});
