#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { createMonitorServer } from "./monitor.js";
import {
  chooseRoute,
  DEFAULT_CONFIG,
  executeAgent,
  executeManyTasks,
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

  if (command === "doctor") {
    doctor(config, flags);
    return;
  }

  if (command === "minimax") {
    printMiniMaxGuide(configPath);
    return;
  }

  if (command === "route") {
    const task = getTask(flags, positional);
    const route = chooseRoute(task, config, {
      agentName: flags.agent,
      model: flags.model,
      think: flags.think
    });
    printPayload(route, flags, formatRoute(route));
    return;
  }

  if (command === "run") {
    const task = getTask(flags, positional);
    const route = chooseRoute(task, config, {
      agentName: flags.agent,
      model: flags.model,
      think: flags.think
    });

    if (route.runByCodex) {
      printPayload(route, flags, formatRoute(route));
      return;
    }

    const result = executeAgent(task, config, {
      ...route,
      logPath,
      cwd,
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
      timeoutMs: Number(flags["timeout-ms"] || flags.timeoutMs || config.defaults?.timeoutMs || 0) || undefined
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
      "3. Delegate a scoped task through Claude Code + MiniMax:",
      `node .\\src\\cli.js run --agent claude-minimax --task "Workspace: <absolute path>`,
      "Task: <specific change>",
      "Scope: <files it may touch>",
      "Constraints: preserve style; do not run destructive git commands.",
      `Output: summarize changed files and tests." --config "${configPath}"`,
      "",
      "Notes:",
      "- Do not write the MiniMax key into agent-router.config.json.",
      "- The wrapper maps MINIMAX_API_KEY to Claude Code's Anthropic-compatible endpoint.",
      "- Use doctor whenever routing falls back to another agent."
    ].join("\n")
  );
}

function formatRoute(route) {
  if (route.runByCodex) {
    return `Codex should handle this task itself (${route.reason}).`;
  }
  return `Route to ${route.agentName} with model=${route.model}, think=${route.think} (${route.reason}).`;
}

function formatStats(summary, logPath) {
  return [
    `Log: ${logPath}`,
    `Runs: ${summary.totalRuns} ok=${summary.okRuns} error=${summary.errorRuns}`,
    `Tokens: input=${summary.totalInputTokens} output=${summary.totalOutputTokens}`,
    `Estimated cost: $${Number(summary.totalEstimatedCost || 0).toFixed(6)}`
  ].join("\n");
}

function formatRunMany(result) {
  const lines = [
    `Run many: status=${result.status} parallel=${result.parallel}`,
    `Tasks: total=${result.summary.totalTasks} ok=${result.summary.okTasks} error=${result.summary.errorTasks} codex=${result.summary.codexTasks}`
  ];

  for (const entry of result.results) {
    lines.push(`- ${entry.taskId}: ${entry.status} ${entry.agent || ""}`.trimEnd());
    if (entry.status === "codex") {
      lines.push(`  reason: ${entry.reason}`);
    }
  }

  return lines.join("\n");
}

function printPayload(payload, flags, text = null) {
  if (flags.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(text ?? String(payload));
}

function getTask(flags, positional) {
  const task = flags.task || positional.join(" ");
  if (!task) {
    throw new Error("Missing task. Pass --task \"...\" or provide the task as positional text.");
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
  route --task "..."   Decide whether Codex or an external agent should handle a task
  run --task "..."     Run the selected external agent and log usage
  run-many --tasks f   Run independent tasks with a limited parallel worker pool
  stats                Summarize usage logs
  monitor              Start the local monitoring dashboard

Common options:
  --config <path>      Config file path
  --agent <name>       Force an agent
  --model <name>       Force a model
  --think <level>      Force thinking strength, such as low, medium, high
  --json               Print machine-readable JSON
`);
}
