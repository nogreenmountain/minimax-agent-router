import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

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
