import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chunk,
  describeTool,
  formatCost,
  formatDuration,
  truncate,
} from './format.js';

test('chunk leaves short text alone', () => {
  assert.deepEqual(chunk('hello'), ['hello']);
});

test('chunk splits past the limit and keeps every character', () => {
  const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
  const parts = chunk(text, 100);

  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= 120, part.length.toString());
  assert.equal(parts.join('\n').replace(/\n+/g, '\n'), text.replace(/\n+/g, '\n'));
});

test('chunk never produces an unbalanced code fence', () => {
  const body = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const parts = chunk(`Here you go:\n\n\`\`\`ts\n${body}\n\`\`\`\n`, 200);

  assert.ok(parts.length > 1);
  for (const part of parts) {
    const fences = part.match(/^```/gm) ?? [];
    assert.equal(fences.length % 2, 0, `unbalanced fence in: ${part}`);
  }
});

test('chunk carries the fence language onto continuation chunks', () => {
  const body = Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`).join('\n');
  const parts = chunk(`\`\`\`ts\n${body}\n\`\`\``, 200);

  assert.ok(parts.length > 1);
  assert.ok(parts[1]!.startsWith('```ts'), parts[1]);
});

test('truncate marks what it cut', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc… (6 chars)');
});

test('describeTool summarises the tools we special-case', () => {
  assert.equal(describeTool('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(describeTool('Read', { file_path: '/tmp/a.ts' }), '/tmp/a.ts');
  assert.equal(describeTool('Write', { file_path: '/a', content: 'x\ny' }), '/a (2 lines)');
  assert.equal(describeTool('Grep', { pattern: 'todo', path: 'src' }), 'todo in src');
});

test('describeTool falls back to JSON for unknown tools', () => {
  assert.equal(describeTool('Mystery', { a: 1 }), '{"a":1}');
});

test('describeTool tolerates missing and non-string fields', () => {
  assert.equal(describeTool('Bash', {}), '(no command)');
  assert.equal(describeTool('Read', { file_path: 42 }), '(no path)');
});

test('formatCost and formatDuration render human units', () => {
  assert.equal(formatCost(undefined), '');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(1.239), '$1.24');

  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(95_000), '1m 35s');
});
