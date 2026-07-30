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
  const env = { ...process.env };
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
