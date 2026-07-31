# Delegated Task Template

```text
Workspace: <absolute path>

Task:
<one specific task>

Task kind:
<research | docs | tests | small-code | mechanical | review>

Scope:
<one file, one source/test pair, or one clear directory>

Estimated time:
<3-5 minutes>

Verified API examples:
<required for unfamiliar APIs; omit for established project APIs>

Constraints:
- Preserve existing style.
- Do not run destructive git commands.
- Do not modify secrets, credentials, production deploy files, or unrelated modules.
- Do not create scratch, temp, or helper files outside Scope.
- Do not expand the task scope.
- If unsure, stop and explain.

Required verification:
Run exactly: <one concrete test command>
Paste the real command output. Do not replace it with a completion claim.

Output:
- Changed files
- Tests run
- Real test output
- Remaining issues

Codex must inspect the diff and independently rerun verification before acceptance.
```
