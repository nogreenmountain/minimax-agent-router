# Delegated Task Template

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

