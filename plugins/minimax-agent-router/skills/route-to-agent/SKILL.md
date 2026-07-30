---
name: route-to-agent
description: Assess and route only well-fitted, scoped chores from Codex to Claude Code CLI backed by MiniMax through the plugin-bundled agent-router. Use when the user wants Codex to supervise Claude Code, use MiniMax token-plan quota, run independent low-cost workers, choose model/effort, or monitor delegated work. Keep Codex responsible for architecture, unfamiliar APIs, platform integration, security, review, deployments, and final verification.
---

# Route To Agent

Use this plugin as a guarded junior-to-mid-level worker pool:

```text
Codex lead -> task-fit gate -> agent-router -> Claude Code CLI -> MiniMax
```

MiniMax output is a draft. A successful process exit means only `reviewStatus=pending-codex`; it never means the task is verified.

## Mandatory Routing Flow

1. Classify the task before invoking MiniMax.
2. Keep architecture, cross-module contracts, unfamiliar APIs, Windows COM/Office automation, security, permissions, secrets, database migrations, deployment, release, and final acceptance with Codex.
3. Split suitable work into one file, one source/test pair, or one clear directory.
4. Target 3-5 minutes per worker. The default hard budget is 300000 ms.
5. Run `route` with the complete delegation prompt.
6. Invoke `run` or `run-many` only when the route returns `assessment.decision=delegate`.
7. Inspect every changed file and rerun verification as Codex.

Do not bypass a Codex decision by specifying `--agent`. The safety gate still owns the decision.

## Suitable Tasks

Delegate bounded drafts for:

- Independent technical research or option comparison with evidence.
- README, operating instructions, and documentation cleanup.
- Test case skeletons and focused unit tests.
- A single file, small component, helper, or mechanical edit using established project APIs.
- Repetitive implementations behind an existing interface.
- Read-only code review or analysis that Codex will verify.

Use parallel workers only for independent tasks with non-overlapping scopes. Research and documentation are good parallel candidates. Core implementation should normally be split into sequential phases.

## Unsuitable Tasks

Keep these with Codex:

- New framework or unfamiliar API architecture without verified examples.
- Windows COM, Office, PowerPoint, shell/encoding, or other fragile platform integration.
- Large multi-module implementations or shared interface changes.
- Security, auth, permissions, secrets, audit, migrations, production data, deployment, rollback, and release.
- Final review, acceptance, publication, or claims that work is complete.
- Work where strict file ownership cannot be stated confidently.

## Structured Task Contract

Prefer a structured task object:

```json
{
  "id": "date-format-fix",
  "kind": "small-code",
  "workspace": "C:\\absolute\\project",
  "task": "Fix the known date-format boundary condition.",
  "scope": [
    "src/date-format.ts",
    "test/date-format.test.ts"
  ],
  "testCommand": "npm test -- date-format",
  "estimatedMinutes": 4,
  "apiExamples": [
    "formatDate(value, { timeZone: 'UTC' })"
  ],
  "constraints": [
    "Preserve existing style."
  ]
}
```

Use `kind=research` plus `readOnly=true` for analysis that must not edit files. For unfamiliar third-party APIs, include a verified call in `apiExamples`; otherwise keep implementation with Codex.

The router automatically adds these prompt guardrails:

- Modify only `scope`.
- Create no scratch, temp, or helper files outside `scope`.
- Do not expand into new modules.
- Run the exact `testCommand` and paste real output.
- Report uncertainty and partial work.
- Remind the worker that Codex will inspect and verify the result.

Use `assets/single-task.example.json`, `assets/parallel-tasks.example.json`, and `assets/delegated-task-template.md` as reusable templates.

## Commands

Find `<plugin-root>` from this `SKILL.md` path, then use `<plugin-root>\scripts\agent-router`.

Check readiness:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" doctor --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Preflight a task without spending MiniMax quota:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" route --task-file "<task.json>" --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Run one accepted task:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" run --agent claude-minimax --model "MiniMax-M3[1m]" --think low --task-file "<task.json>" --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Run an accepted independent batch:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" run-many --tasks "<tasks.json>" --parallel 3 --agent claude-minimax --model "MiniMax-M3[1m]" --think low --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

`run-many` emits worker start and finish events to stderr while preserving final JSON on stdout. Use `--quiet` only when progress output is undesirable.

## Timeout Recovery

When a worker returns `status=timed-out` or `partialChangesPossible=true`:

1. Stop further delegation in the same scope.
2. Inspect `git status` and the diff because partial files may remain.
3. Decide whether to keep, repair, or discard the partial work.
4. Split the remaining work into a smaller task before retrying.

## Final Verification

Codex must inspect stdout/stderr, review the diff, check for scope violations and invented APIs, run the exact test independently, perform platform or UI checks where relevant, and make the final acceptance decision.

Set `MINIMAX_API_KEY` or `MINIMAX_SUBSCRIPTION_KEY` in the environment only. Never write keys into repository files.
