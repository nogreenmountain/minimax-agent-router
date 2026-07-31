import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const HEADROOM_PACKAGE_SPEC = "headroom-ai[proxy]==0.33.0";

export const DEFAULT_HEADROOM_CONFIG = {
  mode: "auto",
  autoInstall: true,
  host: "127.0.0.1",
  upstreamUrl: "https://api.minimax.io/anthropic",
  memoryStorage: "project",
  memoryTopK: 3,
  savingsProfile: "coding",
  installWaitMs: 1200000,
  startupTimeoutMs: 300000,
  portRangeStart: 18787,
  portRangeSize: 1000,
  telemetry: false,
  packageSpec: HEADROOM_PACKAGE_SPEC
};

export function normalizeHeadroomConfig(config = {}, env = process.env) {
  const merged = { ...DEFAULT_HEADROOM_CONFIG, ...(config || {}) };
  const mode = String(env.AGENT_ROUTER_HEADROOM_MODE || merged.mode || "auto").toLowerCase();
  if (!new Set(["auto", "required", "off"]).has(mode)) {
    throw new Error(`Invalid Headroom mode: ${mode}. Use auto, required, or off.`);
  }
  if (String(merged.memoryStorage || "project").toLowerCase() !== "project") {
    throw new Error("Henchman requires project memory isolation; global or user memory is not allowed.");
  }
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(String(merged.host || "127.0.0.1").toLowerCase())) {
    throw new Error("Headroom must bind to a loopback address.");
  }

  return {
    ...merged,
    mode,
    autoInstall: parseBoolean(
      env.AGENT_ROUTER_HEADROOM_AUTO_INSTALL,
      Boolean(merged.autoInstall)
    ),
    command: env.AGENT_ROUTER_HEADROOM_COMMAND || merged.command || null,
    stateRoot:
      env.AGENT_ROUTER_HEADROOM_STATE_ROOT ||
      merged.stateRoot ||
      path.join(os.homedir(), ".agent-router", "headroom"),
    memoryTopK: clampInteger(
      env.AGENT_ROUTER_HEADROOM_MEMORY_TOP_K || merged.memoryTopK,
      1,
      100,
      DEFAULT_HEADROOM_CONFIG.memoryTopK
    ),
    startupTimeoutMs: clampInteger(
      env.AGENT_ROUTER_HEADROOM_STARTUP_TIMEOUT_MS || merged.startupTimeoutMs,
      100,
      600000,
      DEFAULT_HEADROOM_CONFIG.startupTimeoutMs
    ),
    installWaitMs: clampInteger(
      env.AGENT_ROUTER_HEADROOM_INSTALL_WAIT_MS || merged.installWaitMs,
      1000,
      3600000,
      DEFAULT_HEADROOM_CONFIG.installWaitMs
    ),
    portRangeStart: clampInteger(merged.portRangeStart, 1024, 65535, 18787),
    portRangeSize: clampInteger(merged.portRangeSize, 1, 10000, 1000),
    commandArgs: Array.isArray(merged.commandArgs) ? merged.commandArgs.map(String) : [],
    packageSpec: merged.packageSpec || HEADROOM_PACKAGE_SPEC
  };
}

export function getWorkspaceIdentity(workspace) {
  const resolved = path.resolve(String(workspace || process.cwd()));
  const withoutTrailing = resolved.replace(/[\\/]+$/, "") || resolved;
  const normalized = process.platform === "win32" ? withoutTrailing.toLowerCase() : withoutTrailing;
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12);
  const baseName = sanitizeSegment(path.basename(normalized) || "workspace");
  return {
    root: withoutTrailing,
    normalized,
    hash,
    id: `${baseName}-${hash}`
  };
}

export function resolveHeadroomPaths(workspace, config = {}) {
  const normalizedConfig = normalizeHeadroomConfig(config);
  const identity = getWorkspaceIdentity(workspace);
  const projectStateDir = path.join(normalizedConfig.stateRoot, "projects", identity.id);
  return {
    workspaceRoot: identity.root,
    workspaceId: identity.id,
    stateRoot: normalizedConfig.stateRoot,
    projectStateDir,
    memoryDbPath: path.join(projectStateDir, "memory.db"),
    stateFile: path.join(projectStateDir, "proxy.json"),
    stdoutLog: path.join(projectStateDir, "proxy.stdout.log"),
    stderrLog: path.join(projectStateDir, "proxy.stderr.log"),
    savingsPath: path.join(projectStateDir, "proxy-savings.json"),
    installLockPath: path.join(normalizedConfig.stateRoot, "install.lock"),
    venvDir: path.join(normalizedConfig.stateRoot, "venv"),
    venvCommand:
      process.platform === "win32"
        ? path.join(normalizedConfig.stateRoot, "venv", "Scripts", "headroom.exe")
        : path.join(normalizedConfig.stateRoot, "venv", "bin", "headroom")
  };
}

export function buildHeadroomProxyArgs(paths, config = {}) {
  const normalizedConfig = normalizeHeadroomConfig(config);
  const port = Number(config.port || normalizedConfig.portRangeStart);
  return [
    "proxy",
    "--host",
    normalizedConfig.host,
    "--port",
    String(port),
    "--workers",
    "1",
    "--anthropic-api-url",
    normalizedConfig.upstreamUrl,
    "--memory",
    "--memory-storage",
    normalizedConfig.memoryStorage,
    "--memory-project-root",
    paths.workspaceRoot,
    "--memory-db-path",
    paths.memoryDbPath,
    "--memory-top-k",
    String(normalizedConfig.memoryTopK)
  ];
}

export async function ensureHeadroomProxy(workspace, config = {}, options = {}) {
  const normalizedConfig = normalizeHeadroomConfig(config, options.env || process.env);
  const paths = resolveHeadroomPaths(workspace, normalizedConfig);

  if (normalizedConfig.mode === "off") {
    return sanitizeHeadroomReport({
      enabled: false,
      status: "disabled",
      workspaceId: paths.workspaceId,
      memoryScope: "project"
    });
  }

  let runtime;
  try {
    runtime = await ensureHeadroomRuntime(workspace, normalizedConfig, options);
  } catch (error) {
    emitInstallEvent(options, {
      status: "failed",
      packageSpec: normalizedConfig.packageSpec,
      error: error.message
    });
    return handleAutoInstallFailure(normalizedConfig, paths, error);
  }
  const command = runtime.command;
  if (!command) {
    if (normalizedConfig.mode === "required") {
      throw new Error("Headroom is not available. Run `agent-router headroom setup` first.");
    }
    return sanitizeHeadroomReport({
      enabled: false,
      status: "fallback-direct",
      reason: "headroom-not-installed",
      workspaceId: paths.workspaceId,
      memoryScope: "project"
    });
  }

  fs.mkdirSync(paths.projectStateDir, { recursive: true });
  const existing = readJson(paths.stateFile);
  if (existing?.workspaceId === paths.workspaceId && existing?.port) {
    const health = await probeJson(`http://${normalizedConfig.host}:${existing.port}/health`, 1500);
    if (isHealthy(health)) {
      const proxyPid = resolveProxyPid(health, existing.pid);
      const reportedUpstream = resolveHealthUpstream(health);
      if (reportedUpstream && normalizeUrl(reportedUpstream) !== normalizeUrl(normalizedConfig.upstreamUrl)) {
        tryKill(proxyPid);
        await waitForPortFree(normalizedConfig.host, existing.port, 5000);
        try {
          fs.unlinkSync(paths.stateFile);
        } catch {
          // The state file may already be gone.
        }
      } else {
        if (proxyPid !== existing.pid) {
          fs.writeFileSync(paths.stateFile, `${JSON.stringify({ ...existing, pid: proxyPid }, null, 2)}\n`, "utf8");
        }
        return sanitizeHeadroomReport({
          enabled: true,
          status: "reused",
          runnable: true,
          baseUrl: `http://${normalizedConfig.host}:${existing.port}`,
          port: existing.port,
          pid: proxyPid,
          workspaceId: paths.workspaceId,
          memoryScope: "project",
          memoryDbPath: paths.memoryDbPath,
          savingsProfile: normalizedConfig.savingsProfile,
          autoInstalled: runtime.autoInstalled,
          upstreamUrl: normalizedConfig.upstreamUrl,
          ...getMemoryDiagnostics(paths)
        });
      }
    }
  }

  const preferredPort = choosePreferredPort(paths.workspaceId, normalizedConfig);
  const port = await findFreePort(normalizedConfig.host, preferredPort, normalizedConfig.portRangeSize);
  const proxyArgs = buildHeadroomProxyArgs(paths, { ...normalizedConfig, port });
  const stdoutFd = fs.openSync(paths.stdoutLog, "a");
  const stderrFd = fs.openSync(paths.stderrLog, "a");
  const childEnv = buildProxyEnvironment(normalizedConfig, paths, options.env || process.env);
  let child;
  try {
    child = spawn(command, [...normalizedConfig.commandArgs, ...proxyArgs], {
      cwd: paths.workspaceRoot,
      env: childEnv,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", stdoutFd, stderrFd]
    });
    child.unref();
  } catch (error) {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return handleStartFailure(normalizedConfig, paths, error);
  }
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const state = {
    workspaceId: paths.workspaceId,
    workspaceRoot: paths.workspaceRoot,
    port,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    upstreamUrl: normalizedConfig.upstreamUrl,
    memoryScope: "project"
  };
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  const baseUrl = `http://${normalizedConfig.host}:${port}`;
  const health = await waitForHealth(baseUrl, normalizedConfig.startupTimeoutMs);
  if (!isHealthy(health)) {
    tryKill(child.pid);
    const startupHint = getStartupHint(paths);
    const error = new Error(
      `Headroom proxy did not become healthy within ${normalizedConfig.startupTimeoutMs}ms. ` +
        `See ${paths.stderrLog}.${startupHint ? ` ${startupHint}` : ""}`
    );
    return handleStartFailure(normalizedConfig, paths, error);
  }

  const proxyPid = resolveProxyPid(health, child.pid);
  if (proxyPid !== state.pid) {
    state.pid = proxyPid;
    fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  return sanitizeHeadroomReport({
    enabled: true,
    status: "started",
    runnable: true,
    baseUrl,
    port,
    pid: proxyPid,
    workspaceId: paths.workspaceId,
    memoryScope: "project",
    memoryDbPath: paths.memoryDbPath,
    savingsProfile: normalizedConfig.savingsProfile,
    autoInstalled: runtime.autoInstalled,
    upstreamUrl: normalizedConfig.upstreamUrl,
    ...getMemoryDiagnostics(paths)
  });
}

export async function ensureHeadroomRuntime(workspace, config = {}, options = {}) {
  const env = options.env || process.env;
  const normalizedConfig = normalizeHeadroomConfig(config, env);
  const paths = resolveHeadroomPaths(workspace, normalizedConfig);
  const resolveCommand = options.resolveCommand || resolveHeadroomCommand;
  const installer = options.installHeadroom || installHeadroom;
  let command = resolveCommand(paths, normalizedConfig, env);
  if (command || !normalizedConfig.autoInstall) {
    return { command, autoInstalled: false };
  }

  fs.mkdirSync(normalizedConfig.stateRoot, { recursive: true });
  const deadline = Date.now() + normalizedConfig.installWaitMs;
  let waitedForAnotherInstaller = false;

  while (Date.now() < deadline) {
    const lockExists = fs.existsSync(paths.installLockPath);
    if (!waitedForAnotherInstaller || !lockExists) {
      command = resolveCommand(paths, normalizedConfig, env);
      if (command) {
        return { command, autoInstalled: waitedForAnotherInstaller };
      }
    }

    let lockFd;
    try {
      lockFd = fs.openSync(paths.installLockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (clearStaleInstallLock(paths.installLockPath)) {
        continue;
      }
      if (!waitedForAnotherInstaller) {
        emitInstallEvent(options, { status: "waiting", packageSpec: normalizedConfig.packageSpec });
      }
      waitedForAnotherInstaller = true;
      await delay(250);
      continue;
    }

    try {
      fs.writeFileSync(
        lockFd,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        "utf8"
      );
    } catch (error) {
      try {
        fs.closeSync(lockFd);
      } catch {
        // Best-effort cleanup after a lock initialization failure.
      }
      try {
        fs.unlinkSync(paths.installLockPath);
      } catch {
        // Best-effort cleanup after a lock initialization failure.
      }
      throw error;
    }

    try {
      emitInstallEvent(options, { status: "installing", packageSpec: normalizedConfig.packageSpec });
      await Promise.resolve(
        installer(normalizedConfig, {
          env,
          workspace,
          timeoutMs: normalizedConfig.installWaitMs
        })
      );
      command = resolveCommand(paths, normalizedConfig, env);
      if (!command) {
        throw new Error(`Headroom installer completed but ${paths.venvCommand} is unavailable.`);
      }
      emitInstallEvent(options, { status: "installed", packageSpec: normalizedConfig.packageSpec });
      return { command, autoInstalled: true };
    } finally {
      try {
        fs.closeSync(lockFd);
      } catch {
        // The lock descriptor may already be closed after a failed install.
      }
      try {
        fs.unlinkSync(paths.installLockPath);
      } catch {
        // Another recovery path may already have removed a stale lock.
      }
    }
  }

  throw new Error(`Timed out waiting ${normalizedConfig.installWaitMs}ms for Headroom installation.`);
}

export async function stopHeadroomProxy(workspace, config = {}) {
  const normalizedConfig = normalizeHeadroomConfig(config);
  const paths = resolveHeadroomPaths(workspace, normalizedConfig);
  const state = readJson(paths.stateFile);
  if (!state?.pid) {
    return { status: "not-running", workspaceId: paths.workspaceId };
  }

  const stopped = tryKill(state.pid);
  try {
    fs.unlinkSync(paths.stateFile);
  } catch {
    // Already removed.
  }
  return { status: stopped ? "stopped" : "stale", workspaceId: paths.workspaceId, pid: state.pid };
}

export async function getHeadroomStatus(workspace, config = {}) {
  const normalizedConfig = normalizeHeadroomConfig(config);
  const paths = resolveHeadroomPaths(workspace, normalizedConfig);
  const command = resolveHeadroomCommand(paths, normalizedConfig);
  const state = readJson(paths.stateFile);
  const baseUrl = state?.port ? `http://${normalizedConfig.host}:${state.port}` : null;
  const health = baseUrl ? await probeJson(`${baseUrl}/health`, 1500) : null;
  const installed = Boolean(command);
  const running = isHealthy(health);
  return sanitizeHeadroomReport({
    installed,
    runnable: installed,
    enabled: running,
    status: running ? "running" : installed ? "stopped" : "not-installed",
    note: running
      ? "Headroom is running for this workspace."
      : installed
        ? "Headroom is installed and starts on demand with --headroom auto/required."
        : normalizedConfig.autoInstall
          ? "Headroom will be installed automatically on the first MiniMax/Headroom task."
          : "Headroom is not installed and automatic installation is disabled.",
    baseUrl: running ? baseUrl : null,
    port: running ? state.port : null,
    pid: running ? state.pid : null,
    workspaceId: paths.workspaceId,
    memoryScope: "project",
    memoryDbPath: paths.memoryDbPath,
    savingsProfile: normalizedConfig.savingsProfile,
    autoInstall: normalizedConfig.autoInstall,
    packageSpec: normalizedConfig.packageSpec,
    ...getMemoryDiagnostics(paths)
  });
}

export async function readHeadroomStats(baseUrl) {
  if (!baseUrl) {
    return null;
  }
  const payload =
    (await probeJson(`${baseUrl}/stats-history`, 3000)) ||
    (await probeJson(`${baseUrl}/stats`, 3000));
  return payload ? extractHeadroomStats(payload) : null;
}

export function extractHeadroomStats(payload = {}) {
  return {
    requests: firstNumber(payload, [
      ["lifetime", "requests"],
      ["requests", "total"],
      ["stats", "total_requests"],
      ["summary", "total_requests"],
      ["metrics", "requests_total"],
      ["requests_total"]
    ]),
    inputTokens: firstNumber(payload, [
      ["lifetime", "total_input_tokens"],
      ["stats", "tokens_input"],
      ["stats", "input_tokens"],
      ["summary", "input_tokens"],
      ["tokens", "input"],
      ["tokens_input_total"]
    ]),
    tokensSaved: firstNumber(payload, [
      ["lifetime", "tokens_saved"],
      ["savings", "total_tokens"],
      ["stats", "tokens_saved"],
      ["summary", "tokens_saved"],
      ["tokens", "saved"],
      ["persistent_savings", "tokens_saved"],
      ["tokens_saved_total"]
    ])
  };
}

export function diffHeadroomStats(before = {}, after = {}) {
  const requests = nonNegativeDelta(before.requests, after.requests);
  const inputTokens = nonNegativeDelta(before.inputTokens, after.inputTokens);
  const tokensSaved = nonNegativeDelta(before.tokensSaved, after.tokensSaved);
  const baseline = inputTokens + tokensSaved;
  return {
    requests,
    inputTokens,
    tokensSaved,
    savingsPercent: baseline > 0 ? Math.round((tokensSaved / baseline) * 10000) / 100 : 0
  };
}

export function resolveProxyPid(health, fallbackPid) {
  const reported = Number(health?.config?.pid || health?.runtime?.pid || 0);
  return Number.isInteger(reported) && reported > 0 ? reported : Number(fallbackPid || 0) || null;
}

export function sanitizeHeadroomReport(report = {}) {
  const allowed = [
    "installed",
    "runnable",
    "enabled",
    "status",
    "note",
    "reason",
    "baseUrl",
    "port",
    "pid",
    "workspaceId",
    "memoryScope",
    "memoryDbPath",
    "memoryStatus",
    "memoryNote",
    "savingsProfile",
    "autoInstall",
    "autoInstalled",
    "packageSpec",
    "upstreamUrl",
    "upstreamSource",
    "requests",
    "inputTokens",
    "tokensSaved",
    "savingsPercent",
    "error"
  ];
  const clean = {};
  for (const key of allowed) {
    if (report[key] === undefined) {
      continue;
    }
    clean[key] = typeof report[key] === "string" ? redactSecrets(report[key]) : report[key];
  }
  return clean;
}

export function installHeadroom(config = {}, options = {}) {
  const normalizedConfig = normalizeHeadroomConfig(config, options.env || process.env);
  const paths = resolveHeadroomPaths(options.workspace || process.cwd(), normalizedConfig);
  fs.mkdirSync(normalizedConfig.stateRoot, { recursive: true });
  const pythonCommand =
    options.pythonCommand || normalizedConfig.pythonCommand || (process.platform === "win32" ? "py" : "python3");
  const pythonArgs = Array.isArray(options.pythonArgs)
    ? options.pythonArgs
    : process.platform === "win32"
      ? ["-3"]
      : [];
  const venvPython =
    process.platform === "win32"
      ? path.join(paths.venvDir, "Scripts", "python.exe")
      : path.join(paths.venvDir, "bin", "python");

  if (!fs.existsSync(venvPython)) {
    const create = spawnSync(pythonCommand, [...pythonArgs, "-m", "venv", paths.venvDir], {
      encoding: "utf8",
      env: options.env || process.env,
      timeout: options.timeoutMs || 120000,
      windowsHide: true
    });
    if (create.status !== 0 || create.error) {
      throw new Error(`Failed to create Headroom virtual environment: ${create.stderr || create.error?.message}`);
    }
  }

  const install = spawnSync(
    venvPython,
    ["-m", "pip", "install", "--upgrade", normalizedConfig.packageSpec],
    {
      encoding: "utf8",
      env: options.env || process.env,
      timeout: options.timeoutMs || 1200000,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    }
  );
  if (install.status !== 0 || install.error) {
    throw new Error(`Failed to install Headroom: ${install.stderr || install.error?.message}`);
  }

  return {
    status: "installed",
    command: paths.venvCommand,
    packageSpec: normalizedConfig.packageSpec,
    outputTail: String(install.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-3)
      .join("\n")
  };
}

function resolveHeadroomCommand(paths, config, env = process.env) {
  const candidates = [config.command, env.HEADROOM_CLI, paths.venvCommand, "headroom"].filter(Boolean);
  return candidates.find((candidate) => isCommandAvailable(candidate, env)) || null;
}

function isCommandAvailable(command, env = process.env) {
  const value = String(command);
  if (path.isAbsolute(value) || /[\\/]/.test(value)) {
    return fs.existsSync(value);
  }
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [value], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 3000
  });
  return result.status === 0;
}

export function buildProxyEnvironment(config, paths, sourceEnv) {
  const env = { ...sourceEnv };
  for (const name of [
    "MINIMAX_API_KEY",
    "MINIMAX_SUBSCRIPTION_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN"
  ]) {
    delete env[name];
  }
  env.ANTHROPIC_TARGET_API_URL = config.upstreamUrl;
  env.HEADROOM_WORKSPACE_DIR = paths.projectStateDir;
  env.HEADROOM_MEMORY_DB_PATH = paths.memoryDbPath;
  env.HEADROOM_MEMORY_PROJECT_ROOT = paths.workspaceRoot;
  env.HEADROOM_MEMORY_TOP_K = String(config.memoryTopK);
  env.HEADROOM_SAVINGS_PATH = paths.savingsPath;
  env.HEADROOM_SAVINGS_PROFILE = config.savingsProfile;
  env.HEADROOM_TOOL_SEARCH = "0";
  env.HEADROOM_TELEMETRY = config.telemetry ? "on" : "off";
  env.HEADROOM_OUTPUT_SHAPER = "off";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUTF8 = "1";
  return env;
}

function choosePreferredPort(workspaceId, config) {
  const hash = crypto.createHash("sha256").update(workspaceId).digest();
  const offset = hash.readUInt32BE(0) % config.portRangeSize;
  const maxStart = Math.min(config.portRangeStart, 65535 - config.portRangeSize);
  return maxStart + offset;
}

async function findFreePort(host, preferredPort, rangeSize) {
  for (let offset = 0; offset < rangeSize; offset += 1) {
    const port = preferredPort + offset > 65535 ? 1024 + offset : preferredPort + offset;
    if (await isPortFree(host, port)) {
      return port;
    }
  }
  throw new Error(`No free Headroom proxy port found near ${preferredPort}.`);
}

function isPortFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeJson(`${baseUrl}/health`, 1500);
    if (isHealthy(health)) {
      return health;
    }
    await delay(200);
  }
  return null;
}

async function probeJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isHealthy(payload) {
  return Boolean(payload && ["healthy", "ok", "ready"].includes(String(payload.status || "").toLowerCase()));
}

function resolveHealthUpstream(health) {
  return health?.checks?.upstream?.url || health?.config?.anthropic_api_url || null;
}

function getMemoryDiagnostics(paths) {
  const logs = `${readTextTail(paths.stdoutLog)}\n${readTextTail(paths.stderrLog)}`;
  if (/embedder warm-up failed\s*\(non-fatal\)/i.test(logs)) {
    return {
      memoryStatus: "degraded",
      memoryNote:
        "The proxy remains usable, but semantic memory retrieval may be degraded because the embedding model warm-up failed."
    };
  }
  return {};
}

function getStartupHint(paths) {
  const logs = `${readTextTail(paths.stdoutLog)}\n${readTextTail(paths.stderrLog)}`;
  if (/Loading ONNX embedding model/i.test(logs)) {
    return (
      "The cold start was waiting for the ONNX embedding model. Check HuggingFace access, a configured mirror, " +
      "or a local Qdrant/all-MiniLM-L6-v2-onnx cache; the proxy may otherwise continue with degraded semantic memory."
    );
  }
  return "";
}

function readTextTail(file, maxBytes = 128 * 1024) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
    } finally {
      fs.closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function normalizeUrl(value) {
  return String(value || "").replace(/\/+$/, "").toLowerCase();
}

async function waitForPortFree(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(host, port)) {
      return true;
    }
    await delay(100);
  }
  return false;
}

function handleStartFailure(config, paths, error) {
  if (config.mode === "required") {
    throw error;
  }
  return sanitizeHeadroomReport({
    enabled: false,
    status: "fallback-direct",
    reason: "headroom-start-failed",
    workspaceId: paths.workspaceId,
    memoryScope: "project",
    error: error.message
  });
}

function handleAutoInstallFailure(config, paths, error) {
  const wrapped = new Error(`Automatic Headroom installation failed: ${error.message}`);
  if (config.mode === "required") {
    throw wrapped;
  }
  return sanitizeHeadroomReport({
    enabled: false,
    status: "fallback-direct",
    reason: "headroom-auto-install-failed",
    workspaceId: paths.workspaceId,
    memoryScope: "project",
    autoInstall: config.autoInstall,
    packageSpec: config.packageSpec,
    error: wrapped.message
  });
}

function clearStaleInstallLock(lockPath) {
  const lock = readJson(lockPath);
  if (lock?.pid && isProcessAlive(lock.pid)) {
    return false;
  }
  if (!lock?.pid) {
    try {
      const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (ageMs < 5000) {
        return false;
      }
    } catch {
      return true;
    }
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function emitInstallEvent(options, event) {
  if (typeof options.onInstallEvent === "function") {
    options.onInstallEvent(event);
  }
}

function tryKill(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(Number(pid));
    return true;
  } catch {
    return false;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function firstNumber(payload, paths) {
  for (const keys of paths) {
    let value = payload;
    for (const key of keys) {
      value = value?.[key];
    }
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }
  return 0;
}

function nonNegativeDelta(before, after) {
  return Math.max(0, Number(after || 0) - Number(before || 0));
}

function redactSecrets(value) {
  return String(value)
    .replace(/\b(?:sk|plus)-[A-Za-z0-9_-]{6,}\b/gi, "[redacted]")
    .replace(/\b(?:api[_ -]?key|auth[_ -]?token|subscription[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function sanitizeSegment(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
