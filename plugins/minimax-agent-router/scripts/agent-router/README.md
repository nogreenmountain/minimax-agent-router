# Agent Router Runtime

This runtime is bundled by the `minimax-agent-router` Codex plugin.

The runtime enables a task-fit gate by default. Editing work needs a narrow scope, code work needs an exact test command, each worker has a five-minute default budget, and successful runs remain pending Codex review.

For a structured single task, use `route --task-file task.json` first, then reuse the same file with `run --task-file task.json` only when the assessment decision is `delegate`.

## Quick Check

```cmd
node .\src\cli.js doctor --config .\agent-router.config.json
```

If `claude-minimax` shows `missing-env`, set a MiniMax key in the current shell.

For `cmd.exe`:

```cmd
set MINIMAX_API_KEY=<your MiniMax Subscription Key>
```

For PowerShell:

```powershell
$env:MINIMAX_API_KEY="<your MiniMax Subscription Key>"
```

## Smoke Test

```cmd
node .\src\cli.js run --agent claude-minimax --task "请只回复：MiniMax Claude Code OK" --json --config .\agent-router.config.json
```

Expected result:

```json
{
  "status": "ok",
  "stdout": "MiniMax Claude Code OK\n"
}
```

## Parallel Tasks

Use `run-many` when Codex has already split work into independent, non-overlapping chores:

```cmd
node .\src\cli.js run-many --tasks parallel-tasks.json --parallel 3 --agent claude-minimax --json --config .\agent-router.config.json
```

The tasks file may be either an array or an object with a `tasks` array:

```json
{
  "tasks": [
    {
      "id": "backend-tests",
      "task": "Add focused backend tests.",
      "scope": "Only edit tests/backend/**.",
      "constraints": "Do not modify production code.",
      "output": "Summarize changed files and tests run."
    }
  ]
}
```

Keep auth, permissions, database migrations, deployment, production config, shared-file edits, and architecture decisions in Codex.

## Tests

```cmd
npm test
```
