# Agent Router Runtime

This runtime is bundled by the `henchman` Codex plugin.

The runtime enables a task-fit gate by default. Editing work needs a narrow scope, code work needs an exact test command, each worker has a five-minute default budget, and successful runs remain pending Codex review. On first use, the router automatically installs a pinned Headroom runtime into its own user-level virtual environment. The managed proxy then compresses Claude Code context and provides project-isolated persistent memory.

## Micro Research

Henchman delegates research only when it is small enough to finish usefully inside the worker budget. Complete business plans, full reports, or combined competitor + monetization + compliance tasks stay with Codex until split into micro-research.

Use one bounded research task per worker:

```json
{
  "id": "overseas-tools",
  "kind": "research",
  "readOnly": true,
  "task": "Research 3 overseas image tool competitors.",
  "maxFindings": 8,
  "estimatedMinutes": 4,
  "output": "Return 5-8 evidence-backed bullets. Do not write a full report."
}
```

When accepted, the generated worker prompt includes `Micro-research mode` and asks for concise evidence-backed bullets so Codex can verify and reuse the result quickly. Unsplit broad research is routed back to Codex with `signal=broad-research`.

## Headroom

Normal MiniMax tasks and `headroom start` automatically install `headroom-ai[proxy]==0.33.0` into `~/.agent-router/headroom/venv` when it is missing. Concurrent first-use workers share an installation lock. Use `setup` only to prewarm or repair the managed runtime:

```cmd
node .\src\cli.js headroom setup --config .\agent-router.config.json
```

Check or manage the current workspace proxy:

```cmd
node .\src\cli.js headroom doctor --config .\agent-router.config.json
node .\src\cli.js headroom start --config .\agent-router.config.json
node .\src\cli.js headroom stats --json --config .\agent-router.config.json
node .\src\cli.js headroom stop --config .\agent-router.config.json
```

The default mode is `auto`. Use `--headroom required` when direct fallback is unacceptable, or `--headroom off` for an A/B comparison. Memory is always project-isolated, recall is capped at three entries, output shaping and automatic learning are disabled, and reports never contain credentials.

Set `AGENT_ROUTER_HEADROOM_AUTO_INSTALL=false` to opt out. If Python, venv creation, or pip download fails, `auto` mode reports `headroom-auto-install-failed` and falls back to the direct MiniMax route; `required` mode fails closed. Install Python 3.10+ and verify `py -3` on Windows or `python3` on macOS/Linux before retrying.

First-use installation time is excluded from the normal five-minute worker budget. Proxy cold start allows up to five minutes for ONNX embedder initialization. `doctor` reports `runnable=true` for an installed on-demand runtime even when `status=stopped`. A non-fatal embedder warm-up failure is reported as `memoryStatus=degraded`: the proxy remains usable, while semantic memory recall may be reduced. Python output is forced to UTF-8 on Windows; read raw logs with an explicit UTF-8 encoding when needed.

The router forces `HEADROOM_TOOL_SEARCH=0` because Headroom's Anthropic-only server tool-search schema is not supported by MiniMax-compatible Anthropic gateways. Compression, CCR, and project memory remain enabled.

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
