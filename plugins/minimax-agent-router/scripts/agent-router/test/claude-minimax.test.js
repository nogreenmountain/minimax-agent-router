import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { stopHeadroomProxy } from "../src/headroom.js";

const wrapperPath = path.resolve("src/claude-minimax.js");

describe("claude-minimax wrapper", () => {
  it("maps MiniMax credentials into Claude Code Anthropic-compatible env vars", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-minimax-"));
    const fakeClaudePath = path.join(tmpDir, "fake-claude.js");
    fs.writeFileSync(
      fakeClaudePath,
      [
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({",
        "    args: process.argv.slice(2),",
        "    input,",
        "    env: {",
        "      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,",
        "      ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,",
        "      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,",
        "      ANTHROPIC_SMALL_FAST_MODEL: process.env.ANTHROPIC_SMALL_FAST_MODEL",
        "    }",
        "  }));",
        "});"
      ].join("\n"),
      "utf8"
    );

    const result = spawnSync(
      process.execPath,
      [wrapperPath, "--model", "MiniMax-M3[1m]", "--think", "medium"],
      {
        cwd: tmpDir,
        input: "请修改登录组件",
        encoding: "utf8",
        env: {
          ...process.env,
          MINIMAX_API_KEY: "minimax-test-key",
          CLAUDE_CONFIG_DIR: path.join(tmpDir, "claude-config"),
          AGENT_ROUTER_HEADROOM_MODE: "off",
          CLAUDE_MINIMAX_CLI: process.execPath,
          CLAUDE_MINIMAX_CLI_ARGS: JSON.stringify([fakeClaudePath])
        },
        windowsHide: true
      }
    );

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(payload.args, [
      "-p",
      "--model",
      "MiniMax-M3[1m]",
      "--effort",
      "medium",
      "--permission-mode",
      "acceptEdits"
    ]);
    assert.equal(payload.input, "请修改登录组件");
    assert.equal(payload.env.ANTHROPIC_BASE_URL, "https://api.minimax.io/anthropic");
    assert.equal(payload.env.ANTHROPIC_AUTH_TOKEN, "minimax-test-key");
    assert.equal(payload.env.ANTHROPIC_MODEL, "MiniMax-M3[1m]");
    assert.equal(payload.env.ANTHROPIC_SMALL_FAST_MODEL, "MiniMax-M3[1m]");
  });

  it("routes Claude through Headroom and writes a secret-free sidecar report", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-minimax-headroom-"));
    const fakeClaudePath = path.join(tmpDir, "fake-claude.js");
    const fakeHeadroomPath = path.join(tmpDir, "fake-headroom.cjs");
    const reportPath = path.join(tmpDir, "headroom-report.json");
    fs.writeFileSync(
      fakeClaudePath,
      [
        "const fs = require('node:fs');",
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => {",
        "  const args = process.argv.slice(2);",
        "  const settingsPath = args[args.indexOf('--settings') + 1];",
        "  const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : null;",
        "  process.stdout.write(JSON.stringify({ baseUrl: process.env.ANTHROPIC_BASE_URL, input, args, settings }));",
        "});"
      ].join("\n"),
      "utf8"
    );
    fs.writeFileSync(
      fakeHeadroomPath,
      [
        "const http = require('node:http');",
        "const args = process.argv.slice(2);",
        "const port = Number(args[args.indexOf('--port') + 1]);",
        "let calls = 0;",
        "http.createServer((req, res) => {",
        "  res.setHeader('content-type', 'application/json');",
        "  if (req.url === '/health') return res.end(JSON.stringify({ status: 'healthy' }));",
        "  if (req.url === '/stats') { calls += 1; return res.end(JSON.stringify({ stats: { total_requests: calls, tokens_input: calls * 100, tokens_saved: calls * 25 } })); }",
        "  res.statusCode = 404; res.end('{}');",
        "}).listen(port, '127.0.0.1');"
      ].join("\n"),
      "utf8"
    );
    const headroomConfig = {
      mode: "required",
      command: process.execPath,
      commandArgs: [fakeHeadroomPath],
      stateRoot: path.join(tmpDir, "state"),
      startupTimeoutMs: 5000,
      portRangeStart: 20100,
      portRangeSize: 100
    };

    const result = spawnSync(process.execPath, [wrapperPath, "--model", "MiniMax-M3[1m]"], {
      cwd: tmpDir,
      input: "Inspect the parser.",
      encoding: "utf8",
      env: {
        ...process.env,
        MINIMAX_API_KEY: "minimax-test-key",
        CLAUDE_CONFIG_DIR: path.join(tmpDir, "claude-config"),
        CLAUDE_MINIMAX_CLI: process.execPath,
        CLAUDE_MINIMAX_CLI_ARGS: JSON.stringify([fakeClaudePath]),
        AGENT_ROUTER_HEADROOM_CONFIG: JSON.stringify(headroomConfig),
        AGENT_ROUTER_HEADROOM_REPORT_PATH: reportPath
      },
      windowsHide: true,
      timeout: 10000
    });

    try {
      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.match(payload.baseUrl, /^http:\/\/127\.0\.0\.1:/);
      assert.match(payload.input, /Project memory is enabled/);
      assert.match(payload.input, /UNVERIFIED_WORKER/);
      assert.ok(payload.args.includes("--settings"));
      assert.equal(payload.settings.env.ANTHROPIC_BASE_URL, payload.baseUrl);
      assert.equal(payload.settings.env.ANTHROPIC_AUTH_TOKEN, "minimax-test-key");
      assert.doesNotMatch(JSON.stringify(payload.args), /minimax-test-key/);

      const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      assert.equal(report.enabled, true);
      assert.equal(report.memoryScope, "project");
      assert.equal(report.tokensSaved, 25);
      assert.doesNotMatch(JSON.stringify(report), /minimax-test-key/);
    } finally {
      await stopHeadroomProxy(tmpDir, headroomConfig);
    }
  });

  if (process.platform === "win32") {
    it("runs a Windows .cmd Claude shim through cmd.exe", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-minimax-cmd-"));
      const fakeClaudePath = path.join(tmpDir, "fake-claude.js");
      const fakeCmdPath = path.join(tmpDir, "fake-claude.cmd");
      fs.writeFileSync(
        fakeClaudePath,
        [
          "process.stdin.setEncoding('utf8');",
          "let input = '';",
          "process.stdin.on('data', chunk => input += chunk);",
          "process.stdin.on('end', () => {",
          "  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }));",
          "});"
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(fakeCmdPath, "@echo off\r\nnode \"%~dp0fake-claude.js\" %*\r\n", "utf8");

      const result = spawnSync(process.execPath, [wrapperPath, "--model", "MiniMax-M3[1m]", "--think", "low"], {
        cwd: tmpDir,
        input: "请只回复 OK",
        encoding: "utf8",
        env: {
          ...process.env,
          MINIMAX_API_KEY: "minimax-test-key",
          AGENT_ROUTER_HEADROOM_MODE: "off",
          CLAUDE_MINIMAX_CLI: fakeCmdPath
        },
        windowsHide: true
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.deepEqual(payload.args, [
        "-p",
        "--model",
        "MiniMax-M3[1m]",
        "--effort",
        "low",
        "--permission-mode",
        "acceptEdits"
      ]);
      assert.equal(payload.input, "请只回复 OK");
    });
  }

  it("fails clearly when no MiniMax key is configured", () => {
    const result = spawnSync(process.execPath, [wrapperPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || ""
      },
      windowsHide: true
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /MINIMAX_API_KEY/);
  });

  it("does not treat an existing Anthropic token as a MiniMax token by default", () => {
    const result = spawnSync(process.execPath, [wrapperPath], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH || "",
        SystemRoot: process.env.SystemRoot || "",
        ANTHROPIC_AUTH_TOKEN: "anthropic-token"
      },
      windowsHide: true
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /MINIMAX_API_KEY/);
  });
});
