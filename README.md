# MiniMax Agent Router for Codex

这是一个 Codex 插件，用来把低风险、边界清楚的编码杂活交给 Claude Code CLI 执行，并让 Claude Code 走 MiniMax 的 Anthropic 兼容接口。

整体链路是：

```text
Codex -> minimax-agent-router -> claude-minimax wrapper -> Claude Code CLI -> MiniMax
```

简单说：Codex 当负责人，MiniMax 当执行助手。

## 适合交给 MiniMax 的任务

- 补单元测试、修小测试。
- 改 README、文档、注释。
- 修 lint、TypeScript、import、格式化这类机械问题。
- 有明确复现路径的小 bug。
- 范围很窄的小组件、小 helper 函数。

## 仍然应该由 Codex 负责的任务

- 需求澄清、方案设计、架构判断。
- 安全、密钥、登录鉴权、权限、审计、数据库迁移、部署和回滚。
- 代码审查、集成判断、最终测试、最终交付说明。
- 文件范围或风险边界不清楚的任务。

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
