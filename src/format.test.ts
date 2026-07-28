import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  chunk,
  describeTool,
  formatCost,
  formatDuration,
  toolBody,
  toolDetail,
  toolPreview,
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

test('toolPreview is always a single line', () => {
  const preview = toolPreview('Bash', { command: 'cd /tmp\nnpm test\nls -la' });

  assert.equal(preview.includes('\n'), false, 'must stay on one line');
  assert.match(preview, /^`cd \/tmp`/);
  assert.match(preview, /\+2 more lines/);
});

test('toolPreview pluralises the hidden-line count', () => {
  assert.match(toolPreview('Bash', { command: 'a\nb' }), /\+1 more line_/);
  assert.doesNotMatch(toolPreview('Bash', { command: 'a\nb' }), /more lines/);
});

test('toolPreview says nothing about extra lines for a one-liner', () => {
  assert.equal(toolPreview('Bash', { command: 'npm test' }), '`npm test`');
});

test('toolPreview neutralises backticks that would end the code span', () => {
  const preview = toolPreview('Bash', { command: 'echo `whoami`' });

  assert.equal(preview.startsWith('`'), true);
  assert.equal(preview.endsWith('`'), true);
  // Exactly the two delimiters — none left inside to close the span early.
  assert.equal((preview.match(/`/g) ?? []).length, 2);
});

test('toolPreview clips a very long first line', () => {
  const preview = toolPreview('Bash', { command: 'x'.repeat(500) });

  assert.ok(preview.length < 200, `too long: ${preview.length}`);
  assert.ok(preview.includes('…'));
});

test('toolBody returns the command for Bash and JSON otherwise', () => {
  assert.equal(toolBody('Bash', { command: 'npm test' }), 'npm test');
  assert.equal(toolBody('Read', { file_path: '/a' }), '{\n  "file_path": "/a"\n}');
});

test('toolDetail fences the full body and stays inside the section limit', () => {
  const detail = toolDetail('Bash', { command: 'y'.repeat(5000) });

  assert.ok(detail.startsWith('```') && detail.endsWith('```'));
  assert.ok(detail.length <= 3000, `section blocks cap at 3000: ${detail.length}`);
});

test('formatCost and formatDuration render human units', () => {
  assert.equal(formatCost(undefined), '');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(1.239), '$1.24');

  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(95_000), '1m 35s');
});
