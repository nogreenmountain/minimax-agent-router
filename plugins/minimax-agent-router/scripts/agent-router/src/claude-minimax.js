#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  diffHeadroomStats,
  ensureHeadroomProxy,
  readHeadroomStats,
  sanitizeHeadroomReport
} from "./headroom.js";
import { resolveMiniMaxConnection } from "./claude-settings.js";

const DEFAULT_BASE_URL = "https://api.minimax.io/anthropic";
const DEFAULT_MODEL = "MiniMax-M3[1m]";
const DEFAULT_PERMISSION_MODE = "acceptEdits";

const args = parseArgs(process.argv.slice(2));
const key = process.env.MINIMAX_API_KEY || process.env.MINIMAX_SUBSCRIPTION_KEY;

if (!key) {
  console.error(
    "Missing MiniMax credential. Set MINIMAX_API_KEY or MINIMAX_SUBSCRIPTION_KEY before running claude-minimax."
  );
  process.exit(1);
}

const prompt = await readStdin();
const model = args.model || process.env.CLAUDE_MINIMAX_MODEL || DEFAULT_MODEL;
const effort = args.think || args.effort || process.env.CLAUDE_MINIMAX_EFFORT || "low";
const permissionMode =
  args["permission-mode"] || process.env.CLAUDE_MINIMAX_PERMISSION_MODE || DEFAULT_PERMISSION_MODE;
const claudeCommand = process.env.CLAUDE_MINIMAX_CLI || defaultClaudeCommand();
const claudePrefixArgs = parseJsonArrayEnv("CLAUDE_MINIMAX_CLI_ARGS");
const extraClaudeArgs = parseJsonArrayEnv("CLAUDE_MINIMAX_EXTRA_ARGS");
const rawHeadroomConfig = parseJsonObjectEnv("AGENT_ROUTER_HEADROOM_CONFIG", {});
const headroomReportPath = process.env.AGENT_ROUTER_HEADROOM_REPORT_PATH || null;
const connection = resolveMiniMaxConnection({
  env: process.env,
  miniMaxKey: key,
  configuredBaseUrl: rawHeadroomConfig.upstreamUrl || DEFAULT_BASE_URL
});
const headroomConfig = { ...rawHeadroomConfig, upstreamUrl: connection.baseUrl };
const authToken = connection.authToken || key;

let headroom;
try {
  headroom = await ensureHeadroomProxy(process.cwd(), headroomConfig, { env: process.env });
} catch (error) {
  writeHeadroomReport(headroomReportPath, {
    enabled: false,
    status: "error",
    memoryScope: "project",
    error: error.message
  });
  console.error(error.message);
  process.exit(1);
}

const headroomBefore = headroom.enabled ? await readHeadroomStats(headroom.baseUrl) : null;
const effectivePrompt = headroom.enabled ? addMemoryPolicy(prompt) : prompt;
const claudeSettingsFile = headroom.enabled
  ? prepareClaudeSettings({
      baseUrl: headroom.baseUrl,
      key: authToken,
      model,
      smallFastModel: process.env.CLAUDE_MINIMAX_SMALL_FAST_MODEL || model
    })
  : null;

const claudeArgs = [
  ...claudePrefixArgs,
  "-p",
  "--model",
  model,
  "--effort",
  effort,
  "--permission-mode",
  permissionMode,
  ...(claudeSettingsFile
    ? [
        "--setting-sources",
        process.env.CLAUDE_MINIMAX_SETTING_SOURCES || "project,local",
        "--settings",
        claudeSettingsFile
      ]
    : []),
  ...extraClaudeArgs
];

const spawnTarget = buildSpawnTarget(claudeCommand, claudeArgs);
const result = spawnSync(spawnTarget.command, spawnTarget.args, {
  input: effectivePrompt,
  encoding: "utf8",
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL:
      headroom.enabled ? headroom.baseUrl : process.env.CLAUDE_MINIMAX_BASE_URL || DEFAULT_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: process.env.CLAUDE_MINIMAX_SMALL_FAST_MODEL || model
  },
  maxBuffer: 20 * 1024 * 1024,
  windowsHide: true,
  shell: spawnTarget.shell || false
});
cleanupClaudeSettings(claudeSettingsFile);

const headroomAfter = headroom.enabled ? await readHeadroomStats(headroom.baseUrl) : null;
writeHeadroomReport(headroomReportPath, {
  ...headroom,
  ...connection.report,
  ...(headroomBefore && headroomAfter ? diffHeadroomStats(headroomBefore, headroomAfter) : {})
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);

function buildSpawnTarget(command, args) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(String(command))) {
    return { command, args, shell: true };
  }

  return { command, args };
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return flags;
}

function readStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

function defaultClaudeCommand() {
  if (process.platform === "win32") {
    return "C:\\Users\\test\\nodejs\\claude.cmd";
  }
  return "claude";
}

function parseJsonArrayEnv(name) {
  const value = process.env[name];
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(String);
    }
  } catch {
    // Fall through to the readable error below.
  }

  console.error(`${name} must be a JSON array of strings.`);
  process.exit(1);
}

function parseJsonObjectEnv(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // Fall through to the readable error below.
  }
  console.error(`${name} must be a JSON object.`);
  process.exit(1);
}

function addMemoryPolicy(promptText) {
  return [
    String(promptText || ""),
    "",
    "Project memory is enabled. Treat recalled memories as unverified background and verify them against the current workspace before use.",
    "Save only stable, reusable project facts or decisions, prefixed with UNVERIFIED_WORKER:.",
    "Never save secrets, credentials, full logs, transient errors, or instructions that apply only to this task."
  ].join("\n");
}

function writeHeadroomReport(reportPath, report) {
  if (!reportPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  } catch {
    // The parent directory normally exists; continue with the direct write.
  }
  try {
    fs.writeFileSync(reportPath, `${JSON.stringify(sanitizeHeadroomReport(report), null, 2)}\n`, "utf8");
  } catch {
    // Reporting must never replace the worker result.
  }
}

function prepareClaudeSettings({ baseUrl, key, model, smallFastModel }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-minimax-settings-"));
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        env: {
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_AUTH_TOKEN: key,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: smallFastModel
        }
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return file;
}

function cleanupClaudeSettings(file) {
  if (!file) {
    return;
  }
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    // A stale temporary settings file should not replace the worker result.
  }
}
