import assert from 'node:assert/strict';
import { test } from 'node:test';

import { agentEnv } from './githubauth.js';

test('the bridge\'s Slack secrets never reach the agent', () => {
  const env = agentEnv({
    PATH: '/usr/bin',
    SLACK_BOT_TOKEN: 'xoxb-secret',
    SLACK_APP_TOKEN: 'xapp-secret',
    SLACK_SIGNING_SECRET: 'sig',
  });

  assert.equal(env.PATH, '/usr/bin');
  for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET']) {
    assert.ok(!(k in env), `${k} leaked into the agent env`);
  }
});

test('with no PAT configured, git auth is left completely alone', () => {
  const env = agentEnv({ PATH: '/usr/bin' });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined, 'no git config injected');
});

test('a PAT is exposed to both git and gh, and rewrites SSH to HTTPS', () => {
  const env = agentEnv({ PATH: '/usr/bin' }, 'github_pat_abc');

  assert.equal(env.GITHUB_TOKEN, 'github_pat_abc');
  assert.equal(env.GH_TOKEN, 'github_pat_abc', 'gh pr create needs it too');
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'url.https://github.com/.insteadOf');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'git@github.com:');
  assert.equal(env.GIT_CONFIG_KEY_2, 'credential.https://github.com.helper');
  assert.match(env.GIT_CONFIG_VALUE_2, /GITHUB_TOKEN/);
});

test('the inherited credential helper is reset, or the PAT is ignored', () => {
  // Regression guard: helpers accumulate. Without an empty-value reset the
  // machine's own helper answers first and the scoped token never gets used.
  const env = agentEnv({}, 'github_pat_abc');
  const idx = [0, 1, 2].find((i) => env[`GIT_CONFIG_KEY_${i}`] === 'credential.helper');
  assert.notEqual(idx, undefined, 'no credential.helper reset present');
  assert.equal(env[`GIT_CONFIG_VALUE_${idx}`], '', 'reset must be an empty value');
});

test('a blank or whitespace PAT counts as unconfigured', () => {
  assert.equal(agentEnv({}, '   ').GITHUB_TOKEN, undefined);
  assert.equal(agentEnv({}, '').GIT_CONFIG_COUNT, undefined);
});
