/**
 * The environment the agent's own processes run with.
 *
 * Two jobs. First, hand Marcel a GitHub credential that is scoped to the repos
 * the token allows, instead of the ambient account-wide SSH key sitting in
 * `~/.ssh` — a fine-grained PAT can be limited to one repository, an SSH key
 * cannot. Second, keep the bridge's own Slack secrets out of the agent's
 * environment entirely, so they can't be read back out of `env`.
 *
 * The git settings are injected via `GIT_CONFIG_*`, which applies to this
 * process only — no repo config is modified and the human's own `git push`
 * keeps using SSH exactly as before.
 */

/** Bridge-only secrets the agent has no use for. */
const STRIPPED = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'SLACK_SIGNING_SECRET'];

/**
 * `insteadOf` rewrites the SSH remote to HTTPS for this process, so the token
 * is what authenticates; the credential helper then supplies it. Without the
 * rewrite a repo whose remote is `git@github.com:...` would keep using SSH and
 * silently ignore the token.
 *
 * The empty `credential.helper` in the middle is load-bearing and easy to miss.
 * Helpers ACCUMULATE, so without it the machine's existing helper (osxkeychain
 * here) stays in the list, answers first with the human's own cached
 * credential, and the scoped token is never used — verified against this repo:
 * a deliberately invalid token still authenticated until the reset was added.
 * An empty value resets the list, leaving the token as the only credential.
 */
function gitConfigEnv(): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: '',
    GIT_CONFIG_KEY_2: 'credential.https://github.com.helper',
    // Reads GITHUB_TOKEN at call time from the same env we set below.
    GIT_CONFIG_VALUE_2:
      '!f() { echo username=x-access-token; echo "password=${GITHUB_TOKEN}"; }; f',
  };
}

export function agentEnv(
  base: NodeJS.ProcessEnv,
  githubToken?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || STRIPPED.includes(k)) continue;
    out[k] = v;
  }
  const token = githubToken?.trim();
  if (!token) return out; // No PAT configured: leave git auth exactly as it was.

  return {
    ...out,
    GITHUB_TOKEN: token,
    GH_TOKEN: token,
    ...gitConfigEnv(),
  };
}
