#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { createMonitorServer } from "./monitor.js";
import {
  ensureHeadroomProxy,
  getHeadroomStatus,
  installHeadroom,
  readHeadroomStats,
  stopHeadroomProxy
} from "./headroom.js";
import { resolveMiniMaxConnection } from "./claude-settings.js";
import {
  chooseRoute,
  DEFAULT_CONFIG,
  executeAgentAsync,
  executeManyTasks,
  formatManyTaskPrompt,
  getLogPath,
  isCommandAvailable,
  loadConfig,
  loadRuns,
  summarizeRuns
} from "./router.js";

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main(argv) {
  const { command, flags, positional } = parseArgs(argv);
  const cwd = process.cwd();

  if (!command || flags.help || flags.h) {
    printHelp();
    return;
  }

  if (command === "init") {
    initConfig(flags, cwd);
    return;
  }

  const { config, path: configPath } = loadConfig(flags.config || "agent-router.config.json", cwd);
  const logPath = getLogPath(config, cwd);

  if (command === "headroom") {
    await handleHeadroomCommand(positional[0] || "doctor", config, flags, cwd);
    return;
  }

  if (command === "doctor") {
    doctor(config, flags);
    return;
  }

  if (command === "minimax") {
    printMiniMaxGuide(configPath);
    return;
  }

  if (command === "route") {
    const task = getTask(flags, positional, cwd);
    const route = chooseRoute(task, config, {
      agentName: flags.agent,
      model: flags.model,
      think: flags.think
    });
    printPayload(route, flags, formatRoute(route));
    return;
  }

  if (command === "run") {
    const task = getTask(flags, positional, cwd);
    const route = chooseRoute(task, config, {
      agentName: flags.agent,
      model: flags.model,
      think: flags.think
    });

    if (route.runByCodex) {
      printPayload(route, flags, formatRoute(route));
      return;
    }

    const prompt = typeof task === "string" ? task : formatManyTaskPrompt(task);
    const result = await executeAgentAsync(prompt, config, {
      ...route,
      logPath,
      cwd,
      headroomMode: flags.headroom,
      timeoutMs: Number(flags["timeout-ms"] || flags.timeoutMs || config.defaults?.timeoutMs || 0) || undefined
    });

    if (flags.json) {
      printPayload(result, flags);
      return;
    }

    if (result.stdout) {
      process.stdout.write(result.stdout);
      if (!result.stdout.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
      if (!result.stderr.endsWith("\n")) {
        process.stderr.write("\n");
      }
    }
    if (result.status !== "ok") {
      process.exitCode = result.exitCode || 1;
    }
    return;
  }

  if (command === "run-many") {
    const tasksPath = flags.tasks || flags.file;
    if (!tasksPath) {
      throw new Error("Missing tasks file. Pass --tasks tasks.json.");
    }
    const tasksFile = path.isAbsolute(tasksPath) ? tasksPath : path.join(cwd, tasksPath);
    const tasksInput = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
    const result = await executeManyTasks(tasksInput, config, {
      agentName: flags.agent,
      model: flags.model,
      think: flags.think,
      parallel: Number(flags.parallel || 2),
      logPath,
      cwd,
      headroomMode: flags.headroom,
      timeoutMs: Number(flags["timeout-ms"] || flags.timeoutMs || config.defaults?.timeoutMs || 0) || undefined,
      onEvent: (event) => printTaskEvent(event, flags)
    });

    if (flags.json) {
      printPayload(result, flags);
      return;
    }

    console.log(formatRunMany(result));
    if (result.status === "error") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "stats") {
    const summary = summarizeRuns(loadRuns(logPath));
    printPayload(summary, flags, formatStats(summary, logPath));
    return;
  }

  if (command === "monitor") {
    const port = Number(flags.port || 8787);
    const server = createMonitorServer({ config, configPath, logPath });
    await new Promise((resolve) => {
      server.listen(port, "127.0.0.1", resolve);
    });
    console.log(`Agent Router Monitor: http://127.0.0.1:${port}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function initConfig(flags, cwd) {
  const configPath = path.resolve(cwd, flags.config || "agent-router.config.json");
  if (fs.existsSync(configPath) && !flags.force) {
    throw new Error(`${configPath} already exists. Re-run with --force to overwrite it.`);
  }
  fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  console.log(`Created ${configPath}`);
}

function doctor(config, flags) {
  const results = Object.entries(config.agents || {}).map(([name, agent]) => {
    const commandAvailable = Boolean(agent.enabled) && isCommandAvailable(agent.command);
    const missingEnv = (agent.requiredEnv || []).filter((envName) => !process.env[envName]);
    const requiredEnvAny = agent.requiredEnvAny || [];
    const hasAnyEnv = requiredEnvAny.length === 0 || requiredEnvAny.some((envName) => process.env[envName]);
    const missingEnvAny = hasAnyEnv ? [] : requiredEnvAny;

    return {
      agent: name,
      enabled: Boolean(agent.enabled),
      command: agent.command,
      available: commandAvailable && missingEnv.length === 0 && missingEnvAny.length === 0,
      commandAvailable,
      missingEnv,
      missingEnvAny,
      defaultModel: agent.defaultModel || null,
      defaultThink: agent.defaultThink || null
    };
  });

  if (flags.json) {
    printPayload(results, flags);
    return;
  }

  for (const result of results) {
    const state = result.available
      ? "available"
      : result.commandAvailable
        ? "missing-env"
        : "missing";
    console.log(`${result.agent.padEnd(16)} ${state.padEnd(12)} ${result.command}`);
    if (result.missingEnv.length > 0) {
      console.log(`  needs: ${result.missingEnv.join(", ")}`);
    }
    if (result.missingEnvAny.length > 0) {
      console.log(`  needs one of: ${result.missingEnvAny.join(", ")}`);
      if (result.agent === "claude-minimax") {
        console.log("  cmd: set MINIMAX_API_KEY=<your MiniMax Subscription Key>");
        console.log("  powershell: $env:MINIMAX_API_KEY=\"<your MiniMax Subscription Key>\"");
        console.log("  guide: agent-router minimax");
      }
    }
  }
}

function printMiniMaxGuide(configPath) {
  console.log(
    [
      "MiniMax setup for claude-minimax",
      "",
      "1. Set your MiniMax Token Plan key in your current terminal session.",
      "",
      "If your prompt looks like C:\\work>, you are in cmd.exe:",
      "set MINIMAX_API_KEY=<your MiniMax Subscription Key>",
      "",
      "If your prompt starts with PS, you are in PowerShell:",
      "$env:MINIMAX_API_KEY=\"<your MiniMax Subscription Key>\"",
      "",
      "2. Verify that the route is ready:",
      `node .\\src\\cli.js doctor --config "${configPath}"`,
      "",
      "3. Put one 3-5 minute task in task.json with kind, scope, testCommand, and optional apiExamples.",
      "",
      "4. Preflight without spending MiniMax quota:",
      `node .\\src\\cli.js route --task-file task.json --json --config "${configPath}"`,
      "",
      "5. Run only when assessment.decision is delegate:",
      `node .\\src\\cli.js run --agent claude-minimax --task-file task.json --json --config "${configPath}"`,
      "",
      "Notes:",
      "- Do not write the MiniMax key into agent-router.config.json.",
      "- The wrapper maps MINIMAX_API_KEY to Claude Code's Anthropic-compatible endpoint.",
      "- The default worker budget is 5 minutes, and every successful result still needs Codex review.",
      "- Use doctor whenever routing falls back to another agent."
    ].join("\n")
  );
}

function formatRoute(route) {
  if (route.runByCodex) {
    return `Codex should handle this task itself (${route.reason}). score=${route.assessment?.score ?? "n/a"}`;
  }
  return `Route to ${route.agentName} with model=${route.model}, think=${route.think} (${route.reason}). score=${route.assessment?.score ?? "n/a"}`;
}

function formatStats(summary, logPath) {
  return [
    `Log: ${logPath}`,
    `Runs: ${summary.totalRuns} ok=${summary.okRuns} error=${summary.errorRuns}`,
    `Tokens: input=${summary.totalInputTokens} output=${summary.totalOutputTokens}`,
    `Estimated cost: $${Number(summary.totalEstimatedCost || 0).toFixed(6)}`,
    `Headroom: enabledRuns=${summary.headroom?.enabledRuns || 0} savedTokens=${summary.headroom?.tokensSaved || 0} fallbackRuns=${summary.headroom?.fallbackRuns || 0}`
  ].join("\n");
}

async function handleHeadroomCommand(subcommand, config, flags, cwd) {
  const workspace = path.resolve(cwd, flags.workspace || ".");
  if (subcommand === "doctor" || subcommand === "status") {
    const status = await getHeadroomStatus(workspace, config.headroom || {});
    printPayload(status, flags, formatHeadroomStatus(status));
    return;
  }

  if (subcommand === "setup") {
    const result = installHeadroom(config.headroom || {}, { workspace });
    printPayload(result, flags, `Headroom installed: ${result.command}`);
    return;
  }

  if (subcommand === "start") {
    const configuredHeadroom = config.headroom || {};
    const connection = resolveMiniMaxConnection({
      env: process.env,
      miniMaxKey: process.env.MINIMAX_API_KEY || process.env.MINIMAX_SUBSCRIPTION_KEY,
      configuredBaseUrl: configuredHeadroom.upstreamUrl
    });
    const result = await ensureHeadroomProxy(workspace, {
      ...configuredHeadroom,
      upstreamUrl: connection.baseUrl,
      mode: "required"
    }, { onInstallEvent: printHeadroomInstallEvent });
    printPayload(result, flags, formatHeadroomStatus(result));
    return;
  }

  if (subcommand === "stop") {
    const result = await stopHeadroomProxy(workspace, config.headroom || {});
    printPayload(result, flags, `Headroom: ${result.status} workspace=${result.workspaceId}`);
    return;
  }

  if (subcommand === "stats") {
    const status = await getHeadroomStatus(workspace, config.headroom || {});
    const stats = status.enabled ? await readHeadroomStats(status.baseUrl) : null;
    const payload = { ...status, ...(stats || {}) };
    printPayload(payload, flags, formatHeadroomStatus(payload));
    return;
  }

  throw new Error(`Unknown Headroom command: ${subcommand}`);
}

function formatHeadroomStatus(status) {
  const lines = [
    `Headroom: ${status.status}`,
    `Workspace: ${status.workspaceId || "unknown"}`,
    `Memory scope: ${status.memoryScope || "project"}`
  ];
  if (status.baseUrl) {
    lines.push(`Proxy: ${status.baseUrl}`);
  }
  if (status.tokensSaved !== undefined) {
    lines.push(`Tokens saved: ${status.tokensSaved}`);
  }
  if (status.runnable !== undefined) {
    lines.push(`Runnable: ${status.runnable ? "yes" : "no"}`);
  }
  if (status.note) {
    lines.push(`Note: ${status.note}`);
  }
  if (status.memoryStatus) {
    lines.push(`Memory: ${status.memoryStatus}`);
  }
  if (status.memoryNote) {
    lines.push(`Memory note: ${status.memoryNote}`);
  }
  if (status.autoInstall !== undefined) {
    lines.push(`Auto install: ${status.autoInstall ? "enabled" : "disabled"}`);
  }
  if (status.packageSpec) {
    lines.push(`Package: ${status.packageSpec}`);
  }
  return lines.join("\n");
}

function printHeadroomInstallEvent(event) {
  const messages = {
    waiting: `Headroom installation is already running; waiting for ${event.packageSpec}.`,
    installing: `Headroom is not installed; automatically installing ${event.packageSpec}.`,
    installed: `Headroom installation completed: ${event.packageSpec}.`,
    failed: `Headroom installation failed for ${event.packageSpec}: ${event.error || "unknown error"}`
  };
  if (messages[event.status]) {
    console.error(`[headroom] ${messages[event.status]}`);
  }
}

function formatRunMany(result) {
  const lines = [
    `Run many: status=${result.status} parallel=${result.parallel}`,
    `Tasks: total=${result.summary.totalTasks} ok=${result.summary.okTasks} error=${result.summary.errorTasks} timedOut=${result.summary.timedOutTasks} codex=${result.summary.codexTasks} pendingReview=${result.summary.pendingReviewTasks}`
  ];

  for (const entry of result.results) {
    lines.push(`- ${entry.taskId}: ${entry.status} ${entry.agent || ""}`.trimEnd());
    if (entry.status === "codex") {
      lines.push(`  reason: ${entry.reason}`);
    }
  }

  return lines.join("\n");
}

function printTaskEvent(event, flags) {
  if (flags.quiet) {
    return;
  }
  const status = event.status ? ` status=${event.status}` : "";
  process.stderr.write(`[agent-router] ${event.taskId} ${event.type === "task-started" ? "started" : "finished"}${status}\n`);
}

function printPayload(payload, flags, text = null) {
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(text ?? String(payload));
}

function getTask(flags, positional, cwd) {
  const taskFileFlag = flags["task-file"] || flags.taskFile;
  if (taskFileFlag) {
    const taskFile = path.isAbsolute(taskFileFlag) ? taskFileFlag : path.join(cwd, taskFileFlag);
    const task = JSON.parse(fs.readFileSync(taskFile, "utf8"));
    if (!task || Array.isArray(task) || typeof task !== "object") {
      throw new Error("--task-file must contain one structured task object.");
    }
    return task;
  }
  const task = flags.task || positional.join(" ");
  if (!task) {
    throw new Error("Missing task. Pass --task \"...\", --task-file task.json, or positional text.");
  }
  return task;
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!command && !arg.startsWith("-")) {
      command = arg;
      continue;
    }

    if (arg.startsWith("--")) {
      const withoutPrefix = arg.slice(2);
      const [rawKey, inlineValue] = withoutPrefix.split("=", 2);
      const key = rawKey.trim();
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      flags[arg.slice(1)] = true;
      continue;
    }

    positional.push(arg);
  }

  return { command, flags, positional };
}

function printHelp() {
  console.log(`agent-router <command> [options]

Commands:
  init                 Create agent-router.config.json
  doctor               Show configured agent command availability
  minimax              Show how to enable Claude Code through MiniMax
  route --task "..."   Assess task fit and decide whether Codex or an agent should handle it
  run --task "..."     Run a task that passed the safety gate and log usage
  run-many --tasks f   Run independent tasks with a limited parallel worker pool
  stats                Summarize usage logs
  monitor              Start the local monitoring dashboard
  headroom doctor      Check Headroom installation and this project's proxy
  headroom setup       Install pinned Headroom into the router-managed virtual environment
  headroom start       Start or reuse this project's compression and memory proxy
  headroom stop        Stop this project's proxy
  headroom stats       Show this project's live compression statistics

Common options:
  --config <path>      Config file path
  --agent <name>       Force an agent
  --model <name>       Force a model
  --think <level>      Force thinking strength, such as low, medium, high
  --task-file <path>   Load one structured task JSON object for route or run
  --timeout-ms <ms>    Override the default 5-minute worker budget
  --headroom <mode>    Use auto, required, or off for this run
  --workspace <path>   Select the workspace for Headroom lifecycle commands
  --quiet              Hide run-many start/finish progress events
  --json               Print machine-readable JSON
`);
}
