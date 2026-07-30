# MiniMax Agent Router Plugin

这个 Codex 插件封装了本地 `agent-router` 链路：

```text
Codex -> agent-router -> claude-minimax -> Claude Code CLI -> MiniMax
```

## 分工方式

Codex 是负责人，负责需求、计划、架构、安全、代码审查、集成测试、最终验证和最终回复。

Claude Code + MiniMax 是执行助手，适合处理边界明确的小任务：补测试、小 bug、文档、lint/type 修复、格式化、机械重构、小 helper 或小组件。

MiniMax 的输出不是最终结果，必须由 Codex 检查后再采用。

## Task Gate

插件现在默认先做任务适配判断。高风险、过宽、预计超过 5 分钟、编辑范围不清、代码任务没有准确测试命令、陌生 API 没有示例的任务会直接返回给 Codex，不调用 MiniMax。

`--agent claude-minimax` 不能绕过这个判断。成功执行的结果会标记 `reviewStatus=pending-codex`；超时结果会标记 `status=timed-out` 和 `partialChangesPossible=true`。

## 设置 MiniMax Key

CMD 当前窗口：

```cmd
set MINIMAX_API_KEY=<你的MiniMaxKey>
```

PowerShell 当前窗口：

```powershell
$env:MINIMAX_API_KEY="<你的MiniMaxKey>"
```

Windows 用户级环境变量：

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "<你的MiniMaxKey>", "User")
```

也支持：

```text
MINIMAX_SUBSCRIPTION_KEY
```

不要把 key 写进 `agent-router.config.json`。

## 常用命令

进入 router 目录：

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
```

检查是否可用：

```cmd
node .\src\cli.js doctor --config .\agent-router.config.json
```

查看 MiniMax 配置帮助：

```cmd
node .\src\cli.js minimax --config .\agent-router.config.json
```

烟测：

```cmd
node .\src\cli.js run --agent claude-minimax --task "请只回复：MiniMax Claude Code OK" --json --config .\agent-router.config.json
```

真实委派任务：

```cmd
node .\src\cli.js run --agent claude-minimax --task "Workspace: C:\你的项目绝对路径
Task: <具体任务>
Scope: <允许修改的文件或目录>
Constraints: 保持现有风格；不要运行破坏性 git 命令；不要碰密钥。
Output: 总结改了哪些文件、跑了哪些测试、还有什么问题。" --json --config .\agent-router.config.json
```

建议先运行免费预检：

```cmd
node .\src\cli.js route --task-file single-task.json --json --config .\agent-router.config.json
```

仅当 `assessment.decision=delegate` 时继续执行。

```cmd
node .\src\cli.js run --task-file single-task.json --agent claude-minimax --json --config .\agent-router.config.json
```

结构化单任务模板见 `assets/single-task.example.json`。

并行委派多个互不冲突的小任务：

```cmd
node .\src\cli.js run-many --tasks parallel-tasks.json --parallel 3 --agent claude-minimax --json --config .\agent-router.config.json
```

`parallel-tasks.json` 可以写成对象：

```json
{
  "tasks": [
    {
      "id": "backend-tests",
      "kind": "tests",
      "task": "补 backend route 单元测试。",
      "scope": ["tests/backend/test_route.py"],
      "testCommand": "pytest tests/backend/test_route.py -q",
      "estimatedMinutes": 4,
      "constraints": "保持现有测试风格，不修改生产代码。",
      "output": "总结改了哪些文件、跑了哪些测试、还有什么问题。"
    },
    {
      "id": "docs-polish",
      "kind": "docs",
      "task": "整理 README 的功能说明。",
      "scope": ["README.md"],
      "estimatedMinutes": 3,
      "constraints": "不要写入任何密钥或凭据。",
      "output": "总结改动和未确认问题。"
    }
  ]
}
```

并行模式只适合文件范围隔离清楚的任务。不要用它处理权限、认证、审计、数据库迁移、部署、生产配置或大范围重构。

并行执行时会实时输出 worker 的开始和结束状态。最终结果里的 `pendingReviewTasks` 必须由 Codex 检查 diff 和复跑测试后清零。

查看统计：

```cmd
node .\src\cli.js stats --config .\agent-router.config.json
```

启动监控页：

```cmd
node .\src\cli.js monitor --port 8787 --config .\agent-router.config.json
```

浏览器打开：

```text
http://127.0.0.1:8787
```

## 验证

从 `scripts/agent-router` 目录运行：

```cmd
npm test
```
