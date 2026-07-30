# MiniMax Agent Router for Codex

这是一个 Codex 插件，用来把低风险、边界清楚的编码杂活交给 Claude Code CLI 执行，并让 Claude Code 走 MiniMax 的 Anthropic 兼容接口。

整体链路是：

```text
Codex -> minimax-agent-router -> claude-minimax wrapper -> Claude Code CLI -> MiniMax
```

简单说：Codex 当负责人，MiniMax 当执行助手。

## v0.3 更新方向：先判断值不值得派

这一版新增 `Task Gate`。插件会先判断任务是否适合 MiniMax，再决定是否调用模型，避免把高风险、过宽或缺少验收条件的工作派出去浪费时间。

默认规则：

- 单个 worker 目标用时 3-5 分钟，硬超时从 10 分钟调整为 5 分钟。
- 编辑任务必须写清一个文件、一个源码/测试文件对，或一个明确目录。
- 代码和测试任务必须提供一个准确的 `testCommand`。
- 陌生第三方 API 必须提供经过确认的 `apiExamples`，否则交回 Codex。
- Windows COM、Office 自动化、多模块核心实现、安全、权限、部署和最终验收直接留给 Codex。
- 即使显式指定 `--agent claude-minimax`，也不能绕过 Task Gate。
- worker 退出码为 0 只表示执行结束，结果会标记为 `reviewStatus=pending-codex`。
- 超时结果标记 `partialChangesPossible=true`，提醒 Codex 检查工作区半成品。

## 适合交给 MiniMax 的任务

- 补单元测试、修小测试。
- 改 README、文档、注释。
- 修 lint、TypeScript、import、格式化这类机械问题。
- 有明确复现路径的小 bug。
- 范围很窄的小组件、小 helper 函数。
- 不修改文件的独立调研、方案比较和初步代码审查。

## 仍然应该由 Codex 负责的任务

- 需求澄清、方案设计、架构判断。
- 安全、密钥、登录鉴权、权限、审计、数据库迁移、部署和回滚。
- 代码审查、集成判断、最终测试、最终交付说明。
- 文件范围或风险边界不清楚的任务。
- 陌生 API、新框架核心架构、Windows COM / Office / PowerPoint 自动化。
- 多模块共享接口的大型实现和最终发布判断。

MiniMax 的输出只当草稿，Codex 需要继续检查 diff、跑测试，再决定是否接受。

## 前置要求

另一台电脑需要先有：

- Codex CLI / Codex 桌面端。
- Node.js，并且 `node` 可以在终端里运行。
- Claude Code CLI，并且 `claude` 可以在终端里运行。
- MiniMax Subscription Key。

不要把 MiniMax key 写进配置文件、README 或 Git 记录里，只放环境变量。

## 从 GitHub 安装插件

在目标电脑打开 CMD 或 PowerShell，先添加这个 GitHub 仓库作为 Codex 插件市场：

```cmd
codex plugin marketplace add nogreenmountain/minimax-agent-router --ref main --sparse .agents/plugins --sparse plugins/minimax-agent-router
```

然后安装插件：

```cmd
codex plugin add minimax-agent-router@nogreenmountain
```

检查插件：

```cmd
codex plugin list
```

看到类似下面内容就说明插件已经安装：

```text
minimax-agent-router@nogreenmountain installed, enabled
```

安装后建议重启 Codex，这样新任务里才能加载到插件技能。

## 设置 MiniMax Key

Windows 推荐设置成用户级环境变量。

CMD：

```cmd
setx MINIMAX_API_KEY "你的MiniMaxKey"
```

PowerShell：

```powershell
[Environment]::SetEnvironmentVariable("MINIMAX_API_KEY", "你的MiniMaxKey", "User")
```

设置完后关闭并重新打开 Codex / 终端。

如果只想在当前 PowerShell 窗口临时测试：

```powershell
$env:MINIMAX_API_KEY="你的MiniMaxKey"
```

也支持变量名：

```text
MINIMAX_SUBSCRIPTION_KEY
```

## 烟测

重启 Codex 后，可以直接问 Codex：

```text
用 minimax-agent-router 打印一个 hi
```

也可以在克隆下来的仓库里直接跑 router：

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
node .\src\cli.js doctor --config .\agent-router.config.json
node .\src\cli.js run --agent claude-minimax --task "请只回复：hi" --json --config .\agent-router.config.json
```

成功时会看到：

```json
{
  "status": "ok",
  "stdout": "hi\n"
}
```

## 真实任务怎么写

交给 MiniMax 的任务要写得窄一点，最好包含工作目录、任务、允许改的范围、限制和输出要求。

模板：

```text
Workspace: C:\你的项目绝对路径

Task:
修复一个明确的小问题，例如某个失败测试、某个 lint 报错、某个文档段落。

Scope:
只允许修改 src/foo.ts 和 test/foo.test.ts。

Constraints:
- 保持现有代码风格。
- 不运行破坏性 git 命令。
- 不修改密钥、凭据、部署文件或无关模块。
- 如果范围不清楚，停止并说明。

Output:
- 改了哪些文件
- 跑了哪些测试
- 还有什么未解决问题
```

Codex 拿到结果后，仍然要检查输出、查看 diff、跑相关测试，再给最终答复。

## 推荐流程

先做免费预检，不调用 MiniMax：

```cmd
node .\src\cli.js route --task-file single-task.json --json --config .\agent-router.config.json
```

只有返回下面结果时才执行：

```json
{
  "assessment": {
    "decision": "delegate",
    "fit": "good"
  }
}
```

如果返回 `decision=codex`，按 `reasons` 缩小任务或直接由 Codex 完成，不要靠 `--agent` 强行绕过。

推荐的结构化任务字段：

```json
{
  "id": "date-format-fix",
  "kind": "small-code",
  "task": "修复一个已知日期格式化边界条件。",
  "scope": [
    "src/date-format.ts",
    "test/date-format.test.ts"
  ],
  "testCommand": "npm test -- date-format",
  "estimatedMinutes": 4,
  "apiExamples": [
    "formatDate(value, { timeZone: 'UTC' })"
  ]
}
```

`kind` 建议使用：`research`、`docs`、`tests`、`small-code`、`mechanical`、`review`。只读分析再加 `readOnly: true`。

预检通过后执行同一份任务文件：

```cmd
node .\src\cli.js run --task-file single-task.json --agent claude-minimax --json --config .\agent-router.config.json
```

仓库内的 `plugins/minimax-agent-router/assets/single-task.example.json` 可以直接作为模板。

## 并行子智能体模式

`run-many` 可以把多个互不冲突的小任务同时交给 MiniMax worker 执行。它适合用来增效，但前提是 Codex 先把任务拆清楚，并且每个 worker 的文件范围不能重叠。

适合并行的例子：

```text
Worker A：只补 backend route tests
Worker B：只整理 README / docs
Worker C：只修 frontend lint / type 小问题
Worker D：只做只读分析，不改文件
```

不适合并行的例子：

```text
多个 worker 同时改同一个文件
数据库迁移
权限 / 认证 / 审计逻辑
部署脚本
生产配置
架构决策
大范围重构
```

并行任务文件可以写成：

```json
{
  "tasks": [
    {
      "id": "backend-tests",
      "task": "Add focused tests for the selected backend helper.",
      "scope": "Only edit tests/backend/**.",
      "constraints": [
        "Preserve existing test style.",
        "Do not modify production code."
      ],
      "output": "Summarize changed files, tests run, and remaining issues."
    },
    {
      "id": "docs-polish",
      "task": "Polish the README section for the documented feature.",
      "scope": "Only edit README.md and docs/**.",
      "constraints": "Do not add secrets or credentials.",
      "output": "Summarize changed files and unclear wording."
    }
  ]
}
```

执行：

```cmd
node .\src\cli.js run-many --tasks parallel-tasks.json --parallel 3 --agent claude-minimax --json --config .\agent-router.config.json
```

`run-many` 会返回每个 worker 的结果，并给出汇总：

```text
totalTasks：任务总数
okTasks：成功执行的 worker 数
errorTasks：失败的 worker 数
codexTasks：因为命中高风险关键词而保留给 Codex 的任务数
timedOutTasks：触发 5 分钟预算的任务数
pendingReviewTasks：等待 Codex 检查和复测的任务数
```

并行运行期间，stderr 会实时打印每个 worker 的 `started` / `finished`，最终 JSON 仍保持在 stdout。需要安静输出时加 `--quiet`。

注意：并行执行的结果仍然不是最终交付。Codex 必须回收所有结果、检查 diff、解决冲突、跑最终测试。

## 直接使用 router 命令

进入 router 目录：

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
```

查看可用代理：

```cmd
node .\src\cli.js doctor --config .\agent-router.config.json
```

查看 MiniMax 设置帮助：

```cmd
node .\src\cli.js minimax --config .\agent-router.config.json
```

执行一次委派：

```cmd
node .\src\cli.js run --agent claude-minimax --task "请只回复：MiniMax Claude Code OK" --json --config .\agent-router.config.json
```

并行执行多个独立小任务：

```cmd
node .\src\cli.js run-many --tasks parallel-tasks.json --parallel 3 --agent claude-minimax --json --config .\agent-router.config.json
```

查看统计：

```cmd
node .\src\cli.js stats --config .\agent-router.config.json
```

打开本地监控页：

```cmd
node .\src\cli.js monitor --port 8787 --config .\agent-router.config.json
```

然后浏览器打开：

```text
http://127.0.0.1:8787
```

## 本地开发和验证

运行测试：

```cmd
cd plugins\minimax-agent-router\scripts\agent-router
npm test
```

如果本机有 Codex 插件校验脚本，也可以校验插件：

```cmd
python path\to\plugin-creator\scripts\validate_plugin.py plugins\minimax-agent-router
```

## 安全提醒

- 不要提交任何 API key。
- 不要把 `MINIMAX_API_KEY` 写进 `agent-router.config.json`。
- 委派给 MiniMax 的任务内容和相关代码上下文可能会发送到 MiniMax。
- 涉及认证、权限、审计、数据库、部署、生产数据的任务，默认留给 Codex 做。
