---
name: route-to-agent
description: Route scoped coding chores from Codex to Claude Code CLI backed by MiniMax through the plugin-bundled agent-router. Use when the user wants Codex to supervise Claude Code, use MiniMax token-plan quota, choose model/effort, or monitor delegated work. Keep Codex responsible for planning, architecture, security, review, deployments, and final verification.
---

# Route To Agent

Use this plugin when Codex should act as the project lead and delegate safe, bounded implementation chores to Claude Code CLI running through MiniMax.

The intended chain is:

```text
Codex -> minimax-agent-router -> claude-minimax wrapper -> Claude Code CLI -> MiniMax Anthropic-compatible API
```

## Responsibility Split

Codex must handle:

- Requirements, ambiguity, planning, architecture, and product judgment.
- Security, secrets, authentication, permissions, audit, database migrations, deployment, and rollback decisions.
- Code review, integration decisions, final testing, and the final user-facing answer.
- Any task where the allowed files, expected behavior, or risk boundary is unclear.

Delegate to `claude-minimax` only for:

- Focused unit tests, documentation edits, small bug fixes, lint/type fixes, mechanical refactors, and small components.
- Work with a narrow file or directory scope and a clear success condition.
- Draft implementation work that Codex will inspect before accepting.

Never treat delegated output as final. Codex must inspect the result, read the diff, run relevant tests, and decide whether to accept, revise, or discard it.

## Required Setup

Set a MiniMax token-plan key in the user's current shell session. In `cmd.exe`:

```cmd
set MINIMAX_API_KEY=<your MiniMax Subscription Key>
```

In PowerShell:

```powershell
$env:MINIMAX_API_KEY="<your MiniMax Subscription Key>"
```

`MINIMAX_SUBSCRIPTION_KEY` is also accepted. Do not write keys into config files.

## Router Commands

The plugin-bundled router lives under this plugin's `scripts/agent-router` directory. When Codex loads the skill, use the `SKILL.md` source locator to find the plugin root, then go to:

```text
<plugin-root>\scripts\agent-router
```

Check readiness:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" doctor --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Show MiniMax setup help:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" minimax --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Route a task:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" route --task "<task summary>" --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Run delegated work:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" run --agent claude-minimax --model "MiniMax-M3[1m]" --think low --task "<delegation prompt>" --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Open monitoring:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" monitor --port 8787 --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

## Delegation Prompt Template

Always give Claude Code a narrow prompt:

```text
Workspace: <absolute path>

Task:
<one specific task>

Scope:
<allowed files or directories>

Constraints:
- Preserve existing style.
- Do not run destructive git commands.
- Do not modify secrets, credentials, production deploy files, or unrelated modules.
- Do not expand the task scope.
- If unsure, stop and explain.

Output:
- Changed files
- Tests run
- Remaining issues
```

Use `low` effort for mechanical edits, `medium` for ordinary small bug fixes, and `high` only for bounded work that still needs deeper reasoning.

## After Delegation

Codex must:

1. Inspect stdout and stderr.
2. Review changed files or `git diff`.
3. Check for scope creep or risky edits.
4. Run relevant tests/builds.
5. Fix minor integration issues directly or re-delegate with a narrower prompt.
6. Give the final answer only after verification.
