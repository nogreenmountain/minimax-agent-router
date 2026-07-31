import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  assessTask,
  chooseRoute,
  DEFAULT_CONFIG,
  estimateCost,
  estimateTokens,
  executeAgent,
  executeAgentAsync,
  executeManyTasks,
  formatManyTaskPrompt,
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
    const route = chooseRoute({
      kind: "small-code",
      task: "修复登录按钮的禁用状态。",
      scope: ["src/login-button.tsx"],
      testCommand: "npm test -- login-button"
    }, config, {
      isCommandAvailable: (command) => command === "pi"
    });

    assert.equal(route.runByCodex, false);
    assert.equal(route.agentName, "pi");
    assert.equal(route.model, "mini");
    assert.equal(route.think, "low");
  });

  it("falls back when the preferred agent command is unavailable", () => {
    const route = chooseRoute({
      kind: "small-code",
      task: "补一个表单校验函数。",
      scope: ["src/validate-form.ts"],
      testCommand: "npm test -- validate-form"
    }, config, {
      isCommandAvailable: (command) => command === "claude"
    });

    assert.equal(route.agentName, "claude");
  });

  it("falls back when an agent is missing one of its required environment variables", () => {
    const route = chooseRoute({
      kind: "docs",
      task: "整理登录按钮说明。",
      scope: ["README.md"]
    }, {
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
    const route = chooseRoute({
      kind: "docs",
      task: "整理登录按钮说明。",
      scope: ["README.md"]
    }, {
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
    const route = chooseRoute({
      kind: "small-code",
      task: "补一个表单校验函数。",
      scope: ["src/validate-form.ts"],
      testCommand: "npm test -- validate-form"
    }, config, {
      agentName: "claude",
      model: "opus",
      think: "high",
      isCommandAvailable: () => true
    });

    assert.equal(route.agentName, "claude");
    assert.equal(route.model, "opus");
    assert.equal(route.think, "high");
  });

  it("does not let an explicit agent override the safety gate", () => {
    const route = chooseRoute("用 Windows COM 重写 PowerPoint 自动化核心模块", config, {
      agentName: "pi",
      isCommandAvailable: () => true
    });

    assert.equal(route.runByCodex, true);
    assert.equal(route.agentName, "codex");
    assert.equal(route.assessment.decision, "codex");
    assert.match(route.reason, /platform integration/i);
  });
});

describe("assessTask", () => {
  it("defaults the execution budget to five minutes", () => {
    assert.equal(DEFAULT_CONFIG.defaults.timeoutMs, 300000);
  });

  it("accepts a narrow task with an exact test command", () => {
    const assessment = assessTask({
      kind: "small-code",
      task: "修复日期格式化边界条件。",
      scope: ["src/date-format.ts", "test/date-format.test.ts"],
      testCommand: "npm test -- date-format",
      estimatedMinutes: 4
    }, DEFAULT_CONFIG);

    assert.equal(assessment.decision, "delegate");
    assert.equal(assessment.fit, "good");
    assert.ok(assessment.score >= 70);
  });

  it("keeps broad editing tasks without a scope on Codex", () => {
    const assessment = assessTask({
      kind: "small-code",
      task: "实现完整的登录功能。",
      testCommand: "npm test"
    }, DEFAULT_CONFIG);

    assert.equal(assessment.decision, "codex");
    assert.match(assessment.reasons.join(" "), /scope/i);
  });

  it("requires an exact API example for unfamiliar API implementation", () => {
    const assessment = assessTask({
      kind: "small-code",
      task: "使用新的 PPTX API 实现幻灯片导出。",
      scope: ["src/export-slide.ts"],
      testCommand: "npm test -- export-slide"
    }, DEFAULT_CONFIG);

    assert.equal(assessment.decision, "codex");
    assert.match(assessment.reasons.join(" "), /API example/i);
  });

  it("accepts bounded read-only research without a test command", () => {
    const assessment = assessTask({
      kind: "research",
      readOnly: true,
      task: "比较现有仓库中两种日志方案，只输出证据和建议。",
      scope: ["src/logging/**"],
      estimatedMinutes: 3
    }, DEFAULT_CONFIG);

    assert.equal(assessment.decision, "delegate");
  });
});

describe("formatManyTaskPrompt", () => {
  it("adds strict scope, no-scratch, test, evidence, and review guardrails", () => {
    const prompt = formatManyTaskPrompt({
      kind: "small-code",
      task: "修复一个边界条件。",
      scope: ["src/foo.ts", "test/foo.test.ts"],
      testCommand: "npm test -- foo",
      apiExamples: ["client.render({ blob, position })"]
    });

    assert.match(prompt, /Do not create scratch, temp, or helper files outside Scope/);
    assert.match(prompt, /npm test -- foo/);
    assert.match(prompt, /client\.render\(\{ blob, position \}\)/);
    assert.match(prompt, /Paste the real command output/);
    assert.match(prompt, /Codex will inspect the diff and verify the result/);
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
        estimatedCost: 0.003,
        headroom: { enabled: true, tokensSaved: 75 }
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
    assert.equal(summary.headroom.enabledRuns, 1);
    assert.equal(summary.headroom.tokensSaved, 75);
  });
}
);

describe("executeAgent", () => {
  it("collects a Headroom sidecar without logging credentials", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-headroom-report-"));
    const logPath = path.join(tmpDir, "runs.jsonl");
    const config = {
      headroom: { mode: "auto" },
      agents: {
        "claude-minimax": {
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('fs'); fs.writeFileSync(process.env.AGENT_ROUTER_HEADROOM_REPORT_PATH, JSON.stringify({enabled:true,status:'reused',tokensSaved:42,error:process.env.TEST_REPORT_SECRET})); process.stdout.write('ok')"
          ],
          promptMode: "stdin",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const result = executeAgent("hello", config, {
      agentName: "claude-minimax",
      model: "test-model",
      think: "low",
      logPath,
      cwd: tmpDir,
      env: { TEST_REPORT_SECRET: "sk-secret-value" }
    });

    assert.equal(result.status, "ok");
    assert.equal(result.headroom.enabled, true);
    assert.equal(result.headroom.tokensSaved, 42);
    assert.doesNotMatch(JSON.stringify(loadRuns(logPath)), /sk-secret-value/);
  });

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

describe("executeAgentAsync", () => {
  it("does not charge first-use Headroom installation against the worker timeout", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-headroom-install-timeout-"));
    const script = [
      "process.stderr.write('[headroom] Headroom is not installed; automatically installing headroom-ai[proxy]==0.33.0.\\n');",
      "setTimeout(() => {",
      "  process.stderr.write('[headroom] Headroom installation completed: headroom-ai[proxy]==0.33.0.\\n');",
      "  setTimeout(() => process.stdout.write('done'), 20);",
      "}, 150);"
    ].join("\n");
    const config = {
      defaults: { timeoutMs: 100 },
      headroom: { mode: "auto", autoInstall: true, installWaitMs: 400 },
      agents: {
        "claude-minimax": {
          command: process.execPath,
          args: ["-e", script],
          promptMode: "stdin",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const result = await executeAgentAsync("hello", config, {
      agentName: "claude-minimax",
      model: "test-model",
      think: "low",
      cwd: tmpDir
    });

    assert.equal(result.status, "ok");
    assert.equal(result.stdout, "done");
  });

  it("restores the normal worker timeout after Headroom installation completes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-headroom-task-timeout-"));
    const script = [
      "process.stderr.write('[headroom] Headroom is not installed; automatically installing headroom-ai[proxy]==0.33.0.\\n');",
      "setTimeout(() => {",
      "  process.stderr.write('[headroom] Headroom installation completed: headroom-ai[proxy]==0.33.0.\\n');",
      "  setTimeout(() => process.stdout.write('late'), 150);",
      "}, 150);"
    ].join("\n");
    const config = {
      defaults: { timeoutMs: 100 },
      headroom: { mode: "auto", autoInstall: true, installWaitMs: 400 },
      agents: {
        "claude-minimax": {
          command: process.execPath,
          args: ["-e", script],
          promptMode: "stdin",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const result = await executeAgentAsync("hello", config, {
      agentName: "claude-minimax",
      model: "test-model",
      think: "low",
      cwd: tmpDir
    });

    assert.equal(result.status, "timed-out");
    assert.equal(result.partialChangesPossible, true);
  });

  it("marks timed-out work as possibly partial", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-timeout-"));
    const config = {
      defaults: { timeoutMs: 20 },
      agents: {
        nodeDelay: {
          command: process.execPath,
          args: ["-e", "setTimeout(() => process.stdout.write('late'), 500)"],
          promptMode: "stdin",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const result = await executeAgentAsync("hello", config, {
      agentName: "nodeDelay",
      model: "test-model",
      think: "low",
      cwd: tmpDir
    });

    assert.equal(result.status, "timed-out");
    assert.equal(result.partialChangesPossible, true);
    assert.equal(result.reviewStatus, "required");
  });
});

describe("executeManyTasks", () => {
  it("runs independent tasks with a concurrency limit and preserves result order", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-many-"));
    const logPath = path.join(tmpDir, "runs.jsonl");
    const config = {
      defaults: { agent: "nodeDelay", think: "low", timeoutMs: 5000 },
      routing: { codexKeywords: ["planning"], preferredAgentOrder: ["nodeDelay"] },
      agents: {
        nodeDelay: {
          enabled: true,
          command: process.execPath,
          args: [
            "-e",
            "let data=''; process.stdin.on('data', d => data += d); process.stdin.on('end', () => setTimeout(() => process.stdout.write('done:' + data), 250));"
          ],
          promptMode: "stdin",
          defaultModel: "mini",
          defaultThink: "low",
          pricing: { inputPer1k: 0, outputPer1k: 0 }
        }
      }
    };

    const started = performance.now();
    const events = [];
    const result = await executeManyTasks([
      { id: "one", kind: "research", readOnly: true, task: "analyze one", scope: ["src/one.ts"] },
      { id: "two", kind: "research", readOnly: true, task: "analyze two", scope: ["src/two.ts"] },
      { id: "three", kind: "research", readOnly: true, task: "analyze three", scope: ["src/three.ts"] }
    ], config, {
      parallel: 3,
      logPath,
      cwd: tmpDir,
      isCommandAvailable: () => true,
      onEvent: (event) => events.push(event)
    });
    const elapsed = performance.now() - started;

    assert.equal(result.status, "ok");
    assert.equal(result.summary.totalTasks, 3);
    assert.equal(result.summary.okTasks, 3);
    assert.equal(result.summary.pendingReviewTasks, 3);
    assert.deepEqual(result.results.map((entry) => entry.reviewStatus), ["pending-codex", "pending-codex", "pending-codex"]);
    assert.deepEqual(result.results.map((entry) => entry.stdout), ["done:" + formatManyTaskPrompt({ id: "one", kind: "research", readOnly: true, task: "analyze one", scope: ["src/one.ts"] }), "done:" + formatManyTaskPrompt({ id: "two", kind: "research", readOnly: true, task: "analyze two", scope: ["src/two.ts"] }), "done:" + formatManyTaskPrompt({ id: "three", kind: "research", readOnly: true, task: "analyze three", scope: ["src/three.ts"] })]);
    assert.equal(events.filter((event) => event.type === "task-started").length, 3);
    assert.equal(events.filter((event) => event.type === "task-finished").length, 3);
    assert.ok(elapsed < 650, `expected parallel execution, took ${elapsed}ms`);
    assert.equal(loadRuns(logPath).length, 3);
  });

  it("keeps Codex-owned tasks out of the worker pool", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-many-"));
    const config = {
      defaults: { agent: "nodeEcho", think: "low", timeoutMs: 5000 },
      routing: { codexKeywords: ["planning"], preferredAgentOrder: ["nodeEcho"] },
      agents: {
        nodeEcho: {
          enabled: true,
          command: process.execPath,
          args: ["-e", "process.stdin.on('data', d => process.stdout.write('done:' + d))"],
          promptMode: "stdin",
          defaultModel: "mini",
          defaultThink: "low"
        }
      }
    };

    const result = await executeManyTasks([
      { id: "architecture", task: "planning: decide architecture" },
      { id: "docs", kind: "docs", task: "write docs", scope: ["README.md"] }
    ], config, {
      parallel: 2,
      cwd: tmpDir,
      isCommandAvailable: () => true
    });

    assert.equal(result.status, "needs-codex");
    assert.equal(result.summary.codexTasks, 1);
    assert.equal(result.summary.okTasks, 1);
    assert.equal(result.results[0].status, "codex");
    assert.equal(result.results[1].status, "ok");
  });
});
