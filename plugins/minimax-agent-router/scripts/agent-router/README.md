# Agent Router Runtime

This runtime is bundled by the `minimax-agent-router` Codex plugin.

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

## Tests

```cmd
npm test
```
