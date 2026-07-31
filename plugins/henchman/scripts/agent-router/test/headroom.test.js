import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  buildHeadroomProxyArgs,
  buildProxyEnvironment,
  diffHeadroomStats,
  ensureHeadroomProxy,
  ensureHeadroomRuntime,
  extractHeadroomStats,
  getHeadroomStatus,
  getWorkspaceIdentity,
  normalizeHeadroomConfig,
  preloadHeadroomOnnxModel,
  resolveProxyPid,
  resolveHeadroomPaths,
  sanitizeHeadroomReport,
  stopHeadroomProxy
} from "../src/headroom.js";

describe("Headroom workspace isolation", () => {
  it("uses stable, distinct state directories for different projects", () => {
    const stateRoot = path.join(os.tmpdir(), "agent-router-headroom-state");
    const first = resolveHeadroomPaths("C:\\work\\alpha", { stateRoot });
    const firstAgain = resolveHeadroomPaths("c:\\WORK\\alpha\\", { stateRoot });
    const second = resolveHeadroomPaths("C:\\work\\beta", { stateRoot });

    assert.equal(first.workspaceId, firstAgain.workspaceId);
    assert.equal(first.projectStateDir, firstAgain.projectStateDir);
    assert.notEqual(first.workspaceId, second.workspaceId);
    assert.notEqual(first.memoryDbPath, second.memoryDbPath);
    assert.ok(first.memoryDbPath.startsWith(stateRoot));
  });

  it("builds a loopback-only MiniMax proxy with project memory and a small recall budget", () => {
    const paths = resolveHeadroomPaths("C:\\work\\alpha", {
      stateRoot: path.join(os.tmpdir(), "agent-router-headroom-state")
    });
    const args = buildHeadroomProxyArgs(paths, {
      host: "127.0.0.1",
      port: 18888,
      upstreamUrl: "https://api.minimax.io/anthropic",
      memoryTopK: 3,
      savingsProfile: "coding"
    });

    assert.deepEqual(args.slice(0, 2), ["proxy", "--host"]);
    assert.ok(args.includes("127.0.0.1"));
    assert.ok(args.includes("https://api.minimax.io/anthropic"));
    assert.ok(args.includes("--memory"));
    assert.ok(args.includes("--memory-storage"));
    assert.ok(args.includes("project"));
    assert.ok(args.includes("--memory-project-root"));
    assert.ok(args.includes(paths.workspaceRoot));
    assert.ok(args.includes("--memory-db-path"));
    assert.ok(args.includes(paths.memoryDbPath));
    assert.ok(args.includes("--memory-top-k"));
    assert.ok(args.includes("3"));
    assert.equal(args.includes("--learn"), false);
  });

  it("normalizes Windows workspace identities without changing project boundaries", () => {
    const first = getWorkspaceIdentity("E:\\Repo\\Demo\\");
    const second = getWorkspaceIdentity("e:\\repo\\demo");
    const other = getWorkspaceIdentity("E:\\Repo\\Other");

    assert.equal(first.id, second.id);
    assert.notEqual(first.id, other.id);
  });

  it("rejects global memory and non-loopback proxy binding", () => {
    assert.throws(() => normalizeHeadroomConfig({ memoryStorage: "global" }), /project memory/i);
    assert.throws(() => normalizeHeadroomConfig({ host: "0.0.0.0" }), /loopback/i);
  });

  it("enables pinned Headroom auto-install by default and allows an environment opt-out", () => {
    const defaults = normalizeHeadroomConfig({});
    assert.equal(defaults.autoInstall, true);
    assert.equal(defaults.startupTimeoutMs, 300000);
    assert.equal(
      normalizeHeadroomConfig({}, { AGENT_ROUTER_HEADROOM_AUTO_INSTALL: "false" }).autoInstall,
      false
    );
  });

  it("disables Anthropic-only tool search for MiniMax-compatible gateways", () => {
    const workspace = "C:\\work\\alpha";
    const config = normalizeHeadroomConfig({
      stateRoot: path.join(os.tmpdir(), "agent-router-headroom-state")
    });
    const paths = resolveHeadroomPaths(workspace, config);
    const env = buildProxyEnvironment(config, paths, {
      MINIMAX_API_KEY: "secret",
      HEADROOM_TOOL_SEARCH: "1"
    });

    assert.equal(env.HEADROOM_TOOL_SEARCH, "0");
    assert.equal(env.MINIMAX_API_KEY, undefined);
    assert.equal(env.PYTHONIOENCODING, "utf-8");
    assert.equal(env.PYTHONUTF8, "1");
  });
});

describe("Headroom reporting", () => {
  it("reports an installed stopped runtime as runnable and explains on-demand startup", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-runnable-status-"));
    const status = await getHeadroomStatus(workspace, {
      command: process.execPath,
      stateRoot: path.join(workspace, "state")
    });

    assert.equal(status.installed, true);
    assert.equal(status.runnable, true);
    assert.equal(status.status, "stopped");
    assert.equal(status.startsOnDemand, true);
    assert.match(status.note, /starts on demand/i);
  });

  it("reports non-fatal embedding warm-up failures as degraded memory", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-memory-degraded-"));
    const config = {
      command: process.execPath,
      stateRoot: path.join(workspace, "state")
    };
    const paths = resolveHeadroomPaths(workspace, config);
    fs.mkdirSync(paths.projectStateDir, { recursive: true });
    fs.writeFileSync(
      paths.stderrLog,
      "Memory: embedder warm-up failed (non-fatal)\nMemory: ENABLED\n",
      "utf8"
    );

    const status = await getHeadroomStatus(workspace, config);

    assert.equal(status.runnable, true);
    assert.equal(status.memoryStatus, "degraded");
    assert.match(status.memoryNote, /proxy remains usable/i);
  });

  it("prefers the actual proxy PID reported by Headroom health", () => {
    assert.equal(resolveProxyPid({ config: { pid: 5432 } }, 1234), 5432);
    assert.equal(resolveProxyPid({ status: "healthy" }, 1234), 1234);
  });

  it("calculates per-run token savings from proxy snapshots", () => {
    const delta = diffHeadroomStats(
      { requests: 10, inputTokens: 1000, tokensSaved: 250 },
      { requests: 12, inputTokens: 1300, tokensSaved: 340 }
    );

    assert.deepEqual(delta, {
      requests: 2,
      inputTokens: 300,
      tokensSaved: 90,
      savingsPercent: 23.08
    });
  });

  it("reads request totals from the current Headroom stats shape", () => {
    assert.deepEqual(
      extractHeadroomStats({
        requests: { total: 7 },
        tokens: { input: 1200, saved: 300 }
      }),
      { requests: 7, inputTokens: 1200, tokensSaved: 300 }
    );
  });

  it("reads lightweight persistent counters from Headroom stats history", () => {
    assert.deepEqual(
      extractHeadroomStats({
        lifetime: { requests: 9, total_input_tokens: 2400, tokens_saved: 600 }
      }),
      { requests: 9, inputTokens: 2400, tokensSaved: 600 }
    );
  });

  it("never includes credentials or raw environment values in reports", () => {
    const report = sanitizeHeadroomReport({
      status: "enabled",
      baseUrl: "http://127.0.0.1:18888",
      workspaceId: "demo-123",
      memoryDbPath: "C:\\state\\memory.db",
      env: { MINIMAX_API_KEY: "secret-key" },
      apiKey: "secret-key",
      error: "request failed with sk-secret-value"
    });
    const serialized = JSON.stringify(report);

    assert.equal("env" in report, false);
    assert.equal("apiKey" in report, false);
    assert.doesNotMatch(serialized, /secret-key|sk-secret-value/);
    assert.match(report.error, /\[redacted\]/);
  });

  it("explains zero savings as normal for small or cache-oriented tasks", () => {
    const report = sanitizeHeadroomReport({
      enabled: true,
      status: "started",
      requests: 2,
      inputTokens: 300,
      tokensSaved: 0,
      savingsPercent: 0
    });

    assert.equal(report.tokensSaved, 0);
    assert.match(report.interpretation, /zero savings does not mean Headroom failed/i);
  });

  it("treats ONNX model preload failures as degraded memory instead of install failure", () => {
    const result = preloadHeadroomOnnxModel(process.execPath, {}, {
      spawnSync: () => ({ status: 1, stderr: "HuggingFace connection timed out" })
    });

    assert.equal(result.status, "degraded");
    assert.match(result.note, /proxy is usable/i);
    assert.match(result.error, /HuggingFace connection timed out/i);
  });

  it("allows ONNX model preload to be disabled", () => {
    const result = preloadHeadroomOnnxModel(process.execPath, { preloadOnnxModel: false }, {
      spawnSync: () => {
        throw new Error("should not run");
      }
    });

    assert.equal(result.status, "skipped");
  });
});

describe("Headroom proxy lifecycle", () => {
  it("explains ONNX memory warm-up when a cold start times out", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-onnx-timeout-"));
    const script = path.join(workspace, "slow-headroom.cjs");
    fs.writeFileSync(
      script,
      "process.stderr.write('Loading ONNX embedding model (all-MiniLM-L6-v2, ~86MB)...\\n'); setInterval(() => {}, 1000);",
      "utf8"
    );

    const result = await ensureHeadroomProxy(workspace, {
      mode: "auto",
      autoInstall: false,
      command: process.execPath,
      commandArgs: [script],
      stateRoot: path.join(workspace, "state"),
      startupTimeoutMs: 100,
      portRangeStart: 22100,
      portRangeSize: 20
    });

    assert.equal(result.status, "fallback-direct");
    assert.equal(result.reason, "headroom-start-failed");
    assert.match(result.error, /ONNX embedding model/i);
    assert.match(result.error, /HuggingFace/i);
  });

  it("auto-installs Headroom only once across concurrent first-use callers", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-auto-install-"));
    const config = {
      autoInstall: true,
      stateRoot: path.join(workspace, "state"),
      installWaitMs: 5000
    };
    let installed = false;
    let installActive = false;
    let installCalls = 0;
    let returnsDuringInstall = 0;
    const events = [];
    const options = {
      onInstallEvent: (event) => events.push(event.status),
      resolveCommand: () => (installed ? process.execPath : null),
      installHeadroom: async () => {
        installCalls += 1;
        installActive = true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        installed = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        installActive = false;
        return { status: "installed" };
      }
    };

    const observeReturn = (promise) =>
      promise.then((result) => {
        if (installActive) {
          returnsDuringInstall += 1;
        }
        return result;
      });
    const [first, second] = await Promise.all([
      observeReturn(ensureHeadroomRuntime(workspace, config, options)),
      observeReturn(ensureHeadroomRuntime(workspace, config, options))
    ]);

    assert.equal(installCalls, 1);
    assert.equal(returnsDuringInstall, 0);
    assert.equal(first.command, process.execPath);
    assert.equal(second.command, process.execPath);
    assert.equal(first.autoInstalled, true);
    assert.equal(second.autoInstalled, true);
    assert.ok(events.includes("installing"));
    assert.ok(events.includes("waiting"));
    assert.ok(events.includes("installed"));
  });

  it("falls back in auto mode and fails closed in required mode when automatic installation fails", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-auto-install-failure-"));
    const config = {
      autoInstall: true,
      command: path.join(workspace, "missing-headroom.exe"),
      stateRoot: path.join(workspace, "state"),
      installWaitMs: 500
    };
    const options = {
      resolveCommand: () => null,
      installHeadroom: async () => {
        throw new Error("python unavailable");
      }
    };

    const automatic = await ensureHeadroomProxy(workspace, { ...config, mode: "auto" }, options);
    assert.equal(automatic.status, "fallback-direct");
    assert.equal(automatic.reason, "headroom-auto-install-failed");
    assert.match(automatic.error, /python unavailable/i);

    await assert.rejects(
      ensureHeadroomProxy(workspace, { ...config, mode: "required" }, options),
      /automatic Headroom installation failed.*python unavailable/i
    );
  });

  it("fails open in auto mode and fails closed in required mode when Headroom is missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-missing-"));
    const config = {
      autoInstall: false,
      command: path.join(workspace, "missing-headroom.exe"),
      stateRoot: path.join(workspace, "state"),
      startupTimeoutMs: 100
    };

    const automatic = await ensureHeadroomProxy(workspace, { ...config, mode: "auto" });
    assert.equal(automatic.status, "fallback-direct");
    assert.equal(automatic.enabled, false);

    await assert.rejects(
      ensureHeadroomProxy(workspace, { ...config, mode: "required" }),
      /Headroom.*not available/i
    );
  });

  it("starts and reuses one project-specific proxy", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-proxy-"));
    const stateRoot = path.join(workspace, "state");
    const fakeProxy = path.join(workspace, "fake-headroom.js");
    fs.writeFileSync(
      fakeProxy,
      [
        "const http = require('node:http');",
        "const args = process.argv.slice(2);",
        "const port = Number(args[args.indexOf('--port') + 1]);",
        "const upstream = args[args.indexOf('--anthropic-api-url') + 1];",
        "const server = http.createServer((req, res) => {",
        "  res.setHeader('content-type', 'application/json');",
        "  if (req.url === '/health') return res.end(JSON.stringify({ status: 'healthy', config: { anthropic_api_url: upstream } }));",
        "  if (req.url === '/stats') return res.end(JSON.stringify({ stats: { total_requests: 2, tokens_input: 100, tokens_saved: 25 } }));",
        "  res.statusCode = 404; res.end('{}');",
        "});",
        "server.listen(port, '127.0.0.1');"
      ].join("\n"),
      "utf8"
    );

    const config = {
      mode: "required",
      command: process.execPath,
      commandArgs: [fakeProxy],
      stateRoot,
      startupTimeoutMs: 5000,
      portRangeStart: 19900,
      portRangeSize: 100
    };

    const first = await ensureHeadroomProxy(workspace, config);
    const second = await ensureHeadroomProxy(workspace, config);

    assert.equal(first.enabled, true);
    assert.equal(first.status, "started");
    assert.equal(second.enabled, true);
    assert.equal(second.status, "reused");
    assert.equal(first.port, second.port);
    assert.equal(first.workspaceId, second.workspaceId);
    assert.equal(first.memoryScope, "project");

    const stopped = await stopHeadroomProxy(workspace, config);
    assert.equal(stopped.status, "stopped");
  });

  it("restarts a managed proxy when its reported upstream does not match", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "headroom-upstream-"));
    const fakeProxy = path.join(workspace, "fake-headroom.cjs");
    fs.writeFileSync(
      fakeProxy,
      [
        "const http = require('node:http');",
        "const args = process.argv.slice(2);",
        "const port = Number(args[args.indexOf('--port') + 1]);",
        "const upstream = args[args.indexOf('--anthropic-api-url') + 1];",
        "http.createServer((req, res) => {",
        "  res.setHeader('content-type', 'application/json');",
        "  if (req.url === '/health') return res.end(JSON.stringify({ status: 'healthy', config: { anthropic_api_url: upstream, pid: process.pid } }));",
        "  if (req.url === '/stats') return res.end('{}');",
        "  res.statusCode = 404; res.end('{}');",
        "}).listen(port, '127.0.0.1');"
      ].join("\n"),
      "utf8"
    );
    const baseConfig = {
      mode: "required",
      command: process.execPath,
      commandArgs: [fakeProxy],
      stateRoot: path.join(workspace, "state"),
      startupTimeoutMs: 5000,
      portRangeStart: 20500,
      portRangeSize: 100
    };

    const first = await ensureHeadroomProxy(workspace, {
      ...baseConfig,
      upstreamUrl: "https://api.minimax.io/anthropic"
    });
    const second = await ensureHeadroomProxy(workspace, {
      ...baseConfig,
      upstreamUrl: "http://127.0.0.1:15721"
    });

    assert.equal(first.status, "started");
    assert.equal(second.status, "started");
    assert.notEqual(second.pid, first.pid);
    await stopHeadroomProxy(workspace, baseConfig);
  });
});
