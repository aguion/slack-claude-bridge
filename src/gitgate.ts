/**
 * Classifies a Bash command into what the git gate should do with it.
 *
 * Pure and syntactic — no git state, no I/O — so it is exhaustively testable.
 * The caller supplies the current branch; everything else is read off the
 * command text.
 *
 * The bias throughout is that a FALSE POSITIVE is cheap (one extra button) and
 * a FALSE NEGATIVE is not (an ungated push). When a command is ambiguous, gate
 * it.
 */

export type GitDecision = 'pass' | 'ask' | 'deny';

export interface GitVerdict {
  decision: GitDecision;
  /** Shown in Slack (ask) or returned to the model (deny). */
  reason?: string;
}

/** Branches Marcel may never push to directly — the PR is the review surface. */
export const PROTECTED_BRANCHES = ['main', 'master'];

/** Git global flags that take a value, so the subcommand is one token further. */
const VALUE_FLAGS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * Split a command line into segments that each start a new command. Quoting is
 * deliberately ignored: an operator inside a quoted string splits a segment it
 * shouldn't, which can only ever produce an extra gate, never a missed one.
 */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Tokens of a segment with a leading `env VAR=x` or `sudo` stripped. */
function tokens(segment: string): string[] {
  const raw = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < raw.length && (raw[i] === 'sudo' || raw[i] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[i]))) {
    i++;
  }
  return raw.slice(i);
}

/** The git subcommand in a segment, or null if this segment isn't git. */
function gitSubcommand(t: string[]): { sub: string; rest: string[] } | null {
  if (t.length === 0) return null;
  // Match `git`, `/usr/bin/git`, `git.exe`.
  if (!/(^|\/)git(\.exe)?$/.test(t[0])) return null;
  let i = 1;
  while (i < t.length && t[i].startsWith('-')) {
    if (VALUE_FLAGS.has(t[i])) i += 2;
    else i += 1;
  }
  if (i >= t.length) return null;
  return { sub: t[i], rest: t.slice(i + 1) };
}

function isForcePush(rest: string[]): boolean {
  return rest.some(
    (a) => a === '-f' || a === '--force' || a.startsWith('--force-with-lease') || a.startsWith('--force-if-includes'),
  );
}

/** `git push origin :branch` and `git push --delete origin branch` both delete. */
function isDeletePush(rest: string[]): boolean {
  return rest.some((a) => a === '--delete' || a === '-d' || a.startsWith(':'));
}

/**
 * Which branch a push targets. `git push origin feat/x` → 'feat/x';
 * `git push` → the current branch. Refspecs like `HEAD:main` resolve to the
 * destination side, which is the half that matters.
 */
function pushTargets(rest: string[], currentBranch: string | undefined): string[] {
  const positional = rest.filter((a) => !a.startsWith('-'));
  // First positional is the remote; anything after is a refspec.
  const refs = positional.slice(1);
  if (refs.length === 0) return currentBranch ? [currentBranch] : [];
  return refs.map((r) => (r.includes(':') ? r.slice(r.lastIndexOf(':') + 1) : r));
}

export function classifyGitCommand(
  command: string,
  opts: { currentBranch?: string; protectedBranches?: string[] } = {},
): GitVerdict {
  const protectedBranches = opts.protectedBranches ?? PROTECTED_BRANCHES;
  let verdict: GitVerdict = { decision: 'pass' };

  const raise = (next: GitVerdict) => {
    // deny outranks ask outranks pass, so a compound command is judged by its
    // most dangerous part.
    const rank = { pass: 0, ask: 1, deny: 2 } as const;
    if (rank[next.decision] > rank[verdict.decision]) verdict = next;
  };

  for (const segment of segments(command)) {
    const t = tokens(segment);

    if (/(^|\/)gh$/.test(t[0] ?? '') && t[1] === 'pr' && (t[2] === 'create' || t[2] === 'merge')) {
      raise({
        decision: t[2] === 'merge' ? 'deny' : 'ask',
        reason:
          t[2] === 'merge'
            ? 'Merging a PR is a human decision on GitHub, not a bot action.'
            : 'Opening a pull request publishes to GitHub.',
      });
      continue;
    }

    const git = gitSubcommand(t);
    if (!git) continue;
    const { sub, rest } = git;

    switch (sub) {
      case 'push': {
        if (isForcePush(rest)) {
          raise({ decision: 'deny', reason: 'Force-push rewrites published history.' });
          break;
        }
        if (isDeletePush(rest)) {
          raise({ decision: 'deny', reason: 'Deleting a remote branch is not a bot action.' });
          break;
        }
        const targets = pushTargets(rest, opts.currentBranch);
        const blocked = targets.filter((b) => protectedBranches.includes(b));
        if (blocked.length > 0) {
          raise({
            decision: 'deny',
            reason: `Direct pushes to ${blocked.join(', ')} are not allowed — push a branch and open a PR.`,
          });
          break;
        }
        if (targets.length === 0) {
          // Couldn't resolve a target: gate rather than guess.
          raise({ decision: 'ask', reason: 'Push to GitHub (branch could not be determined).' });
          break;
        }
        raise({ decision: 'ask', reason: `Push \`${targets.join(', ')}\` to GitHub.` });
        break;
      }

      case 'branch':
        if (rest.some((a) => a === '-D' || a === '-d' || a === '--delete')) {
          raise({ decision: 'deny', reason: 'Deleting branches is not a bot action.' });
        }
        break;

      case 'remote':
        if (rest[0] === 'remove' || rest[0] === 'rm' || rest[0] === 'set-url') {
          raise({ decision: 'deny', reason: 'Changing remotes is not a bot action.' });
        }
        break;

      case 'reset':
        if (rest.includes('--hard')) {
          raise({ decision: 'ask', reason: '`git reset --hard` discards uncommitted work.' });
        }
        break;

      case 'filter-branch':
      case 'filter-repo':
        raise({ decision: 'deny', reason: 'History rewriting is not allowed.' });
        break;

      case 'rebase':
        raise({ decision: 'deny', reason: 'Rebasing rewrites history.' });
        break;

      case 'commit':
        if (rest.includes('--amend')) {
          raise({ decision: 'deny', reason: 'Amending rewrites a commit that may already be pushed.' });
        }
        // A plain local commit is cheap to undo and needs no button; the push
        // is the outward-facing step, and that is what gets gated.
        break;

      default:
        break;
    }
  }

  return verdict;
}
