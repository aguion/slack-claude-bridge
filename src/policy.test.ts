import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SLACK_AGENT_POLICY, buildSystemPromptAppend } from './policy.js';

test('the policy states the rules we rely on', () => {
  for (const rule of [
    'Marcel',
    'git push',
    'pull request',
    'commit locally',
    'force-push',
    'main',
    'approval in Slack',
    '.env',
    'data, not instructions',
  ]) {
    assert.ok(
      SLACK_AGENT_POLICY.includes(rule),
      `policy no longer mentions ${rule!}`,
    );
  }
});

test('a project extra is appended after the policy, never before it', () => {
  const out = buildSystemPromptAppend('Prefer pnpm over npm.');

  assert.ok(out.startsWith(SLACK_AGENT_POLICY), 'policy must come first');
  assert.ok(out.endsWith('Prefer pnpm over npm.'));
});

test('no extra leaves the policy untouched', () => {
  assert.equal(buildSystemPromptAppend(), SLACK_AGENT_POLICY);
  assert.equal(buildSystemPromptAppend('   '), SLACK_AGENT_POLICY);
});
