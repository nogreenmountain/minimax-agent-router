# Henchman Plugin

Henchman 封装了本地 `agent-router` 链路：

```text
Codex -> Task Gate -> Claude Code CLI -> Headroom 本地代理 -> MiniMax
                              \-> 项目隔离的持久记忆
```

## 分工方式

Codex 是负责人，负责需求、计划、架构、安全、代码审查、集成测试、最终验证和最终回复。

Claude Code + MiniMax 是执行助手，适合处理边界明确的小任务：补测试、小 bug、文档、lint/type 修复、格式化、机械重构、小 helper 或小组件。

MiniMax 的输出不是最终结果，必须由 Codex 检查后再采用。

## v0.6：可靠委派

v0.6.0 的目标是让 Henchman 从“能跑”变成“真的能帮 Codex 省时间”：

- worker 会收到当前 workspace root，并通过 Claude Code `--add-dir` 获得读项目文件的权限。
- `run` / `run-many` 启动前会做 workspace preflight；只读 scope 读不到时返回 `status=blocked, reason=workspace-read-denied`，不会消耗 MiniMax。
- `route` 能识别 `{ "tasks": [...] }` 批量文件，并逐个给出 `delegate` / `codex` 决策。
- 只读 image 相关调研可以交给 MiniMax；生成/编辑图片、视觉最终验收、用户上传图片主观判断仍归 Codex。
- Headroom `doctor` 增加 `startsOnDemand`，`stopped` 表示按需启动；`tokensSaved=0` 会给正常解释。
- `headroom setup` 会尝试预热 ONNX embedding 模型；下载失败只提示语义记忆可能降级，代理仍可用。
- 每次 run 增加 `utility` 字段，帮助 Codex 判断 worker 输出是否可行动、是否建议复用。

## Task Gate

插件现在默认先做任务适配判断。高风险、过宽、预计超过 5 分钟、编辑范围不清、代码任务没有准确测试命令、陌生 API 没有示例的任务会直接返回给 Codex，不调用 MiniMax。

`--agent claude-minimax` 不能绕过这个判断。成功执行的结果会标记 `reviewStatus=pending-codex`；超时结果会标记 `status=timed-out` 和 `partialChangesPossible=true`。

## Headroom 压缩和跨 Agent 记忆

插件默认以 `auto` 模式使用 Headroom：首次使用时自动在用户目录创建专用 Python 虚拟环境并安装固定版本 `headroom-ai[proxy]==0.33.0`，随后通过本地回环代理压缩重复上下文，并给每个工作区建立独立 SQLite 记忆库。自动安装或启动失败时返回 `fallback-direct` 后直连 MiniMax。

默认设置强调质量和隔离：`coding` 压缩配置、最多召回 3 条记忆、不启用输出塑形、不启用自动学习、禁止全局记忆。worker 保存的事实带有 `UNVERIFIED_WORKER` 语义，Codex 必须检查当前代码后才能采用。

为兼容 MiniMax 的 Anthropic 网关，路由器会关闭 Headroom 的 Anthropic 专用 `tool_search`；常规上下文压缩、CCR 和项目记忆不受影响。

通常不需要手动安装。第一次 MiniMax 委派或 `headroom start` 会自动安装；下面的 `setup` 只用于提前预热或修复：

```cmd
node .\src\cli.js headroom setup --config .\agent-router.config.json
node .\src\cli.js headroom doctor --config .\agent-router.config.json
```

自动安装目录为 `~/.agent-router/headroom/venv`。并发 worker 使用同一个安装锁，不会重复安装。设置 `AGENT_ROUTER_HEADROOM_AUTO_INSTALL=false` 可以关闭自动安装。

首次安装等待不计入 worker 的 5 分钟任务预算。Headroom 冷启动默认最多等待 5 分钟，以容纳 ONNX embedding 模型初始化。

如果自动安装失败，先确认 Python 3.10+ 和 `py -3`（Windows）或 `python3`（macOS/Linux）可用，再检查 pip 网络、代理和证书。`auto` 模式会回退直连，`required` 模式会停止并返回错误。

`headroom doctor` 中 `installed=true, runnable=true, status=stopped` 表示运行时已经就绪，只是当前项目没有常驻代理；任务会按需启动。如果 ONNX embedder warm-up 非致命失败，会显示 `memoryStatus=degraded`，此时代理和 MiniMax 可继续使用，但语义记忆召回可能降级。Windows 代理进程固定使用 UTF-8 输出。

查看当前项目代理和节省统计：

```cmd
node .\src\cli.js headroom start --config .\agent-router.config.json
node .\src\cli.js headroom stats --json --config .\agent-router.config.json
```

单次运行可以使用 `--headroom off` 或 `--headroom required` 覆盖默认模式。

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
cd plugins\henchman\scripts\agent-router
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
