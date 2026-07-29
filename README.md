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

Then invite the bot: `/invite @Marcel` in each mapped channel.

Keep the Mac awake while it runs, or macOS will sleep the socket:

```bash
caffeinate -s npm start
```

**Only one bridge may run at a time.** Slack load-balances Socket Mode events
across every open connection, so a second process silently takes about half the
traffic — and if it's running older code or a stale allowlist, the bot appears
to work intermittently and ignore people at random. The bridge takes a lock at
`~/.slack-claude-bridge/bridge.pid` on startup and a second instance refuses to
start:

```
✗ another bridge is already running (pid 84955).
  Slack splits events across both, so they would each answer part of the traffic.
  Stop it first:  kill 84955
```

A pidfile left by a crash is detected and reclaimed, so a hard kill never wedges
the next start.

---

## Using it

| In Slack | What happens |
|---|---|
| `@Marcel why is the auth test flaky?` | Starts a session in that channel's repo |
| *(reply in the thread)* `check the fixtures too` | Resumes the same session |
| `stop` | Cancels the in-flight run **and drops anything queued behind it**; the session is kept |
| `reset` | Forgets the session; next message starts fresh |
| DM the bot | Refused by default — set `ALLOW_DMS=true` to use the `default` project |

Each thread is its own session, so you can run several agents at once in
different channels. Within a thread, messages queue and run one at a time —
concurrent runs would race on the same resumed session.

## Approvals

Read-only tools (`Read`, `Glob`, `Grep`, `TodoWrite`) run unattended. Anything
that writes files, runs shell commands or touches the network posts buttons
into the thread and **blocks until you answer**:

> **Approval needed** — `Bash`
> `npm test -- --watch=false` *+4 more lines*
> [ Show full input ] [ Approve once ] [ Always in this session ] [ Deny ]

- The preview is **one line**. **Show full input** opens a modal with the whole
  command or input JSON, so a long payload can't bury the buttons. It reads the
  pending prompt, so once you've decided, the input is gone.

- **Always in this session** applies the SDK's own permission suggestion, so
  that class of call stops asking for the rest of that session only.
- Prompts are **fail-closed**: a timeout (default 5 min), a `stop`, or a click
  from someone not on the allowlist all resolve to *deny*. The agent never
  proceeds because nobody answered.

### Permission mode

`PERMISSION_MODE` decides how much reaches the buttons at all. Default `auto`,
matching the CLI: a model classifier clears routine calls itself and only
escalates what it won't decide, which still lands in Slack as a prompt.

| Mode | Behaviour |
|---|---|
| `auto` (default) | Classifier approves routine calls; the rest prompt in Slack |
| `default` | Every non-`allowedTools` call prompts in Slack |
| `acceptEdits` | File edits auto-approved; commands and network still prompt |
| `dontAsk` | Never prompts — denies anything not already pre-approved |
| `plan` | Plans only, executes nothing |

`bypassPermissions` is rejected on purpose: it would disable the approval gate
this bridge exists to provide. Set per project with `"permissionMode"` in
`projects.json`, which overrides the global value.

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
| `src/lock.ts` | Single-instance pidfile lock |

State lives in `~/.slack-claude-bridge/sessions.json` — a thread→session-ID
map, capped at the 500 most recent threads. Delete it to forget every session.

Run the tests with `npm test`.

## Checking the setup

`npm run doctor` verifies every part end to end and exits non-zero if anything
is broken:

```
✓ config                 env and projects.json load cleanly
✓ bot token              marcel in Guion Consulting
✓ bot scopes             all 10 granted
✓ app token              socket mode can connect
✓ instances              one bridge running (pid 84955)
✓ project C0BKUUJSAF8    /Users/you/sources/repo (auto)
✓ allowlist U0AUQMWL02F  Alex Guion
✓ channel C0BKUUJSAF8    #eng → repo
✓ dms                    disabled
```

It checks the tokens, compares granted scopes against what
`slack-app-manifest.json` requests (so the two can't drift), reports which
bridge holds the lock, resolves every allowlisted member ID to a real person,
and confirms the bot is actually a member of each mapped channel — the failure
that otherwise looks like the bot ignoring you.

Reach for it whenever the bot goes quiet. Silence usually means an event was
never delivered, and that is almost always a missing scope or a channel the bot
was never invited to.

## Troubleshooting

**Bot doesn't respond to a mention.** It's probably not in the channel —
`/invite @Marcel`. Check the terminal for `Ignoring message from
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

**Answers some messages but not others, or ignores one person.** Two bridges
were running and Slack was splitting events between them — the older process
serves its own stale allowlist and code. `npm run doctor` reports which pid
holds the lock; `ps ax | grep dist/index.js` shows any extras to kill. Since the
single-instance lock this can't happen silently anymore, but a process started
before the lock existed won't be holding one.

**`:x: Run failed: API Error: 529 Overloaded`.** Upstream, not the bridge — the
Claude API is shedding load. The SDK already retries internally, so a 529 that
reaches Slack means the outage outlasted the retries. Check
<https://status.claude.com> and reply in the thread to pick the session back up.

**Disconnects overnight.** macOS slept. Run under `caffeinate -s`.
