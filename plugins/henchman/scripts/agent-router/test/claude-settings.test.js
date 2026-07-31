import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveMiniMaxConnection } from "../src/claude-settings.js";

describe("resolveMiniMaxConnection", () => {
  it("reuses a trusted loopback Claude gateway without exposing its token", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "http://127.0.0.1:15721",
          ANTHROPIC_AUTH_TOKEN: "local-token"
        }
      }),
      "utf8"
    );

    const connection = resolveMiniMaxConnection({
      env: { CLAUDE_CONFIG_DIR: configDir },
      miniMaxKey: "subscription-key",
      configuredBaseUrl: "https://api.minimax.io/anthropic"
    });

    assert.equal(connection.baseUrl, "http://127.0.0.1:15721");
    assert.equal(connection.authToken, "local-token");
    assert.equal(connection.source, "claude-user-settings");
    assert.doesNotMatch(JSON.stringify(connection.report), /local-token|subscription-key/);
  });

  it("ignores unrelated remote Claude providers", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-settings-"));
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
          ANTHROPIC_AUTH_TOKEN: "other-token"
        }
      }),
      "utf8"
    );

    const connection = resolveMiniMaxConnection({
      env: { CLAUDE_CONFIG_DIR: configDir },
      miniMaxKey: "subscription-key",
      configuredBaseUrl: "https://api.minimax.io/anthropic"
    });

    assert.equal(connection.baseUrl, "https://api.minimax.io/anthropic");
    assert.equal(connection.authToken, "subscription-key");
    assert.equal(connection.source, "router-config");
  });

  it("gives explicit wrapper environment settings highest priority", () => {
    const connection = resolveMiniMaxConnection({
      env: {
        CLAUDE_MINIMAX_BASE_URL: "https://api.minimax.io/anthropic",
        CLAUDE_MINIMAX_AUTH_TOKEN: "explicit-token"
      },
      miniMaxKey: "subscription-key",
      configuredBaseUrl: "http://127.0.0.1:15721"
    });

    assert.equal(connection.authToken, "explicit-token");
    assert.equal(connection.source, "explicit-env");
  });
});
