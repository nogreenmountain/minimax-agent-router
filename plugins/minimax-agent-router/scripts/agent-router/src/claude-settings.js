import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MINIMAX_BASE_URL = "https://api.minimax.io/anthropic";

export function resolveMiniMaxConnection({
  env = process.env,
  miniMaxKey,
  configuredBaseUrl = DEFAULT_MINIMAX_BASE_URL
} = {}) {
  const explicitBaseUrl = stringValue(env.CLAUDE_MINIMAX_BASE_URL);
  const explicitToken = stringValue(env.CLAUDE_MINIMAX_AUTH_TOKEN);
  if (explicitBaseUrl || explicitToken) {
    const baseUrl = explicitBaseUrl || configuredBaseUrl;
    return makeConnection(baseUrl, explicitToken || miniMaxKey, "explicit-env");
  }

  const settings = loadClaudeUserSettings(env);
  const settingsBaseUrl = stringValue(settings?.env?.ANTHROPIC_BASE_URL);
  const settingsToken = stringValue(
    settings?.env?.ANTHROPIC_AUTH_TOKEN || settings?.env?.ANTHROPIC_API_KEY
  );
  if (settingsBaseUrl && settingsToken && isTrustedMiniMaxUpstream(settingsBaseUrl)) {
    return makeConnection(settingsBaseUrl, settingsToken, "claude-user-settings");
  }

  return makeConnection(configuredBaseUrl || DEFAULT_MINIMAX_BASE_URL, miniMaxKey, "router-config");
}

export function loadClaudeUserSettings(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const settingsPath = path.join(configDir, "settings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function isTrustedMiniMaxUpstream(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "api.minimax.io" || hostname.endsWith(".minimax.io")) {
      return true;
    }
    if (hostname === "api.minimaxi.com" || hostname.endsWith(".minimaxi.com")) {
      return true;
    }
    if (["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      return port < 18787 || port >= 19787;
    }
  } catch {
    return false;
  }
  return false;
}

function makeConnection(baseUrl, authToken, source) {
  return {
    baseUrl,
    authToken,
    source,
    report: {
      upstreamUrl: baseUrl,
      upstreamSource: source
    }
  };
}

function stringValue(value) {
  const string = value === undefined || value === null ? "" : String(value).trim();
  return string || null;
}
