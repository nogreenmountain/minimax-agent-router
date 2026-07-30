#!/usr/bin/env node
import { spawnSync } from "node:child_process";

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

const claudeArgs = [
  ...claudePrefixArgs,
  "-p",
  "--model",
  model,
  "--effort",
  effort,
  "--permission-mode",
  permissionMode,
  ...extraClaudeArgs
];

const spawnTarget = buildSpawnTarget(claudeCommand, claudeArgs);
const result = spawnSync(spawnTarget.command, spawnTarget.args, {
  input: prompt,
  encoding: "utf8",
  env: {
    ...process.env,
    ANTHROPIC_BASE_URL: process.env.CLAUDE_MINIMAX_BASE_URL || DEFAULT_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: process.env.CLAUDE_MINIMAX_SMALL_FAST_MODEL || model
  },
  maxBuffer: 20 * 1024 * 1024,
  windowsHide: true,
  shell: spawnTarget.shell || false
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
