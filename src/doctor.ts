import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig, projectFor, type Config } from './config.js';

/**
 * Preflight check. Verifies every moving part the bridge depends on — config,
 * tokens, scopes, repo paths, allowlisted users, channel membership — and
 * reports what is wrong rather than failing at the first message nobody sees.
 *
 * Run with `npm run doctor`. Exits non-zero if anything is broken.
 */

type Status = 'ok' | 'warn' | 'fail';

const results: { status: Status; label: string; detail: string }[] = [];

function record(status: Status, label: string, detail: string): void {
  results.push({ status, label, detail });
}

async function slack(
  token: string,
  method: string,
  params: Record<string, string> = {},
  // Some methods (apps.connections.open) reject GET with `insecure_request`.
  verb: 'GET' | 'POST' = 'GET',
): Promise<{ body: Record<string, unknown>; scopes: string[] }> {
  const url = new URL(`https://slack.com/api/${method}`);
  if (verb === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method: verb,
    headers: { Authorization: `Bearer ${token}` },
  });
  return {
    body: (await res.json()) as Record<string, unknown>,
    scopes: (res.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Scopes the manifest asks for — the source of truth, so it can't drift. */
function requestedScopes(): string[] {
  const path = process.env.MANIFEST_FILE ?? resolve('slack-app-manifest.json');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    oauth_config?: { scopes?: { bot?: string[] } };
  };
  return raw.oauth_config?.scopes?.bot ?? [];
}

async function checkTokens(config: Config): Promise<string[]> {
  const { body, scopes } = await slack(config.botToken, 'auth.test');
  if (!body.ok) {
    record('fail', 'bot token', `auth.test failed: ${String(body.error)}`);
    return [];
  }
  record(
    'ok',
    'bot token',
    `${String(body.user)} in ${String(body.team)}`,
  );

  const want = requestedScopes();
  const missing = want.filter((s) => !scopes.includes(s));
  if (missing.length) {
    record(
      'fail',
      'bot scopes',
      `missing ${missing.join(', ')} — reinstall the app and paste the new ` +
        `bot token into .env (scopes are fixed at install time)`,
    );
  } else {
    record('ok', 'bot scopes', `all ${want.length} granted`);
  }

  const app = await slack(config.appToken, 'apps.connections.open', {}, 'POST');
  if (app.body.ok) record('ok', 'app token', 'socket mode can connect');
  else
    record('fail', 'app token', `apps.connections.open: ${String(app.body.error)}`);

  return scopes;
}

async function checkUsers(config: Config, scopes: string[]): Promise<void> {
  if (!scopes.includes('users:read')) {
    record(
      'warn',
      'allowlist',
      `${config.allowedUsers.size} id(s), unverified — needs users:read`,
    );
    return;
  }
  for (const id of config.allowedUsers) {
    const { body } = await slack(config.botToken, 'users.info', { user: id });
    if (!body.ok) {
      record('fail', `allowlist ${id}`, `not resolvable: ${String(body.error)}`);
      continue;
    }
    const u = body.user as Record<string, unknown>;
    const flags = [
      u.is_bot ? 'BOT' : null,
      u.is_admin ? 'admin' : null,
      u.is_restricted ? 'guest' : null,
      u.deleted ? 'DEACTIVATED' : null,
    ].filter(Boolean);
    record(
      u.deleted || u.is_bot ? 'warn' : 'ok',
      `allowlist ${id}`,
      `${String(u.real_name ?? u.name)}${flags.length ? ` (${flags.join(', ')})` : ''}`,
    );
  }
}

async function checkChannels(config: Config, scopes: string[]): Promise<void> {
  const channels = Object.keys(config.projects).filter((k) => k !== 'default');
  if (!channels.length) {
    record(
      'warn',
      'channels',
      'none mapped — every channel falls through to "default"',
    );
    return;
  }
  const canRead =
    scopes.includes('channels:read') || scopes.includes('groups:read');
  for (const id of channels) {
    if (!canRead) {
      record('warn', `channel ${id}`, 'unverified — needs channels:read');
      continue;
    }
    const { body } = await slack(config.botToken, 'conversations.info', {
      channel: id,
    });
    if (!body.ok) {
      record('fail', `channel ${id}`, `not readable: ${String(body.error)}`);
      continue;
    }
    const c = body.channel as Record<string, unknown>;
    const project = projectFor(config, id);
    if (c.is_member) {
      record('ok', `channel ${id}`, `#${String(c.name)} → ${project?.label}`);
    } else {
      record(
        'fail',
        `channel ${id}`,
        `#${String(c.name)} — bot is not a member, so no events arrive. ` +
          `Run /invite in that channel.`,
      );
    }
  }
}

function checkProjects(config: Config): void {
  for (const [key, project] of Object.entries(config.projects)) {
    // loadConfig already threw if the path was missing or not a directory.
    record(
      'ok',
      `project ${key}`,
      `${project.cwd} (${project.permissionMode ?? config.permissionMode})`,
    );
  }
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
    record('ok', 'config', 'env and projects.json load cleanly');
  } catch (err) {
    console.error(`✗ config — ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const scopes = await checkTokens(config);
  checkProjects(config);
  if (scopes.length) {
    await checkUsers(config, scopes);
    await checkChannels(config, scopes);
  }
  record(
    config.allowDms ? 'warn' : 'ok',
    'dms',
    config.allowDms ? 'allowed — they resolve to "default"' : 'disabled',
  );

  const icon = { ok: '✓', warn: '!', fail: '✗' } as const;
  for (const r of results) {
    console.log(`${icon[r.status]} ${r.label.padEnd(22)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  console.log(
    `\n${results.length - failed - warned} ok, ${warned} warning(s), ${failed} failure(s)`,
  );
  process.exit(failed ? 1 : 0);
}

await main();
