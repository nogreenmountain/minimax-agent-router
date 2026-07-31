import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const cliPath = path.resolve("src/cli.js");

describe("agent-router CLI", () => {
  it("prints route decisions as JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    const result = runCli(["route", "--task", "帮我规划一个实现步骤", "--json", "--config", configPath], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runByCodex, true);
    assert.equal(payload.agentName, "codex");
    assert.equal(payload.assessment.decision, "codex");
  });

  it("blocks risky work even when an agent is explicitly requested", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    const result = runCli([
      "route",
      "--task",
      "用 Windows COM 实现 PowerPoint 自动化核心模块",
      "--agent",
      "nodeEcho",
      "--json",
      "--config",
      configPath
    ], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runByCodex, true);
    assert.match(payload.reason, /platform integration/i);
  });

  it("accepts a scoped short task with an exact test command", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);
    const task = [
      "Task: fix the known parser boundary condition",
      "Scope: src/parser.js",
      "Test Command: npm test -- parser"
    ].join("\n");

    const result = runCli(["route", "--task", task, "--json", "--config", configPath], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.runByCodex, false);
    assert.equal(payload.assessment.decision, "delegate");
    assert.equal(payload.assessment.fit, "good");
  });

  it("routes and runs a structured single-task JSON file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);
    const taskPath = path.join(tmpDir, "task.json");
    fs.writeFileSync(taskPath, JSON.stringify({
      kind: "tests",
      task: "Add one focused parser test.",
      scope: ["test/parser.test.js"],
      testCommand: "npm test -- parser",
      estimatedMinutes: 3
    }), "utf8");

    const routeResult = runCli(["route", "--task-file", taskPath, "--json", "--config", configPath], tmpDir);
    assert.equal(routeResult.status, 0, routeResult.stderr);
    assert.equal(JSON.parse(routeResult.stdout).assessment.decision, "delegate");

    const runResult = runCli([
      "run",
      "--task-file",
      taskPath,
      "--agent",
      "nodeEcho",
      "--json",
      "--config",
      configPath
    ], tmpDir);
    assert.equal(runResult.status, 0, runResult.stderr);
    const payload = JSON.parse(runResult.stdout);
    assert.equal(payload.status, "ok");
    assert.match(payload.stdout, /Only modify files listed in Scope/);
    assert.match(payload.stdout, /npm test -- parser/);
  });

  it("runs an explicit agent and writes a log", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    const result = runCli([
      "run",
      "--task",
      "请只回复：hello",
      "--agent",
      "nodeEcho",
      "--model",
      "mini",
      "--think",
      "low",
      "--json",
      "--config",
      configPath
    ], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "ok");
    assert.equal(payload.reviewStatus, "pending-codex");
    assert.equal(payload.stdout, "pong:请只回复：hello");
    assert.equal(fs.existsSync(path.join(tmpDir, ".agent-router", "runs.jsonl")), true);
  });

  it("runs many tasks from a JSON file and prints a summary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);
    const tasksPath = path.join(tmpDir, "tasks.json");
    fs.writeFileSync(
      tasksPath,
      JSON.stringify([
        { id: "docs", kind: "docs", task: "write docs", scope: ["README.md"] },
        { id: "tests", kind: "tests", task: "write tests", scope: ["test/foo.test.js"], testCommand: "npm test -- foo" }
      ]),
      "utf8"
    );

    const result = runCli([
      "run-many",
      "--tasks",
      tasksPath,
      "--parallel",
      "2",
      "--json",
      "--config",
      configPath
    ], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "ok");
    assert.equal(payload.reviewStatus, "pending-codex");
    assert.equal(payload.summary.totalTasks, 2);
    assert.equal(payload.summary.okTasks, 2);
    assert.equal(payload.summary.pendingReviewTasks, 2);
    assert.deepEqual(payload.results.map((entry) => entry.taskId), ["docs", "tests"]);
    assert.deepEqual(payload.results.map((entry) => entry.reviewStatus), ["pending-codex", "pending-codex"]);
    assert.match(result.stderr, /started/);
    assert.match(result.stderr, /finished/);
  });

  it("prints stats as JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    runCli(["run", "--task", "请只回复：hello", "--agent", "nodeEcho", "--json", "--config", configPath], tmpDir);
    const result = runCli(["stats", "--json", "--config", configPath], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.totalRuns, 1);
    assert.equal(payload.byAgent.nodeEcho.runs, 1);
  });

  it("reports missing env requirements in doctor output", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = path.join(tmpDir, "agent-router.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          gated: {
            enabled: true,
            command: process.execPath,
            requiredEnvAny: ["MISSING_ONE", "MISSING_TWO"]
          }
        }
      }),
      "utf8"
    );

    const result = runCli(["doctor", "--json", "--config", configPath], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const gated = payload.find((entry) => entry.agent === "gated");
    assert.equal(gated.available, false);
    assert.deepEqual(gated.missingEnvAny, ["MISSING_ONE", "MISSING_TWO"]);
  });

  it("prints a MiniMax setup guide", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    const result = runCli(["minimax", "--config", configPath], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MINIMAX_API_KEY/);
    assert.match(result.stdout, /set MINIMAX_API_KEY=/);
    assert.match(result.stdout, /\$env:MINIMAX_API_KEY/);
    assert.match(result.stdout, /claude-minimax/);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /run/);
  });

  it("reports project-isolated Headroom readiness", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-headroom-cli-"));
    const configPath = path.join(tmpDir, "agent-router.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        headroom: {
          mode: "auto",
          command: path.join(tmpDir, "missing-headroom.exe"),
          stateRoot: path.join(tmpDir, "state")
        }
      }),
      "utf8"
    );

    const result = runCli(["headroom", "doctor", "--json", "--config", configPath], tmpDir);

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "not-installed");
    assert.equal(payload.installed, false);
    assert.equal(payload.memoryScope, "project");
    assert.match(payload.workspaceId, /headroom-cli/i);
  });

  it("starts, reuses, and stops a router-managed Headroom proxy", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-headroom-cli-"));
    const fakeHeadroomPath = path.join(tmpDir, "fake-headroom.cjs");
    const claudeConfigDir = path.join(tmpDir, "claude-config");
    const configPath = path.join(tmpDir, "agent-router.config.json");
    fs.mkdirSync(claudeConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeConfigDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
          ANTHROPIC_AUTH_TOKEN: "local-gateway-token"
        }
      }),
      "utf8"
    );
    fs.writeFileSync(
      fakeHeadroomPath,
      [
        "const http = require('node:http');",
        "const args = process.argv.slice(2);",
        "const port = Number(args[args.indexOf('--port') + 1]);",
        "const upstream = args[args.indexOf('--anthropic-api-url') + 1];",
        "http.createServer((req, res) => {",
        "  res.setHeader('content-type', 'application/json');",
        "  if (req.url === '/health') return res.end(JSON.stringify({ status: 'healthy', config: { anthropic_api_url: upstream } }));",
        "  if (req.url === '/stats-history') return res.end(JSON.stringify({ lifetime: { requests: 3, total_input_tokens: 200, tokens_saved: 50 } }));",
        "  if (req.url === '/stats') return res.end(JSON.stringify({ stats: { total_requests: 3, tokens_input: 200, tokens_saved: 50 } }));",
        "  res.statusCode = 404; res.end('{}');",
        "}).listen(port, '127.0.0.1');"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        headroom: {
          mode: "required",
          command: process.execPath,
          commandArgs: [fakeHeadroomPath],
          stateRoot: path.join(tmpDir, "state"),
          startupTimeoutMs: 5000,
          portRangeStart: 20300,
          portRangeSize: 100
        }
      }),
      "utf8"
    );

    const cliEnv = { CLAUDE_CONFIG_DIR: claudeConfigDir };
    const start = runCli(["headroom", "start", "--json", "--config", configPath], tmpDir, {
      env: cliEnv
    });
    assert.equal(start.status, 0, start.stderr);
    assert.equal(JSON.parse(start.stdout).status, "started");
    assert.equal(JSON.parse(start.stdout).upstreamUrl, "http://127.0.0.1:15721");

    const reused = runCli(["headroom", "start", "--json", "--config", configPath], tmpDir, {
      env: cliEnv
    });
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(JSON.parse(reused.stdout).status, "reused");

    const stats = runCli(["headroom", "stats", "--json", "--config", configPath], tmpDir);
    assert.equal(stats.status, 0, stats.stderr);
    assert.equal(JSON.parse(stats.stdout).tokensSaved, 50);

    const stop = runCli(["headroom", "stop", "--json", "--config", configPath], tmpDir);
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).status, "stopped");
  });

  it("shows a MiniMax hint in doctor text output when claude-minimax is missing env", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = path.join(tmpDir, "agent-router.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          "claude-minimax": {
            enabled: true,
            command: process.execPath,
            requiredEnvAny: ["MINIMAX_API_KEY", "MINIMAX_SUBSCRIPTION_KEY"],
            defaultModel: "MiniMax-M3[1m]",
            defaultThink: "low"
          }
        }
      }),
      "utf8"
    );

    const result = runCli(["doctor", "--config", configPath], tmpDir, { clearMiniMaxEnv: true });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /set MINIMAX_API_KEY=/);
    assert.match(result.stdout, /\$env:MINIMAX_API_KEY/);
    assert.match(result.stdout, /agent-router minimax/);
  });
});

function writeConfig(tmpDir) {
  const configPath = path.join(tmpDir, "agent-router.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        logPath: ".agent-router/runs.jsonl",
        defaults: { agent: "nodeEcho", think: "low", timeoutMs: 10000 },
        routing: {
          codexKeywords: ["规划", "review", "生图"],
          preferredAgentOrder: ["nodeEcho"]
        },
        agents: {
          nodeEcho: {
            enabled: true,
            command: process.execPath,
            args: ["-e", "process.stdin.on('data', d => process.stdout.write('pong:' + d))"],
            promptMode: "stdin",
            defaultModel: "mini",
            defaultThink: "low",
            pricing: { inputPer1k: 0, outputPer1k: 0 }
          }
        }
      },
      null,
      2
    )
  );
  return configPath;
}

function runCli(args, cwd, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  if (options.clearMiniMaxEnv) {
    delete env.MINIMAX_API_KEY;
    delete env.MINIMAX_SUBSCRIPTION_KEY;
  }

  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
    windowsHide: true
  });
}
