import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const DEFAULT_CONFIG = {
  logPath: ".agent-router/runs.jsonl",
  defaults: {
    agent: "claude-minimax",
    think: "low",
    timeoutMs: 600000
  },
  routing: {
    codexKeywords: [
      "规划",
      "计划",
      "架构",
      "review",
      "code review",
      "审查",
      "生图",
      "画图",
      "image",
      "高风险",
      "安全"
    ],
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
  const text = String(task || "");
  const lower = text.toLowerCase();
  const keywords = config.routing?.codexKeywords || [];
  const matchedKeyword = keywords.find((keyword) => lower.includes(String(keyword).toLowerCase()));

  if (!options.agentName && matchedKeyword) {
    return {
      runByCodex: true,
      agentName: "codex",
      model: null,
      think: null,
      reason: `matched Codex-owned keyword: ${matchedKeyword}`
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
    reason: options.agentName ? "explicit agent override" : "first available configured agent"
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

  const result = spawnSync(agent.command, args, {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
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
  const status = result.status === 0 && !result.error ? "ok" : "error";
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
    stdoutChars: stdout.length,
    stderrChars: stderr.length,
    inputTokens,
    outputTokens,
    estimatedCost: estimateCost(inputTokens, outputTokens, agent.pricing)
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

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    let timedOut = false;
    let settled = false;

    const child = spawn(agent.command, args, {
      cwd,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true
    });

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs)
      : null;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
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
      const status = exitCode === 0 && !spawnError && !timedOut ? "ok" : "error";
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
        error: spawnError ? spawnError.message : timedOut ? `Timed out after ${timeoutMs}ms` : null,
        stdoutChars: stdout.length,
        stderrChars: stderr.length,
        inputTokens,
        outputTokens,
        estimatedCost: estimateCost(inputTokens, outputTokens, agent.pricing)
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
    const route = chooseRoute(prompt, config, {
      agentName: task.agent || options.agentName,
      model: task.model || options.model,
      think: task.think || options.think,
      env: options.env || process.env,
      isCommandAvailable: options.isCommandAvailable
    });
    const taskId = task.id || task.name || `task-${index + 1}`;

    if (route.runByCodex) {
      return {
        taskId,
        index,
        status: "codex",
        reason: route.reason,
        agent: "codex",
        stdout: "",
        stderr: ""
      };
    }

    const taskCwd = task.workspace || options.cwd || process.cwd();
    const result = await executeAgentAsync(prompt, config, {
      ...route,
      logPath: options.logPath,
      cwd: taskCwd,
      timeoutMs: task.timeoutMs || options.timeoutMs
    });

    return {
      taskId,
      index,
      ...result
    };
  }

  const workerCount = Math.min(parallel, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const summary = summarizeManyTaskResults(results);
  return {
    status: summary.errorTasks > 0 ? "error" : summary.codexTasks > 0 ? "needs-codex" : "ok",
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
  if (task.prompt) {
    return String(task.prompt);
  }

  const lines = [];
  if (task.workspace) {
    lines.push(`Workspace: ${task.workspace}`, "");
  }
  lines.push("Task:", String(task.task));
  if (task.scope) {
    lines.push("", "Scope:", formatTaskField(task.scope));
  }
  if (task.constraints) {
    lines.push("", "Constraints:", formatTaskField(task.constraints));
  }
  if (task.output) {
    lines.push("", "Output:", formatTaskField(task.output));
  }
  return lines.join("\n");
}

function summarizeManyTaskResults(results) {
  const summary = {
    totalTasks: results.length,
    okTasks: 0,
    errorTasks: 0,
    codexTasks: 0,
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

function makeRunId(date) {
  return `${date.toISOString().replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}
