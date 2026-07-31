import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderDashboardHtml } from "../src/monitor.js";

describe("renderDashboardHtml", () => {
  it("renders totals and recent runs", () => {
    const html = renderDashboardHtml({
      summary: {
        totalRuns: 2,
        okRuns: 1,
        errorRuns: 1,
        totalDurationMs: 1234,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalEstimatedCost: 0.0123,
        byAgent: {
          pi: { runs: 1, status: { ok: 1, error: 0 }, durationMs: 1000, inputTokens: 100, outputTokens: 50, estimatedCost: 0.0123, byThink: { low: 1 } }
        },
        byModel: {},
        lastRun: null
      },
      runs: [
        {
          startedAt: "2026-07-28T01:00:00.000Z",
          status: "ok",
          agent: "pi",
          model: "mini",
          think: "low",
          durationMs: 1234,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCost: 0.0123
        }
      ],
      config: {
        quotas: {
          pi: { monthlyCalls: 10, monthlyTokens: 1000, monthlyBudgetUsd: 1 }
        }
      },
      configPath: "agent-router.config.json",
      logPath: ".agent-router/runs.jsonl"
    });

    assert.match(html, /Agent 路由监控台/);
    assert.match(html, /总调用数/);
    assert.match(html, /2/);
    assert.match(html, /pi/);
    assert.match(html, /mini/);
    assert.match(html, /额度/);
    assert.match(html, /月调用上限/);
    assert.match(html, /月 Token 上限/);
    assert.match(html, /10\.0%/);
    assert.match(html, /15\.0%/);
    assert.match(html, /agent-router\.config\.json/);
    assert.doesNotMatch(html, /Total Runs/);
    assert.doesNotMatch(html, /Recent Runs/);
  });
});
