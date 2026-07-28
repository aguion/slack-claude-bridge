# Slack ↔ Claude Code bridge

Drive Claude Code on your own Mac from Slack. Mention the bot in a channel, it
runs an agent against the local repo mapped to that channel and streams the
work back into the thread. Reply in the thread to steer it — replies resume the
same session, so context carries.

Nothing is exposed to the internet: the bridge uses Slack **Socket Mode**, an
outbound WebSocket from your machine. No public URL, no tunnel, no open ports.

```
Slack thread  ──socket──▶  bridge (your Mac)  ──▶  Claude Agent SDK  ──▶  your repo
      ▲                                                    │
      └────────── streamed output + approval buttons ──────┘
```

---

## Setup

### 1. Create the Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From an app
manifest**, pick your workspace, and paste in
[`slack-app-manifest.json`](./slack-app-manifest.json). That sets the scopes,
event subscriptions, interactivity and Socket Mode in one shot.

Then collect two tokens:

- **Bot token** — *OAuth & Permissions* → Install to workspace → copy the
  `xoxb-…` **Bot User OAuth Token**.
- **App-level token** — *Basic Information* → *App-Level Tokens* → **Generate**,
  add the `connections:write` scope, copy the `xapp-…` token.

### 2. Configure

```bash
npm install
cp .env.example .env               # paste both tokens
cp projects.example.json projects.json
```

Put your Slack member ID in `ALLOWED_SLACK_USER_IDS` (Slack profile → ⋮ → *Copy
member ID*). Then map channels to repos in `projects.json`:

```json
{
  "C01ABCDEFGH": { "label": "acme-api", "cwd": "~/code/acme-api" },
  "default":     { "label": "scratch",  "cwd": "~/code/scratch" }
}
```

Get a channel ID from the channel's *View channel details* → bottom of the
About tab. The optional `"default"` key catches any channel you haven't mapped;
omit it if you'd rather the bot refuse unmapped channels.

### 3. Run

```bash
npm run build
npm start
```

Then invite the bot: `/invite @Claude Code` in each mapped channel.

Keep the Mac awake while it runs, or macOS will sleep the socket:

```bash
caffeinate -s npm start
```

---

## Using it

| In Slack | What happens |
|---|---|
| `@Claude Code why is the auth test flaky?` | Starts a session in that channel's repo |
| *(reply in the thread)* `check the fixtures too` | Resumes the same session |
| `stop` | Cancels the in-flight run **and drops anything queued behind it**; the session is kept |
| `reset` | Forgets the session; next message starts fresh |
| DM the bot | Uses the `default` project |

Each thread is its own session, so you can run several agents at once in
different channels. Within a thread, messages queue and run one at a time —
concurrent runs would race on the same resumed session.

## Approvals

Read-only tools (`Read`, `Glob`, `Grep`, `TodoWrite`) run unattended. Anything
that writes files, runs shell commands or touches the network posts buttons
into the thread and **blocks until you answer**:

> **Approval needed** — `Bash`
> ```
> npm test -- --watch=false
> ```
> [ Approve once ] [ Always in this session ] [ Deny ]

- **Always in this session** applies the SDK's own permission suggestion, so
  that class of call stops asking for the rest of that session only.
- Prompts are **fail-closed**: a timeout (default 5 min), a `stop`, or a click
  from someone not on the allowlist all resolve to *deny*. The agent never
  proceeds because nobody answered.

To pre-approve more per repo, widen `allowedTools` for that project:

```json
"C02IJKLMNOP": {
  "cwd": "~/code/acme-web",
  "allowedTools": ["Read", "Glob", "Grep", "TodoWrite", "Bash"]
}
```

### What bypasses the prompt

The approval prompt is not the only thing that can allow a tool. The Agent SDK
resolves permissions itself and only calls back into this bridge when nothing
else has already decided. A tool runs **without** any Slack prompt if:

- it's in that project's `allowedTools`, **or**
- a settings file loaded via `SETTING_SOURCES` has a matching
  `permissions.allow` rule.

That second one is easy to miss. `SETTING_SOURCES` defaults to `project`, so
the repo's own `.claude/settings.json` counts — if it contains
`"permissions": {"allow": ["Bash(git:*)"]}`, the bot runs those git commands
silently. Adding `user` to `SETTING_SOURCES` extends the same treatment to
every allow-rule in your personal `~/.claude/settings.json`, which is usually
much broader than you'd want a chat window to inherit.

Hooks in those files also run unconditionally, and they never surface in Slack.

Set `SETTING_SOURCES=` (empty) to load nothing, at the cost of the repo's
CLAUDE.md not being read.

## Security

This bot runs code on your laptop from a chat window. Three things carry the
weight:

1. **`ALLOWED_SLACK_USER_IDS`** is checked on every message *and* every button
   click. The bridge refuses to start if it's empty. Don't widen it casually —
   anyone on that list has shell access to your machine.
2. **`projects.json` is the blast radius.** Claude's `cwd` is the repo you
   named. Map specific project directories, not `~`.
3. **Approvals are the last line — but only for calls that reach them.**
   `allowedTools` and any `permissions.allow` rule in a loaded settings file
   both run without prompting; see [What bypasses the
   prompt](#what-bypasses-the-prompt). If you set `allowedTools` to include
   `Bash`, you've handed that project's shell to the channel. Do it for repos
   you'd be fine with a teammate running commands in, not for everything.

Also worth knowing: private channel content and anything Claude reads flows to
the Claude API as part of the conversation, same as it would in your terminal.

## Files

| File | |
|---|---|
| `src/index.ts` | Bolt wiring — events, control words, button handlers |
| `src/runner.ts` | Runs one agent turn, streams it into the thread |
| `src/approvals.ts` | Block Kit permission prompts, fail-closed |
| `src/store.ts` | Thread→session persistence and the per-thread queue |
| `src/config.ts` | Env + `projects.json` loading and validation |
| `src/format.ts` | Slack-safe chunking and tool-call summaries |

State lives in `~/.slack-claude-bridge/sessions.json` — a thread→session-ID
map, capped at the 500 most recent threads. Delete it to forget every session.

Run the tests with `npm test`.

## Troubleshooting

**Bot doesn't respond to a mention.** It's probably not in the channel —
`/invite @Claude Code`. Check the terminal for `Ignoring message from
non-allowlisted user`, which means your member ID isn't in `.env`.

**Thread replies ignored.** In channels the bridge only follows threads it
already owns, so the *first* message must be an `@`-mention. In DMs every
message works.

**Buttons do nothing.** Interactivity must be on in the app config — the
manifest sets it, but confirm under *Interactivity & Shortcuts* if you built
the app by hand instead of from the manifest. Clicking a prompt from before a
restart replies "that approval prompt is no longer active" — pending prompts
live in memory only, so restarting the bridge abandons them.

**A tool ran without asking.** Check that project's `allowedTools`, then the
`permissions.allow` rules in whatever `SETTING_SOURCES` loads — see [What
bypasses the prompt](#what-bypasses-the-prompt).

**Disconnects overnight.** macOS slept. Run under `caffeinate -s`.
