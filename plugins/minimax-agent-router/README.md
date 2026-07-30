# MiniMax Agent Router Plugin

This Codex plugin packages the working `agent-router` flow:

```text
Codex -> agent-router -> claude-minimax -> Claude Code CLI -> MiniMax
```

## Responsibility Model

Codex is the project lead. It owns requirements, planning, architecture, security-sensitive work, review, integration, test selection, final verification, and the final answer to the user.

Claude Code + MiniMax is the execution assistant. It can handle focused tests, small bug fixes, documentation edits, lint/type fixes, formatting, mechanical refactors, and small helper/component edits with narrow scope.

Delegated output is never final until Codex reviews it.

## Setup

In `cmd.exe`:

```cmd
set MINIMAX_API_KEY=<your MiniMax Subscription Key>
```

In PowerShell:

```powershell
$env:MINIMAX_API_KEY="<your MiniMax Subscription Key>"
```

For persistent Windows user-level setup:

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "<your MiniMax Subscription Key>", "User")
```

`MINIMAX_SUBSCRIPTION_KEY` is also accepted.

Never write the key into `agent-router.config.json`.

## Commands

From a cloned source tree:

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
```

Check readiness:

```cmd
node .\src\cli.js doctor --config .\agent-router.config.json
```

Show MiniMax help:

```cmd
node .\src\cli.js minimax --config .\agent-router.config.json
```

Run a smoke test:

```cmd
node .\src\cli.js run --agent claude-minimax --task "请只回复：MiniMax Claude Code OK" --json --config .\agent-router.config.json
```

Run a real delegated task:

```cmd
node .\src\cli.js run --agent claude-minimax --task "Workspace: C:\absolute\path\to\repo
Task: <specific task>
Scope: <allowed files>
Constraints: preserve style; do not run destructive git commands; do not touch secrets.
Output: changed files, tests run, remaining issues." --json --config .\agent-router.config.json
```

View usage:

```cmd
node .\src\cli.js stats --config .\agent-router.config.json
```

Start monitor:

```cmd
node .\src\cli.js monitor --port 8787 --config .\agent-router.config.json
```

Then open:

```text
http://127.0.0.1:8787
```

## Verification

From `scripts/agent-router`:

```cmd
npm test
```
