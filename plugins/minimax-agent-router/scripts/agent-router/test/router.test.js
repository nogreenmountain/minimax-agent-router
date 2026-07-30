import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  chooseRoute,
  estimateCost,
  estimateTokens,
  executeAgent,
  isCommandAvailable,
  loadConfig,
  loadRuns,
  renderArgs,
  summarizeRuns
} from "../src/router.js";

describe("chooseRoute", () => {
  const config = {
    defaults: {
      agent: "pi",
      think: "low",
      codexOwnedKinds: ["planning", "review", "image"]
    },
    agents: {
      pi: { enabled: true, command: "pi", defaultModel: "mini", defaultThink: "low" },
      claude: { enabled: true, command: "claude", defaultModel: "sonnet", defaultThink: "medium" }
    },
    routing: {
      codexKeywords: ["规划", "review", "生图"],
      preferredAgentOrder: ["pi", "claude"]
    }
  };

  it("keeps planning, review, and image tasks on Codex", () => {
    const route = chooseRoute("帮我规划一下小程序架构", config, {
      isCommandAvailable: () => true
    });

    assert.equal(route.runByCodex, true);
    assert.equal(route.agentName, "codex");
  });

  it("uses the first available lightweight agent for ordinary tasks", () => {
    const route = chooseRoute("实现一个登录按钮组件", config, {
      isCommandAvailable: (command) => command === "pi"
    });

    assert.equal(route.runByCodex, false);
    assert.equal(route.agentName, "pi");
    assert.equal(route.model, "mini");
    assert.equal(route.think, "low");
  });

  it("falls back when the preferred agent command is unavailable", () => {
    const route = chooseRoute("补一个表单校验函数", config, {
      isCommandAvailable: (command) => command === "claude"
    });

    assert.equal(route.agentName, "claude");
  });

  it("falls back when an agent is missing one of its required environment variables", () => {
    const route = chooseRoute("实现一个登录按钮组件", {
      defaults: { agent: "claude-minimax", think: "low" },
      agents: {
        "claude-minimax": {
          enabled: true,
          command: process.execPath,
          requiredEnvAny: ["MINIMAX_API_KEY", "MINIMAX_SUBSCRIPTION_KEY"],
          defaultModel: "MiniMax-M3[1m]",
          defaultThink: "low"
        },
        claude: { enabled: true, command: process.execPath, defaultModel: "sonnet", defaultThink: "medium" }
      },
      routing: { codexKeywords: ["规划"], preferredAgentOrder: ["claude-minimax", "claude"] }
    }, {
      env: {},
      isCommandAvailable: () => true
    });

    assert.equal(route.agentName, "claude");
  });

  it("uses an env-gated agent when any required environment variable is present", () => {
    const route = chooseRoute("实现一个登录按钮组件", {
      defaults: { agent: "claude-minimax", think: "low" },
      agents: {
        "claude-minimax": {
          enabled: true,
          command: process.execPath,
          requiredEnvAny: ["MINIMAX_API_KEY", "MINIMAX_SUBSCRIPTION_KEY"],
          defaultModel: "MiniMax-M3[1m]",
          defaultThink: "low"
        },
        claude: { enabled: true, command: process.execPath, defaultModel: "sonnet", defaultThink: "medium" }
      },
      routing: { codexKeywords: ["规划"], preferredAgentOrder: ["claude-minimax", "claude"] }
    }, {
      env: { MINIMAX_API_KEY: "test-key" },
      isCommandAvailable: () => true
    });

    assert.equal(route.agentName, "claude-minimax");
    assert.equal(route.model, "MiniMax-M3[1m]");
  });

  it("honors explicit agent, model, and thinking strength overrides", () => {
    const route = chooseRoute("补一个表单校验函数", config, {
      agentName: "claude",
      model: "opus",
      think: "high",
      isCommandAvailable: () => true
    });

    assert.equal(route.agentName, "claude");
    assert.equal(route.model, "opus");
    assert.equal(route.think, "high");
  });
});

describe("loadConfig", () => {
  it("expands router_dir placeholders relative to the config file", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-config-"));
    const configPath = path.join(tmpDir, "agent-router.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: {
          "claude-minimax": {
            args: ["{router_dir}\\src\\claude-minimax.js", "--model", "{model}"]
          }
        }
      }),
      "utf8"
    );

    const { config } = loadConfig(configPath, process.cwd());

    assert.equal(config.agents["claude-minimax"].args[0], `${tmpDir}\\src\\claude-minimax.js`);
  });
});

describe("renderArgs", () => {
  it("replaces placeholders without shell interpolation", () => {
    assert.deepEqual(
      renderArgs(["--model", "{model}", "--think", "{think}", "{prompt_file}"], {
        model: "deepseek-chat",
        think: "low",
        prompt_file: "C:/tmp/prompt.txt"
      }),
      ["--model", "deepseek-chat", "--think", "low", "C:/tmp/prompt.txt"]
    );
  });

  it("throws for missing placeholders", () => {
    assert.throws(
      () => renderArgs(["--model", "{model}", "{missing}"], { model: "mini" }),
      /missing template value/i
    );
  });
});

describe("isCommandAvailable", () => {
  it("accepts an existing absolute executable path", () => {
    assert.equal(isCommandAvailable(process.execPath), true);
  });
});

describe("usage estimates", () => {
  it("estimates tokens and cost from text lengths", () => {
    assert.equal(estimateTokens("12345678"), 2);
    assert.equal(
      estimateCost(1000, 500, { inputPer1k: 0.001, outputPer1k: 0.002 }),
      0.002
    );
  });

  it("summarizes runs by status, agent, model, and estimated cost", () => {
    const summary = summarizeRuns([
      {
        status: "ok",
        agent: "pi",
        model: "mini",
        think: "low",
        startedAt: "2026-07-28T01:00:00.000Z",
        durationMs: 100,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCost: 0.003
      },
      {
        status: "error",
        agent: "claude",
        model: "sonnet",
        think: "medium",
        startedAt: "2026-07-28T02:00:00.000Z",
        durationMs: 300,
        inputTokens: 10,
        outputTokens: 20,
        estimatedCost: 0
      }
    ]);

    assert.equal(summary.totalRuns, 2);
    assert.equal(summary.okRuns, 1);
    assert.equal(summary.errorRuns, 1);
    assert.equal(summary.totalDurationMs, 400);
    assert.equal(summary.totalEstimatedCost, 0.003);
    assert.equal(summary.byAgent.pi.runs, 1);
    assert.equal(summary.byAgent.claude.status.error, 1);
    assert.equal(summary.byModel["pi::mini"].inputTokens, 1000);
  });
}
);

describe("executeAgent", () => {
  it("runs an agent through stdin and appends a usage log", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-test-"));
    const logPath = path.join(tmpDir, "runs.jsonl");
    const config = {
      agents: {
        nodeEcho: {
          command: process.execPath,
          args: ["-e", "process.stdin.on('data', d => process.stdout.write('answer:' + d))"],
          promptMode: "stdin",
          pricing: { inputPer1k: 0.01, outputPer1k: 0.02 }
        }
      }
    };

    const result = executeAgent("hello", config, {
      agentName: "nodeEcho",
      model: "test-model",
      think: "low",
      logPath,
      cwd: tmpDir
    });

    assert.equal(result.status, "ok");
    assert.equal(result.stdout, "answer:hello");

    const runs = loadRuns(logPath);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].agent, "nodeEcho");
    assert.equal(runs[0].model, "test-model");
    assert.equal(runs[0].status, "ok");
    assert.equal(runs[0].inputTokens, estimateTokens("hello"));
    assert.equal(runs[0].outputTokens, estimateTokens("answer:hello"));
    assert.ok(runs[0].durationMs >= 0);
  });

  it("records failed invocations", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-test-"));
    const logPath = path.join(tmpDir, "runs.jsonl");
    const config = {
      agents: {
        nodeFail: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
          promptMode: "stdin",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const result = executeAgent("hello", config, {
      agentName: "nodeFail",
      model: "test-model",
      think: "low",
      logPath,
      cwd: tmpDir
    });

    assert.equal(result.status, "error");
    assert.equal(result.exitCode, 7);
    assert.equal(result.stderr, "bad");
    assert.equal(loadRuns(logPath)[0].status, "error");
  });

  it("can pass the prompt as a command argument for CLIs like mmx", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-test-"));
    const logPath = path.join(tmpDir, "runs.jsonl");
    const config = {
      agents: {
        nodeArgEcho: {
          command: process.execPath,
          args: ["-e", "process.stdout.write(process.argv[1])", "{prompt}"],
          promptMode: "arg",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const result = executeAgent("hello from arg", config, {
      agentName: "nodeArgEcho",
      model: "test-model",
      think: "low",
      logPath,
      cwd: tmpDir
    });

    assert.equal(result.status, "ok");
    assert.equal(result.stdout, "hello from arg");
    assert.equal(loadRuns(logPath)[0].agent, "nodeArgEcho");
  });
});
