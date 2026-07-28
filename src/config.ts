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
   * On-disk Claude settings the agent may load. Defaults to `project` only:
   * enough for the repo's CLAUDE.md, without inheriting the allow-rules in
   * your personal `~/.claude/settings.json`, which would silently pre-approve
   * tools and skip the Slack prompt entirely.
   */
  settingSources: SettingSource[];
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
    maxTurns: positiveNumber('MAX_TURNS', 60),
    settingSources: loadSettingSources(),
  };
}

/** Resolve the project for a channel, falling back to the "default" key. */
export function projectFor(
  config: Config,
  channelId: string,
): ProjectConfig | undefined {
  return config.projects[channelId] ?? config.projects['default'];
}
