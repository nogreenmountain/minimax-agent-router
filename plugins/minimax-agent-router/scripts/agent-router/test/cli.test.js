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
  });

  it("runs an explicit agent and writes a log", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    const result = runCli([
      "run",
      "--task",
      "hello",
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
    assert.equal(payload.stdout, "pong:hello");
    assert.equal(fs.existsSync(path.join(tmpDir, ".agent-router", "runs.jsonl")), true);
  });

  it("runs many tasks from a JSON file and prints a summary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);
    const tasksPath = path.join(tmpDir, "tasks.json");
    fs.writeFileSync(
      tasksPath,
      JSON.stringify([
        { id: "docs", prompt: "write docs" },
        { id: "tests", prompt: "write tests" }
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
    assert.equal(payload.summary.totalTasks, 2);
    assert.equal(payload.summary.okTasks, 2);
    assert.deepEqual(payload.results.map((entry) => entry.taskId), ["docs", "tests"]);
    assert.deepEqual(payload.results.map((entry) => entry.stdout), ["pong:write docs", "pong:write tests"]);
  });

  it("prints stats as JSON", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-cli-"));
    const configPath = writeConfig(tmpDir);

    runCli(["run", "--task", "hello", "--agent", "nodeEcho", "--json", "--config", configPath], tmpDir);
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
