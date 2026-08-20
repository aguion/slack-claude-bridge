import { existsSync, statSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Load .env before anything reads process.env. Doing this at module scope
// rather than in the start script means it works however the app is launched
// (npm start, node dist/index.js, a supervisor, a debugger).
const envFile = process.env.ENV_FILE ?? resolve('.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** Which on-disk Claude settings the agent is allowed to load. */
export type SettingSource = 'user' | 'project' | 'local';

const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/**
 * How the SDK resolves tool permissions before falling back to a Slack prompt.
 *
 * `bypassPermissions` is deliberately not offered — it would disable the
 * approval gate this bridge exists to provide, from a chat window.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto';

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'auto',
];

/** Per-channel project configuration, loaded from projects.json. */
export interface ProjectConfig {
  /** Absolute path to the repo Claude should work in for this channel. */
  cwd: string;
  /** Optional human label used in Slack messages. */
  label?: string;
  /** Tools auto-approved for this project (no button prompt). */
  allowedTools?: string[];
  /** Model override, e.g. "claude-opus-4-6". Omit for the account default. */
  model?: string;
  /** Permission mode override for this project. Falls back to the global one. */
  permissionMode?: PermissionMode;
  /**
   * Extra standing instructions for this project, appended after the shared
   * Slack policy. Adds to it — it cannot remove or override any of it.
   */
  appendSystemPrompt?: string;
}

export interface Config {
  botToken: string;
  appToken: string;
  /** Slack user IDs permitted to drive the bot. Everyone else is ignored. */
  allowedUsers: Set<string>;
  /** channel ID -> project. Also accepts "default" as a fallback key. */
  projects: Record<string, ProjectConfig>;
  /** Where thread -> session mappings are persisted. */
  stateDir: string;
  /** Seconds to wait on an approval prompt before auto-denying. */
  approvalTimeoutSec: number;
  /** Hard cap on agent turns per Slack message. */
  maxTurns: number;
  /**
   * Optional fine-grained GitHub PAT the agent pushes with. When set it
   * replaces the ambient `~/.ssh` key for the agent's processes only, which is
   * what makes "Slack access" mean one repository instead of the whole
   * account. Unset leaves git auth exactly as the machine has it.
   */
  githubToken?: string;
  /**
   * On-disk Claude settings the agent may load. Defaults to `project` only:
   * enough for the repo's CLAUDE.md, without inheriting the allow-rules in
   * your personal `~/.claude/settings.json`, which would silently pre-approve
   * tools and skip the Slack prompt entirely.
   */
  settingSources: SettingSource[];
  /**
   * Default permission mode. `auto` runs the SDK's model classifier over each
   * prompt and only escalates to Slack buttons when it can't clear the call
   * itself — the same behaviour as the CLI. Per-project overrides win.
   */
  permissionMode: PermissionMode;
  /**
   * Whether DMs to the bot drive an agent. Off by default: a DM has no channel
   * mapping of its own, so it always lands on the `default` project, which is
   * easy to point somewhere you didn't intend.
   */
  allowDms: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return v;
}

/**
 * Read a positive number from the environment, refusing garbage rather than
 * letting NaN through. A NaN timeout makes `setTimeout` fire on the next tick,
 * which would auto-deny every approval within milliseconds.
 */
function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `${name} must be a positive number, got ${JSON.stringify(raw)}.`,
    );
  }
  return n;
}

function loadSettingSources(): SettingSource[] {
  const raw = process.env.SETTING_SOURCES;
  if (raw === undefined) return ['project'];

  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const s of parsed) {
    if (!SETTING_SOURCES.includes(s as SettingSource)) {
      throw new Error(
        `SETTING_SOURCES contains "${s}". Valid values are ` +
          `${SETTING_SOURCES.join(', ')}, or an empty string for none.`,
      );
    }
  }
  return parsed as SettingSource[];
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false, got ${JSON.stringify(raw)}.`);
}

function parsePermissionMode(value: string, where: string): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) {
    const extra =
      value === 'bypassPermissions'
        ? ' bypassPermissions is refused on purpose: it would disable the ' +
          'approval prompts that keep this bot from running anything a ' +
          'Slack message asks for.'
        : '';
    throw new Error(
      `${where} must be one of ${PERMISSION_MODES.join(', ')}, got ` +
        `${JSON.stringify(value)}.${extra}`,
    );
  }
  return value as PermissionMode;
}

function loadProjects(path: string): Record<string, ProjectConfig> {
  if (!existsSync(path)) {
    throw new Error(
      `No projects file at ${path}. Copy projects.example.json to projects.json ` +
        `and map your Slack channel IDs to local repo paths.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    ProjectConfig
  >;

  for (const [channel, project] of Object.entries(raw)) {
    if (!project.cwd) {
      throw new Error(`Project "${channel}" is missing a "cwd".`);
    }
    // Expand ~ and make absolute so the SDK never inherits a surprising cwd.
    const expanded = project.cwd.startsWith('~')
      ? join(homedir(), project.cwd.slice(1))
      : project.cwd;
    project.cwd = resolve(expanded);
    if (!existsSync(project.cwd)) {
      throw new Error(
        `Project "${channel}" points at ${project.cwd}, which does not exist.`,
      );
    }
    if (!statSync(project.cwd).isDirectory()) {
      throw new Error(
        `Project "${channel}" points at ${project.cwd}, which is not a directory.`,
      );
    }
    if (project.permissionMode !== undefined) {
      project.permissionMode = parsePermissionMode(
        project.permissionMode,
        `Project "${channel}" permissionMode`,
      );
    }
  }
  return raw;
}

export function loadConfig(): Config {
  const stateDir =
    process.env.STATE_DIR ?? join(homedir(), '.slack-claude-bridge');

  const allowed = required('ALLOWED_SLACK_USER_IDS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    throw new Error(
      'ALLOWED_SLACK_USER_IDS is empty. Refusing to start — that would give ' +
        'every member of the workspace shell access to this machine.',
    );
  }

  return {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    allowedUsers: new Set(allowed),
    projects: loadProjects(
      process.env.PROJECTS_FILE ?? resolve('projects.json'),
    ),
    stateDir,
    approvalTimeoutSec: positiveNumber('APPROVAL_TIMEOUT_SEC', 300),
    maxTurns: positiveNumber('MAX_TURNS', 250),
    githubToken: process.env.GITHUB_TOKEN?.trim() || undefined,
    settingSources: loadSettingSources(),
    permissionMode: parsePermissionMode(
      process.env.PERMISSION_MODE?.trim() || 'auto',
      'PERMISSION_MODE',
    ),
    allowDms: boolEnv('ALLOW_DMS', false),
  };
}

/** Resolve the project for a channel, falling back to the "default" key. */
export function projectFor(
  config: Config,
  channelId: string,
): ProjectConfig | undefined {
  return config.projects[channelId] ?? config.projects['default'];
}
