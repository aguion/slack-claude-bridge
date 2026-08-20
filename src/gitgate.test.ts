import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyGitCommand } from './gitgate.js';

const on = (branch: string) => ({ currentBranch: branch });

test('ordinary commands are not gated', () => {
  for (const cmd of ['ls -la', 'npm test', 'git status', 'git diff --cached', 'git log --oneline']) {
    assert.equal(classifyGitCommand(cmd, on('feat/x')).decision, 'pass', cmd);
  }
});

test('a local commit passes; the push is what gets gated', () => {
  assert.equal(classifyGitCommand('git commit -m "wip"', on('feat/x')).decision, 'pass');
  assert.equal(classifyGitCommand('git push origin feat/x', on('feat/x')).decision, 'ask');
});

test('a bare push resolves to the current branch', () => {
  assert.equal(classifyGitCommand('git push', on('feat/x')).decision, 'ask');
  assert.equal(classifyGitCommand('git push', on('main')).decision, 'deny');
});

test('pushing to a protected branch is denied however it is spelled', () => {
  for (const cmd of [
    'git push origin main',
    'git push origin master',
    'git push origin HEAD:main',
    'git push -u origin main',
  ]) {
    assert.equal(classifyGitCommand(cmd, on('feat/x')).decision, 'deny', cmd);
  }
});

test('force-push, delete-push and history rewriting are denied outright', () => {
  for (const cmd of [
    'git push --force origin feat/x',
    'git push -f',
    'git push --force-with-lease origin feat/x',
    'git push origin :feat/x',
    'git push --delete origin feat/x',
    'git rebase -i HEAD~3',
    'git commit --amend -m "oops"',
    'git filter-branch --tree-filter true HEAD',
    'git branch -D feat/x',
    'git remote remove origin',
  ]) {
    assert.equal(classifyGitCommand(cmd, on('feat/x')).decision, 'deny', cmd);
  }
});

test('a compound command is judged by its most dangerous part', () => {
  const v = classifyGitCommand('git add -A && git commit -m x && git push --force', on('feat/x'));
  assert.equal(v.decision, 'deny');

  const v2 = classifyGitCommand('npm test && git commit -m x && git push origin feat/x', on('feat/x'));
  assert.equal(v2.decision, 'ask', 'the push still gates even when buried mid-chain');
});

test('the gate is not fooled by prefixes, global flags, or env assignments', () => {
  for (const cmd of [
    '/usr/bin/git push origin main',
    'git -c user.name=x push origin main',
    'env FOO=1 git push origin main',
    'sudo git push origin main',
  ]) {
    assert.equal(classifyGitCommand(cmd, on('feat/x')).decision, 'deny', cmd);
  }
});

test('an unresolvable push target gates rather than guessing', () => {
  assert.equal(classifyGitCommand('git push', {}).decision, 'ask');
});

test('opening a PR asks; merging one is refused', () => {
  assert.equal(classifyGitCommand('gh pr create --fill', on('feat/x')).decision, 'ask');
  assert.equal(classifyGitCommand('gh pr merge 12 --squash', on('feat/x')).decision, 'deny');
});

test('a destructive reset asks before discarding work', () => {
  assert.equal(classifyGitCommand('git reset --hard origin/main', on('feat/x')).decision, 'ask');
  assert.equal(classifyGitCommand('git reset HEAD~1', on('feat/x')).decision, 'pass');
});

test('every gated verdict carries a reason to show the approver', () => {
  for (const cmd of ['git push origin feat/x', 'git push origin main', 'gh pr create']) {
    const v = classifyGitCommand(cmd, on('feat/x'));
    assert.ok(v.reason && v.reason.length > 0, cmd);
  }
});
