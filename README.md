# MiniMax Agent Router for Codex

Codex plugin for delegating safe, scoped coding chores to Claude Code CLI through MiniMax, while Codex keeps planning, review, security-sensitive work, deployment decisions, and final verification.

The intended chain is:

```text
Codex -> minimax-agent-router -> claude-minimax wrapper -> Claude Code CLI -> MiniMax Anthropic-compatible API
```

## When To Use It

Use this plugin for low-risk implementation work:

- Unit tests and small test fixes.
- Documentation edits.
- Lint, TypeScript, import, formatting, and mechanical refactor chores.
- Small bug fixes with clear reproduction and narrow file scope.
- Small helper functions or components that Codex will review afterwards.

Keep these in Codex:

- Requirements, architecture, planning, and product judgment.
- Secrets, authentication, authorization, database migrations, deployments, and rollbacks.
- Code review, integration, final verification, and user-facing conclusions.

## Requirements

- Windows, macOS, or Linux with Node.js available in `PATH`.
- Codex CLI/app with plugin support.
- Claude Code CLI available in `PATH`.
- A MiniMax subscription key.

Do not commit or paste MiniMax keys into config files. Use environment variables only.

## Install From GitHub Marketplace

Add this repository as a Codex plugin marketplace:

```cmd
codex plugin marketplace add nogreenmountain/minimax-agent-router --ref main --sparse .agents/plugins --sparse plugins/minimax-agent-router
```

Install the plugin:

```cmd
codex plugin add minimax-agent-router@nogreenmountain
```

Check it:

```cmd
codex plugin list
```

You should see `minimax-agent-router@nogreenmountain` as installed and enabled.

Restart Codex after installing so the new skill is loaded in new tasks.

## Configure MiniMax

Set a user-level environment variable.

On Windows `cmd.exe`:

```cmd
setx MINIMAX_API_KEY "your-new-minimax-key"
```

Close and reopen Codex/terminal after `setx`.

On PowerShell for the current session:

```powershell
$env:MINIMAX_API_KEY="your-new-minimax-key"
```

On PowerShell as a persistent user variable:

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "your-new-minimax-key", "User")
```

`MINIMAX_SUBSCRIPTION_KEY` is also accepted.

## Smoke Test

After installing and restarting Codex, ask Codex:

```text
用 minimax-agent-router 打印一个 hi
```

Or run the router directly from a cloned copy:

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
node .\src\cli.js doctor --config .\agent-router.config.json
node .\src\cli.js run --agent claude-minimax --task "请只回复：hi" --json --config .\agent-router.config.json
```

Expected result:

```json
{
  "status": "ok",
  "stdout": "hi\n"
}
```

## Delegate A Real Task

Use a bounded prompt:

```text
Workspace: C:\absolute\path\to\repo

Task:
Fix one specific failing test.

Scope:
Only edit src/foo.ts and test/foo.test.ts.

Constraints:
- Preserve existing style.
- Do not run destructive git commands.
- Do not modify secrets, credentials, deploy files, or unrelated modules.
- Stop and explain if the scope is unclear.

Output:
- Changed files
- Tests run
- Remaining issues
```

Codex should inspect the result, review any diff, run relevant tests, and decide whether to accept or revise the delegated work.

## Local Development

Run tests from the plugin router directory:

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
npm test
```

Validate the plugin with Codex's plugin validator if available on your machine:

```cmd
python path\to\plugin-creator\scripts\validate_plugin.py plugins\minimax-agent-router
```

## Security Notes

- Never store API keys in `agent-router.config.json`, README files, task prompts, or Git history.
- Delegated task prompts and relevant code context may be sent to MiniMax through the Anthropic-compatible endpoint.
- Keep sensitive review, auth, permissions, deployment, and database work in Codex unless there is a very narrow, reviewed task.
