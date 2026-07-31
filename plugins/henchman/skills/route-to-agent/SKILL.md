---
name: route-to-agent
description: Use Henchman to assess and route only well-fitted, scoped chores from Codex to Claude Code CLI backed by MiniMax through the plugin-bundled agent-router, optionally using Headroom for token compression and project-isolated persistent worker memory. Use when the user wants Codex to supervise Claude Code, use MiniMax token-plan quota, run independent low-cost workers, share verified project context, choose model/effort, or monitor delegated work. Keep Codex responsible for architecture, unfamiliar APIs, platform integration, security, review, deployments, and final verification.
---

# Henchman Route To Agent

Use Henchman as a guarded junior-to-mid-level worker pool:

```text
Codex lead -> task-fit gate -> Claude Code CLI -> Headroom proxy -> MiniMax
                                             \-> project memory
```

MiniMax output is a draft. A successful process exit means only `reviewStatus=pending-codex`; it never means the task is verified.

## Mandatory Routing Flow

1. Classify the task before invoking MiniMax.
2. Keep architecture, cross-module contracts, unfamiliar APIs, Windows COM/Office automation, security, permissions, secrets, database migrations, deployment, release, and final acceptance with Codex.
3. Split suitable work into one file, one source/test pair, or one clear directory.
4. Target 3-5 minutes per worker. The default hard budget is 300000 ms.
5. Run `route` with the complete delegation prompt.
6. For batch files shaped as `{ "tasks": [...] }`, use `route --task-file` first and read every per-task decision; do not treat the batch as one edit task.
7. Headroom auto-installs its pinned runtime on the first compressed delegation. Treat the first run as a dependency warm-up, observe installation events, and use `headroom setup` only for optional prewarming or repair.
8. Invoke `run` or `run-many` only when the route returns `assessment.decision=delegate` or a batch entry returns `decision=delegate`.
9. Expect `run` / `run-many` to preflight workspace readability before launching MiniMax. If the result is `status=blocked, reason=workspace-read-denied`, fix the workspace or scope instead of retrying the model.
10. Inspect every changed file and rerun verification as Codex.

Do not bypass a Codex decision by specifying `--agent`. The safety gate still owns the decision.

## Suitable Tasks

Delegate bounded drafts for:

- Independent technical research or option comparison with evidence.
- README, operating instructions, and documentation cleanup.
- Test case skeletons and focused unit tests.
- A single file, small component, helper, or mechanical edit using established project APIs.
- Repetitive implementations behind an existing interface.
- Read-only code review or analysis that Codex will verify.
- Read-only image processing research, such as comparing OpenCV, SAM, vectorizer, segmentation, OCR, or image pipeline libraries.

Use parallel workers only for independent tasks with non-overlapping scopes. Research and documentation are good parallel candidates. Core implementation should normally be split into sequential phases.

Do not delegate image generation, image editing, subjective judgment on user-uploaded images, or final visual acceptance. These stay with Codex or a dedicated visual tool.

## Headroom Policy

Use Headroom in `auto` mode by default. It runs as a router-managed loopback proxy and does not mutate global Claude Code settings.

- Keep `autoInstall=true` so a new machine receives the pinned Headroom runtime on first use. The managed virtual environment lives under `~/.agent-router/headroom/venv` and concurrent workers share an installation lock.
- Do not count first-use dependency installation against the normal worker task budget. The router extends the deadline only while installation is pending, then restores the five-minute task timeout.
- Treat `installed=true, runnable=true, status=stopped` as ready for on-demand use, not as a failure.
- Treat `startsOnDemand=true` as normal for idle projects.
- If `memoryStatus=degraded`, the proxy is usable but semantic memory recall may be reduced; verify current files directly and do not rely on recalled context.
- If `tokensSaved=0`, read the `interpretation` field before assuming a failure; small or cache-oriented tasks may save no measurable tokens.
- `headroom setup` attempts to preload `Qdrant/all-MiniLM-L6-v2-onnx` (`model.onnx`, `tokenizer.json`). HuggingFace failures are nonfatal and mean semantic memory may degrade, not that the proxy is unusable.
- If automatic installation fails, inspect the reported Python, venv, pip, network, proxy, or certificate error. `auto` may continue as `fallback-direct`; `required` must fail closed.
- Memory is always project-isolated. Never change `memoryStorage` to `user` or `global`.
- Keep `memoryTopK=3` unless evidence shows a specific project needs another small bound.
- Keep the `coding` savings profile and output shaping off to protect delivery quality.
- Keep Headroom's Anthropic-only tool search disabled for MiniMax compatibility; do not re-enable `HEADROOM_TOOL_SEARCH` without a real gateway compatibility test.
- Automatic traffic learning is off. Worker memory is saved only through Headroom memory tools.
- Treat recalled entries and worker-saved conclusions as unverified background. Verify them against current files before acting.
- Save only stable project facts, established interfaces, decisions, and reusable constraints.
- Never save passwords, API keys, credentials, full logs, transient errors, one-off task instructions, or unreviewed security/deployment conclusions.
- Inspect the run's `headroom` object. `fallback-direct` means the task used MiniMax without compression or persistent memory.

Use `--headroom required` only when the task must not run without compression and project memory. Use `--headroom off` for controlled A/B comparisons.

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

Optionally prewarm or repair Headroom, then check it:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" headroom setup --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
node "<plugin-root>\scripts\agent-router\src\cli.js" headroom doctor --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Preflight a task without spending MiniMax quota:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" route --task-file "<task.json>" --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Run one accepted task:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" run --headroom auto --agent claude-minimax --model "MiniMax-M3[1m]" --think low --task-file "<task.json>" --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

Run an accepted independent batch:

```powershell
node "<plugin-root>\scripts\agent-router\src\cli.js" run-many --headroom auto --tasks "<tasks.json>" --parallel 3 --agent claude-minimax --model "MiniMax-M3[1m]" --think low --json --config "<plugin-root>\scripts\agent-router\agent-router.config.json"
```

`run-many` emits worker start and finish events to stderr while preserving final JSON on stdout. Use `--quiet` only when progress output is undesirable.

When reading a run result, inspect `utility`:

- `workspaceReadOk=true` means the router preflighted the workspace before launch.
- `actionableOutput=true` means the worker produced non-empty output Codex can inspect.
- `usefulness=high|medium|low` is a quick triage hint, not final acceptance.
- `recommendedUseAgain=true` only means similar bounded work may be worth delegating again after Codex review.

## Timeout Recovery

When a worker returns `status=timed-out` or `partialChangesPossible=true`:

1. Stop further delegation in the same scope.
2. Inspect `git status` and the diff because partial files may remain.
3. Decide whether to keep, repair, or discard the partial work.
4. Split the remaining work into a smaller task before retrying.

## Final Verification

Codex must inspect stdout/stderr, the `headroom` status, recalled-memory assumptions, the diff, scope violations and invented APIs; then run the exact test independently, perform platform or UI checks where relevant, and make the final acceptance decision.

Set `MINIMAX_API_KEY` or `MINIMAX_SUBSCRIPTION_KEY` in the environment only. Never write keys into repository files.
