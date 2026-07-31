import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { DEFAULT_HEADROOM_CONFIG, sanitizeHeadroomReport } from "./headroom.js";

export const DEFAULT_CONFIG = {
  logPath: ".agent-router/runs.jsonl",
  headroom: {
    ...DEFAULT_HEADROOM_CONFIG
  },
  defaults: {
    agent: "claude-minimax",
    think: "low",
    timeoutMs: 300000
  },
  routing: {
    codexKeywords: [
      "规划",
      "计划",
      "架构",
      "生图",
      "画图",
      "image",
      "高风险",
      "安全",
      "权限",
      "密钥",
      "审计",
      "数据库迁移",
      "部署",
      "上线",
      "生产",
      "回滚"
    ],
    taskGate: {
      enabled: true,
      maxEstimatedMinutes: 5,
      maxScopeEntries: 2,
      platformIntegrationKeywords: [
        "windows com",
        "powerpoint com",
        "office com",
        "office automation",
        "office 自动化",
        "com 自动化"
      ],
      broadTaskKeywords: [
        "完整实现",
        "全量实现",
        "大范围重构",
        "重构整个",
        "多模块",
        "多个模块",
        "共享接口",
        "核心模块",
        "end-to-end implementation",
        "large refactor"
      ],
      unfamiliarApiKeywords: [
        "陌生 api",
        "新的 api",
        "新 api",
        "pptx api",
        "third-party api",
        "第三方 api",
        "new sdk",
        "新的 sdk"
      ]
    },
    preferredAgentOrder: ["claude-minimax", "pi", "claude", "hermes"]
  },
  agents: {
    "claude-minimax": {
      enabled: true,
      command: "node",
      args: ["{router_dir}\\src\\claude-minimax.js", "--model", "{model}", "--think", "{think}"],
      promptMode: "stdin",
      requiredEnvAny: ["MINIMAX_API_KEY", "MINIMAX_SUBSCRIPTION_KEY"],
      defaultModel: "MiniMax-M3[1m]",
      defaultThink: "low",
      pricing: { inputPer1k: 0, outputPer1k: 0 }
    },
    pi: {
      enabled: true,
      command: "pi",
      args: ["--model", "{model}", "--think", "{think}"],
      promptMode: "stdin",
      defaultModel: "auto",
      defaultThink: "low",
      pricing: { inputPer1k: 0, outputPer1k: 0 }
    },
    claude: {
      enabled: true,
      command: "claude",
      args: ["--print", "--model", "{model}"],
      promptMode: "stdin",
      defaultModel: "sonnet",
      defaultThink: "medium",
      pricing: { inputPer1k: 0, outputPer1k: 0 }
    },
    hermes: {
      enabled: true,
      command: "hermes",
      args: ["--model", "{model}", "--think", "{think}"],
      promptMode: "stdin",
      defaultModel: "auto",
      defaultThink: "low",
      pricing: { inputPer1k: 0, outputPer1k: 0 }
    }
  }
};

export function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    merged[key] = deepMerge(base[key], value);
  }
  return merged;
}

export function loadConfig(configPath = "agent-router.config.json", cwd = process.cwd()) {
  const fullPath = path.isAbsolute(configPath) ? configPath : path.join(cwd, configPath);
  const routerDir = path.dirname(fullPath);
  if (!fs.existsSync(fullPath)) {
    return {
      config: expandConfigPlaceholders(structuredClone(DEFAULT_CONFIG), routerDir),
      path: fullPath,
      existed: false
    };
  }

  const userConfig = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return {
    config: expandConfigPlaceholders(deepMerge(DEFAULT_CONFIG, userConfig), routerDir),
    path: fullPath,
    existed: true
  };
}

export function getLogPath(config, cwd = process.cwd()) {
  const configured = config.logPath || DEFAULT_CONFIG.logPath;
  return path.isAbsolute(configured) ? configured : path.join(cwd, configured);
}

export function chooseRoute(task, config, options = {}) {
  const assessment = assessTask(task, config);
  if (assessment.decision === "codex") {
    return {
      runByCodex: true,
      agentName: "codex",
      model: null,
      think: null,
      reason: assessment.reasons.join("; "),
      assessment
    };
  }

  const agentName = pickAgentName(config, options);
  const agent = config.agents?.[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentName}`);
  }

  return {
    runByCodex: false,
    agentName,
    model: options.model || agent.defaultModel || config.defaults?.model || "auto",
    think: options.think || agent.defaultThink || config.defaults?.think || "low",
    reason: options.agentName ? "explicit agent selected after safety gate" : "task passed safety gate",
    assessment
  };
}

export function assessTask(task, config = DEFAULT_CONFIG) {
  const descriptor = normalizeTaskDescriptor(task);
  const gate = deepMerge(DEFAULT_CONFIG.routing.taskGate, config.routing?.taskGate || {});
  const lower = descriptor.text.toLowerCase();
  const reasons = [];
  const recommendations = [];
  const signals = [];

  if (gate.enabled === false) {
    return {
      decision: "delegate",
      fit: "unchecked",
      score: 50,
      kind: descriptor.kind,
      readOnly: descriptor.readOnly,
      reasons: ["task gate disabled by configuration"],
      recommendations,
      signals
    };
  }

  const platformKeyword = findKeyword(lower, gate.platformIntegrationKeywords);
  if (platformKeyword) {
    reasons.push(`platform integration must stay with Codex: ${platformKeyword}`);
    signals.push("platform-integration");
  }

  const codexKeyword = findKeyword(lower, config.routing?.codexKeywords || DEFAULT_CONFIG.routing.codexKeywords);
  if (codexKeyword) {
    reasons.push(`matched Codex-owned keyword: ${codexKeyword}`);
    signals.push("codex-owned");
  }

  const broadKeyword = findKeyword(lower, gate.broadTaskKeywords);
  if (broadKeyword) {
    reasons.push(`task is too broad for a short MiniMax worker: ${broadKeyword}`);
    signals.push("broad-task");
  }

  if (descriptor.estimatedMinutes && descriptor.estimatedMinutes > gate.maxEstimatedMinutes) {
    reasons.push(`estimated task time exceeds ${gate.maxEstimatedMinutes} minutes`);
    signals.push("over-budget");
  }

  if (descriptor.editing && descriptor.scope.length === 0) {
    reasons.push("editing tasks require an explicit file or directory scope");
    recommendations.push("Provide one file, one test pair, or one clear directory in Scope.");
    signals.push("missing-scope");
  }

  if (descriptor.scope.length > gate.maxScopeEntries) {
    reasons.push(`scope has ${descriptor.scope.length} entries; maximum is ${gate.maxScopeEntries}`);
    recommendations.push("Split the work into smaller non-overlapping tasks.");
    signals.push("wide-scope");
  }

  if (descriptor.requiresTest && !descriptor.testCommand) {
    reasons.push("code and test tasks require one exact test command");
    recommendations.push("Add testCommand and require the real command output.");
    signals.push("missing-test-command");
  }

  const unfamiliarApiKeyword = findKeyword(lower, gate.unfamiliarApiKeywords);
  if (unfamiliarApiKeyword && descriptor.apiExamples.length === 0) {
    reasons.push(`unfamiliar API implementation requires an exact API example: ${unfamiliarApiKeyword}`);
    recommendations.push("Provide a verified API call or keep the implementation with Codex.");
    signals.push("missing-api-example");
  }

  let score = 45;
  if (["research", "docs", "tests", "small-code", "mechanical", "review"].includes(descriptor.kind)) {
    score += 15;
  }
  if (descriptor.readOnly) {
    score += 15;
  }
  if (descriptor.scope.length > 0) {
    score += 15;
  }
  if (!descriptor.requiresTest || descriptor.testCommand) {
    score += 10;
  }
  if (descriptor.estimatedMinutes && descriptor.estimatedMinutes <= gate.maxEstimatedMinutes) {
    score += 5;
  }
  if (descriptor.apiExamples.length > 0) {
    score += 5;
  }
  score = Math.max(0, Math.min(100, score - reasons.length * 25));

  const decision = reasons.length === 0 ? "delegate" : "codex";
  return {
    decision,
    fit: decision === "delegate" && score >= 70 ? "good" : "poor",
    score,
    kind: descriptor.kind,
    readOnly: descriptor.readOnly,
    editing: descriptor.editing,
    scope: descriptor.scope,
    estimatedMinutes: descriptor.estimatedMinutes,
    reasons: reasons.length > 0 ? reasons : ["bounded task passed the MiniMax task gate"],
    recommendations,
    signals
  };
}

export function renderArgs(args, values) {
  return (args || []).map((arg) =>
    String(arg).replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
      if (!(key in values) || values[key] === undefined || values[key] === null) {
        throw new Error(`Missing template value: ${key}`);
      }
      return String(values[key]);
    })
  );
}

export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.ceil(String(text).length / 4);
}

export function estimateCost(inputTokens, outputTokens, pricing = {}) {
  const input = Number(inputTokens || 0);
  const output = Number(outputTokens || 0);
  const inputRate = Number(pricing.inputPer1k || 0);
  const outputRate = Number(pricing.outputPer1k || 0);
  return roundMoney((input / 1000) * inputRate + (output / 1000) * outputRate);
}

export function summarizeRuns(runs) {
  const summary = {
    totalRuns: runs.length,
    okRuns: 0,
    errorRuns: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0,
    headroom: {
      enabledRuns: 0,
      fallbackRuns: 0,
      requests: 0,
      inputTokens: 0,
      tokensSaved: 0
    },
    byAgent: {},
    byModel: {},
    lastRun: null
  };

  for (const run of runs) {
    if (run.status === "ok") {
      summary.okRuns += 1;
    } else {
      summary.errorRuns += 1;
    }

    summary.totalDurationMs += Number(run.durationMs || 0);
    summary.totalInputTokens += Number(run.inputTokens || 0);
    summary.totalOutputTokens += Number(run.outputTokens || 0);
    summary.totalEstimatedCost = roundMoney(summary.totalEstimatedCost + Number(run.estimatedCost || 0));
    if (run.headroom?.enabled) {
      summary.headroom.enabledRuns += 1;
      summary.headroom.requests += Number(run.headroom.requests || 0);
      summary.headroom.inputTokens += Number(run.headroom.inputTokens || 0);
      summary.headroom.tokensSaved += Number(run.headroom.tokensSaved || 0);
    } else if (String(run.headroom?.status || "").startsWith("fallback")) {
      summary.headroom.fallbackRuns += 1;
    }

    const agentKey = run.agent || "unknown";
    const modelKey = `${agentKey}::${run.model || "unknown"}`;
    const thinkKey = run.think || "unknown";

    summary.byAgent[agentKey] ||= makeBucket();
    addToBucket(summary.byAgent[agentKey], run, thinkKey);

    summary.byModel[modelKey] ||= makeBucket();
    addToBucket(summary.byModel[modelKey], run, thinkKey);

    if (!summary.lastRun || String(run.startedAt || "") > String(summary.lastRun.startedAt || "")) {
      summary.lastRun = run;
    }
  }

  return summary;
}

export function loadRuns(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }

  return fs
    .readFileSync(logPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function executeAgent(prompt, config, options = {}) {
  const agentName = options.agentName;
  const agent = config.agents?.[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentName}`);
  }

  const cwd = options.cwd || process.cwd();
  const startedAt = new Date();
  const started = performance.now();
  const promptText = String(prompt || "");
  const promptFile = preparePromptFile(agent.promptMode, promptText, cwd);
  const templateValues = {
    model: options.model || agent.defaultModel || "auto",
    think: options.think || agent.defaultThink || config.defaults?.think || "low",
    prompt: promptText,
    prompt_file: promptFile
  };
  const args = renderArgs(agent.args || [], templateValues);
  const input = agent.promptMode === "stdin" || !agent.promptMode ? promptText : undefined;
  const headroomInvocation = prepareHeadroomInvocation(agentName, config, cwd, options);

  const result = spawnSync(agent.command, args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}), ...headroomInvocation.env },
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    timeout: options.timeoutMs || config.defaults?.timeoutMs || DEFAULT_CONFIG.defaults.timeoutMs,
    windowsHide: true
  });

  cleanupPromptFile(promptFile);

  const completedAt = new Date();
  const durationMs = Math.round(performance.now() - started);
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const inputTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(stdout);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const status = timedOut ? "timed-out" : result.status === 0 && !result.error ? "ok" : "error";
  const headroom = readHeadroomReport(headroomInvocation.reportPath);
  const run = {
    id: makeRunId(startedAt),
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    status,
    agent: agentName,
    model: templateValues.model,
    think: templateValues.think,
    command: agent.command,
    args,
    cwd,
    exitCode: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    reviewStatus: status === "ok" ? "pending-codex" : "required",
    partialChangesPossible: timedOut,
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    inputTokens,
    outputTokens,
    estimatedCost: estimateCost(inputTokens, outputTokens, agent.pricing),
    ...(headroom ? { headroom } : {})
  };

  if (options.logPath) {
    appendRun(options.logPath, run);
  }

  return {
    ...run,
    stdout,
    stderr
  };
}

export async function executeAgentAsync(prompt, config, options = {}) {
  const agentName = options.agentName;
  const agent = config.agents?.[agentName];
  if (!agent) {
    throw new Error(`Unknown agent: ${agentName}`);
  }

  const cwd = options.cwd || process.cwd();
  const startedAt = new Date();
  const started = performance.now();
  const promptText = String(prompt || "");
  const promptFile = preparePromptFile(agent.promptMode, promptText, cwd);
  const templateValues = {
    model: options.model || agent.defaultModel || "auto",
    think: options.think || agent.defaultThink || config.defaults?.think || "low",
    prompt: promptText,
    prompt_file: promptFile
  };
  const args = renderArgs(agent.args || [], templateValues);
  const input = agent.promptMode === "stdin" || !agent.promptMode ? promptText : undefined;
  const timeoutMs = options.timeoutMs || config.defaults?.timeoutMs || DEFAULT_CONFIG.defaults.timeoutMs;
  const headroomInstallWaitMs = Math.max(
    timeoutMs,
    Number(config.headroom?.installWaitMs || DEFAULT_HEADROOM_CONFIG.installWaitMs)
  );
  const headroomInvocation = prepareHeadroomInvocation(agentName, config, cwd, options);

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stderrLineBuffer = "";
    let spawnError = null;
    let timedOut = false;
    let settled = false;

    const child = spawn(agent.command, args, {
      cwd,
      env: { ...process.env, ...(options.env || {}), ...headroomInvocation.env },
      windowsHide: true
    });

    let activeTimeoutMs = timeoutMs;
    let timer = null;
    const armTimeout = (delayMs) => {
      if (timer) {
        clearTimeout(timer);
      }
      activeTimeoutMs = delayMs;
      timer = delayMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, delayMs)
        : null;
    };
    armTimeout(timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      const lines = `${stderrLineBuffer}${chunk}`.split(/\r?\n/);
      stderrLineBuffer = lines.pop() || "";
      for (const line of lines) {
        if (isHeadroomInstallPending(line)) {
          armTimeout(headroomInstallWaitMs + timeoutMs);
        } else if (isHeadroomInstallFinished(line)) {
          armTimeout(timeoutMs);
        }
      }
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      cleanupPromptFile(promptFile);

      const completedAt = new Date();
      const durationMs = Math.round(performance.now() - started);
      const inputTokens = estimateTokens(promptText);
      const outputTokens = estimateTokens(stdout);
      const status = timedOut ? "timed-out" : exitCode === 0 && !spawnError ? "ok" : "error";
      const headroom = readHeadroomReport(headroomInvocation.reportPath);
      const run = {
        id: makeRunId(startedAt),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        status,
        agent: agentName,
        model: templateValues.model,
        think: templateValues.think,
        command: agent.command,
        args,
        cwd,
        exitCode,
        signal,
        error: spawnError ? spawnError.message : timedOut ? `Timed out after ${activeTimeoutMs}ms` : null,
        reviewStatus: status === "ok" ? "pending-codex" : "required",
        partialChangesPossible: timedOut,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        inputTokens,
        outputTokens,
        estimatedCost: estimateCost(inputTokens, outputTokens, agent.pricing),
        ...(headroom ? { headroom } : {})
      };

      if (options.logPath) {
        appendRun(options.logPath, run);
      }

      resolve({
        ...run,
        stdout,
        stderr
      });
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

export async function executeManyTasks(tasksInput, config, options = {}) {
  const tasks = normalizeManyTasks(tasksInput);
  const parallel = Math.max(1, Math.floor(Number(options.parallel || config.defaults?.parallel || 2)));
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await executeOneTask(tasks[currentIndex], currentIndex);
    }
  }

  async function executeOneTask(task, index) {
    const prompt = formatManyTaskPrompt(task);
    const route = chooseRoute(task, config, {
      agentName: task.agent || options.agentName,
      model: task.model || options.model,
      think: task.think || options.think,
      env: options.env || process.env,
      isCommandAvailable: options.isCommandAvailable
    });
    const taskId = task.id || task.name || `task-${index + 1}`;

    options.onEvent?.({ type: "task-started", taskId, index, at: new Date().toISOString() });

    if (route.runByCodex) {
      const result = {
        taskId,
        index,
        status: "codex",
        reason: route.reason,
        assessment: route.assessment,
        agent: "codex",
        reviewStatus: "codex-owned",
        stdout: "",
        stderr: ""
      };
      options.onEvent?.({ type: "task-finished", taskId, index, status: result.status, at: new Date().toISOString() });
      return result;
    }

    const taskCwd = task.workspace || options.cwd || process.cwd();
    const result = await executeAgentAsync(prompt, config, {
      ...route,
      logPath: options.logPath,
      cwd: taskCwd,
      headroomMode: task.headroomMode || options.headroomMode,
      timeoutMs: task.timeoutMs || options.timeoutMs
    });

    const taskResult = {
      taskId,
      index,
      assessment: route.assessment,
      ...result
    };
    options.onEvent?.({ type: "task-finished", taskId, index, status: taskResult.status, at: new Date().toISOString() });
    return taskResult;
  }

  const workerCount = Math.min(parallel, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const summary = summarizeManyTaskResults(results);
  return {
    status: summary.errorTasks > 0 ? "error" : summary.codexTasks > 0 ? "needs-codex" : "ok",
    reviewStatus: summary.pendingReviewTasks > 0 ? "pending-codex" : "not-required",
    parallel,
    summary,
    results
  };
}

export function normalizeManyTasks(tasksInput) {
  const rawTasks = Array.isArray(tasksInput) ? tasksInput : tasksInput?.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error("run-many requires a non-empty tasks array.");
  }

  return rawTasks.map((task, index) => {
    if (typeof task === "string") {
      return { id: `task-${index + 1}`, prompt: task };
    }
    if (!task || typeof task !== "object") {
      throw new Error(`Task ${index + 1} must be a string or object.`);
    }
    if (!task.task && !task.prompt) {
      throw new Error(`Task ${index + 1} is missing task or prompt.`);
    }
    return task;
  });
}

export function formatManyTaskPrompt(task) {
  if (typeof task === "string") {
    return task;
  }
  const lines = [];
  if (task.workspace) {
    lines.push(`Workspace: ${task.workspace}`, "");
  }
  lines.push("Task:", String(task.task || task.prompt));
  if (task.kind) {
    lines.push("", "Task kind:", String(task.kind));
  }
  if (task.scope) {
    lines.push("", "Scope:", formatTaskField(task.scope));
  }
  if (task.apiExamples) {
    lines.push("", "Verified API examples:", formatTaskField(task.apiExamples));
  }
  const constraints = [
    "Only modify files listed in Scope.",
    "Do not create scratch, temp, or helper files outside Scope.",
    "Do not expand the task or introduce new modules unless Scope explicitly allows it.",
    "Do not run destructive git commands.",
    "If an API call is not covered by the verified examples or existing project usage, stop and report the uncertainty.",
    ...(task.readOnly ? ["This is read-only work. Do not modify any files."] : []),
    ...toArray(task.constraints)
  ];
  lines.push("", "Constraints:", formatTaskField(constraints));
  if (task.testCommand) {
    lines.push(
      "",
      "Required verification:",
      `Run exactly: ${task.testCommand}`,
      "Paste the real command output. Do not replace it with a completion claim."
    );
  }
  lines.push(
    "",
    "Output:",
    formatTaskField(toArray(task.output).length > 0 ? toArray(task.output) : [
      "Changed files or read-only findings with evidence.",
      "Exact verification command and real output.",
      "Remaining uncertainty, scope exceptions, or partial work."
    ]),
    "Codex will inspect the diff and verify the result before acceptance."
  );
  return lines.join("\n");
}

function summarizeManyTaskResults(results) {
  const summary = {
    totalTasks: results.length,
    okTasks: 0,
    errorTasks: 0,
    codexTasks: 0,
    timedOutTasks: 0,
    pendingReviewTasks: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCost: 0
  };

  for (const result of results) {
    if (result.status === "ok") {
      summary.okTasks += 1;
    } else if (result.status === "codex") {
      summary.codexTasks += 1;
    } else {
      summary.errorTasks += 1;
      if (result.status === "timed-out") {
        summary.timedOutTasks += 1;
      }
    }
    if (result.reviewStatus === "pending-codex") {
      summary.pendingReviewTasks += 1;
    }
    summary.totalDurationMs += Number(result.durationMs || 0);
    summary.totalInputTokens += Number(result.inputTokens || 0);
    summary.totalOutputTokens += Number(result.outputTokens || 0);
    summary.totalEstimatedCost = roundMoney(summary.totalEstimatedCost + Number(result.estimatedCost || 0));
  }

  return summary;
}

export function appendRun(logPath, run) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(run)}${os.EOL}`, "utf8");
}

export function isCommandAvailable(command) {
  if (!command) {
    return false;
  }

  const normalized = String(command).replace(/^"|"$/g, "");
  if (path.isAbsolute(normalized) || normalized.includes("/") || normalized.includes("\\")) {
    return fs.existsSync(normalized);
  }

  const executable = process.platform === "win32" ? "where.exe" : "command";
  const args = process.platform === "win32" ? [normalized] : ["-v", normalized];
  const result = spawnSync(executable, args, { stdio: "ignore", shell: process.platform !== "win32" });
  return result.status === 0;
}

function pickAgentName(config, options) {
  if (options.agentName) {
    return options.agentName;
  }

  const preferred = [
    config.defaults?.agent,
    ...(config.routing?.preferredAgentOrder || []),
    ...Object.keys(config.agents || {})
  ].filter(Boolean);

  const seen = new Set();
  for (const name of preferred) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const agent = config.agents?.[name];
    if (!agent?.enabled) {
      continue;
    }

    const commandAvailable = options.isCommandAvailable
      ? options.isCommandAvailable(agent.command)
      : isCommandAvailable(agent.command);
    if (commandAvailable && hasRequiredEnvironment(agent, options.env || process.env)) {
      return name;
    }
  }

  throw new Error("No enabled agent command is available. Run `agent-router doctor` for details.");
}

function makeBucket() {
  return {
    runs: 0,
    status: { ok: 0, error: 0 },
    byThink: {},
    durationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0
  };
}

function addToBucket(bucket, run, thinkKey) {
  bucket.runs += 1;
  if (run.status === "ok") {
    bucket.status.ok += 1;
  } else {
    bucket.status.error += 1;
  }
  bucket.byThink[thinkKey] = (bucket.byThink[thinkKey] || 0) + 1;
  bucket.durationMs += Number(run.durationMs || 0);
  bucket.inputTokens += Number(run.inputTokens || 0);
  bucket.outputTokens += Number(run.outputTokens || 0);
  bucket.estimatedCost = roundMoney(bucket.estimatedCost + Number(run.estimatedCost || 0));
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function formatTaskField(value) {
  if (Array.isArray(value)) {
    return value.map((item) => `- ${item}`).join("\n");
  }
  return String(value);
}

function normalizeTaskDescriptor(task) {
  const objectTask = isPlainObject(task) ? task : {};
  const text = isPlainObject(task)
    ? String(task.task || task.prompt || "")
    : String(task || "");
  const kind = String(objectTask.kind || inferTaskKind(text)).toLowerCase();
  const readOnly = Boolean(objectTask.readOnly) || ["research", "review", "analysis", "conversation"].includes(kind);
  const scope = toArray(objectTask.scope || extractTaskSection(text, "scope"));
  const testCommand = objectTask.testCommand || extractTaskSection(text, "test command") || extractTaskSection(text, "test");
  const apiExamples = toArray(objectTask.apiExamples || extractTaskSection(text, "api examples"));
  const estimatedMinutes = Number(objectTask.estimatedMinutes || 0) || null;
  const requiresTest = ["tests", "small-code", "mechanical", "bug-fix", "component"].includes(kind);
  return {
    text,
    kind,
    readOnly,
    editing: !readOnly && kind !== "conversation",
    scope: scope.filter(Boolean),
    testCommand: testCommand ? String(testCommand).trim() : "",
    apiExamples: apiExamples.filter(Boolean),
    estimatedMinutes,
    requiresTest
  };
}

function inferTaskKind(text) {
  const lower = String(text || "").toLowerCase();
  if (/(只回复|reply only|打印一个|print a|print hi)/i.test(lower)) {
    return "conversation";
  }
  if (/(只读|不修改文件|调研|研究|比较|分析)/i.test(lower)) {
    return "research";
  }
  if (/(readme|文档|说明|注释)/i.test(lower)) {
    return "docs";
  }
  if (/(测试|test|spec)/i.test(lower)) {
    return "tests";
  }
  if (/(lint|format|格式化|import|类型错误|type error)/i.test(lower)) {
    return "mechanical";
  }
  return "small-code";
}

function extractTaskSection(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`${escaped}\\s*:\\s*([^\\r\\n]+)`, "i"));
  return match?.[1]?.trim() || "";
}

function findKeyword(text, keywords = []) {
  return keywords.find((keyword) => text.includes(String(keyword).toLowerCase())) || null;
}

function toArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasRequiredEnvironment(agent, env) {
  const requiredAll = agent.requiredEnv || [];
  if (requiredAll.some((name) => !env[name])) {
    return false;
  }

  const requiredAny = agent.requiredEnvAny || [];
  if (requiredAny.length > 0 && !requiredAny.some((name) => env[name])) {
    return false;
  }

  return true;
}

function expandConfigPlaceholders(value, routerDir) {
  if (typeof value === "string") {
    return value.replaceAll("{router_dir}", routerDir);
  }

  if (Array.isArray(value)) {
    return value.map((item) => expandConfigPlaceholders(item, routerDir));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandConfigPlaceholders(item, routerDir)])
    );
  }

  return value;
}

function preparePromptFile(promptMode, prompt, cwd) {
  if (promptMode !== "file") {
    return "";
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-router-prompt-"));
  const file = path.join(dir, "prompt.txt");
  fs.writeFileSync(file, prompt, "utf8");
  return file;
}

function cleanupPromptFile(file) {
  if (!file) {
    return;
  }

  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup. A stale temp prompt file should not hide the CLI result.
  }
}

function isHeadroomInstallPending(line) {
  return (
    line.includes("[headroom] Headroom is not installed; automatically installing") ||
    line.includes("[headroom] Headroom installation is already running; waiting")
  );
}

function isHeadroomInstallFinished(line) {
  return (
    line.includes("[headroom] Headroom installation completed:") ||
    line.includes("[headroom] Headroom installation failed for")
  );
}

function prepareHeadroomInvocation(agentName, config, cwd, options) {
  if (agentName !== "claude-minimax") {
    return { env: {}, reportPath: null };
  }

  const reportPath = path.join(
    os.tmpdir(),
    `agent-router-headroom-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  );
  const headroomConfig = deepMerge(DEFAULT_HEADROOM_CONFIG, config.headroom || {});
  if (options.headroomMode) {
    headroomConfig.mode = options.headroomMode;
  }

  return {
    reportPath,
    env: {
      AGENT_ROUTER_HEADROOM_CONFIG: JSON.stringify(headroomConfig),
      AGENT_ROUTER_HEADROOM_REPORT_PATH: reportPath,
      AGENT_ROUTER_HEADROOM_PROJECT_ROOT: cwd
    }
  };
}

function readHeadroomReport(reportPath) {
  if (!reportPath) {
    return null;
  }
  try {
    const report = sanitizeHeadroomReport(JSON.parse(fs.readFileSync(reportPath, "utf8")));
    return Object.keys(report).length > 0 ? report : null;
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(reportPath);
    } catch {
      // The worker may have exited before it could write the sidecar.
    }
  }
}

function makeRunId(date) {
  return `${date.toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}
