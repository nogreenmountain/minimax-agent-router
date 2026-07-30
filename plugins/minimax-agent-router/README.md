# MiniMax Agent Router Plugin

这个 Codex 插件封装了本地 `agent-router` 链路：

```text
Codex -> agent-router -> claude-minimax -> Claude Code CLI -> MiniMax
```

## 分工方式

Codex 是负责人，负责需求、计划、架构、安全、代码审查、集成测试、最终验证和最终回复。

Claude Code + MiniMax 是执行助手，适合处理边界明确的小任务：补测试、小 bug、文档、lint/type 修复、格式化、机械重构、小 helper 或小组件。

MiniMax 的输出不是最终结果，必须由 Codex 检查后再采用。

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
