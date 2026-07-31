import http from "node:http";

import { loadRuns, summarizeRuns } from "./router.js";

export function createMonitorServer({ config, configPath, logPath }) {
  return http.createServer((request, response) => {
    try {
      const runs = loadRuns(logPath);
      const summary = summarizeRuns(runs);

      if (request.url === "/api/summary") {
        send(response, 200, "application/json", JSON.stringify({ summary, runs }, null, 2));
        return;
      }

      if (request.url === "/health") {
        send(response, 200, "application/json", JSON.stringify({ ok: true }));
        return;
      }

      send(
        response,
        200,
        "text/html; charset=utf-8",
        renderDashboardHtml({
          summary,
          runs: runs.slice(-50).reverse(),
          config,
          configPath,
          logPath
        })
      );
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", error.stack || error.message);
    }
  });
}

export function renderDashboardHtml({ summary, runs, config, configPath, logPath }) {
  const agentRows = Object.entries(summary.byAgent || {})
    .map(([agent, bucket]) => {
      const think = Object.entries(bucket.byThink || {})
        .map(([key, value]) => `${escapeHtml(key)}:${value}`)
        .join(" ");
      return `<tr><td>${escapeHtml(agent)}</td><td>${bucket.runs}</td><td>${bucket.status.ok}</td><td>${bucket.status.error}</td><td>${formatDuration(bucket.durationMs)}</td><td>${bucket.inputTokens}</td><td>${bucket.outputTokens}</td><td>${formatMoney(bucket.estimatedCost)}</td><td>${think}</td></tr>`;
    })
    .join("");

  const runRows = runs
    .map(
      (run) =>
        `<tr><td>${escapeHtml(run.startedAt || "")}</td><td><span class="status ${escapeHtml(run.status || "error")}">${escapeHtml(formatStatus(run.status))}</span></td><td>${escapeHtml(run.agent || "")}</td><td>${escapeHtml(run.model || "")}</td><td>${escapeHtml(run.think || "")}</td><td>${formatDuration(run.durationMs || 0)}</td><td>${run.inputTokens || 0}</td><td>${run.outputTokens || 0}</td><td>${formatMoney(run.estimatedCost || 0)}</td></tr>`
    )
    .join("");
  const quotaRows = Object.entries(config?.quotas || {})
    .map(([agent, quota]) => {
      const bucket = summary.byAgent?.[agent] || {
        runs: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0
      };
      const usedTokens = Number(bucket.inputTokens || 0) + Number(bucket.outputTokens || 0);
      return `<tr><td>${escapeHtml(agent)}</td><td>${quota.monthlyCalls || ""}</td><td>${bucket.runs}</td><td>${formatPercent(bucket.runs, quota.monthlyCalls)}</td><td>${quota.monthlyTokens || ""}</td><td>${usedTokens}</td><td>${formatPercent(usedTokens, quota.monthlyTokens)}</td><td>${formatMoney(quota.monthlyBudgetUsd || 0)}</td><td>${formatMoney(bucket.estimatedCost || 0)}</td><td>${formatPercent(bucket.estimatedCost, quota.monthlyBudgetUsd)}</td></tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent 路由监控台</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1f2937;
      --muted: #64748b;
      --line: #d7dde8;
      --panel: #ffffff;
      --page: #f5f7fb;
      --ok: #0f766e;
      --err: #b42318;
      --accent: #2563eb;
      --accent-2: #c2410c;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--page);
    }
    header {
      padding: 24px 28px 14px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 24px;
      font-weight: 720;
      letter-spacing: 0;
    }
    .paths {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 13px;
    }
    main { padding: 22px 28px 36px; }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 22px;
    }
    .metric {
      min-height: 92px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: 0;
    }
    .value {
      margin-top: 10px;
      font-size: 26px;
      font-weight: 760;
    }
    section {
      margin-top: 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      overflow: hidden;
    }
    h2 {
      margin: 0;
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      font-size: 16px;
      letter-spacing: 0;
    }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      min-width: 820px;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid #eef1f6;
      text-align: left;
      white-space: nowrap;
    }
    th {
      color: var(--muted);
      font-weight: 650;
      background: #fbfcff;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-width: 48px;
      justify-content: center;
      border-radius: 999px;
      padding: 3px 8px;
      font-weight: 650;
      border: 1px solid currentColor;
    }
    .status.ok { color: var(--ok); }
    .status.error { color: var(--err); }
    .empty {
      color: var(--muted);
      padding: 18px 16px;
    }
    @media (max-width: 680px) {
      header, main { padding-left: 16px; padding-right: 16px; }
      .value { font-size: 22px; }
    }
  </style>
  <script>
    setTimeout(() => location.reload(), 10000);
  </script>
</head>
<body>
  <header>
    <h1>Agent 路由监控台</h1>
    <div class="paths">
      <span>配置：${escapeHtml(configPath)}</span>
      <span>日志：${escapeHtml(logPath)}</span>
    </div>
  </header>
  <main>
    <div class="metrics">
      ${metric("总调用数", summary.totalRuns)}
      ${metric("成功", summary.okRuns)}
      ${metric("失败", summary.errorRuns)}
      ${metric("总耗时", formatDuration(summary.totalDurationMs))}
      ${metric("输入 Token", summary.totalInputTokens)}
      ${metric("输出 Token", summary.totalOutputTokens)}
      ${metric("预估费用", formatMoney(summary.totalEstimatedCost))}
    </div>

    <section>
      <h2>Agent 明细</h2>
      ${
        agentRows
          ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>调用数</th><th>成功</th><th>失败</th><th>耗时</th><th>输入</th><th>输出</th><th>费用</th><th>思考强度</th></tr></thead><tbody>${agentRows}</tbody></table></div>`
          : `<div class="empty">还没有记录到 Agent 调用。</div>`
      }
    </section>

    ${
      quotaRows
        ? `<section>
      <h2>额度</h2>
      <div class="table-wrap"><table><thead><tr><th>Agent</th><th>月调用上限</th><th>已用调用</th><th>调用占比</th><th>月 Token 上限</th><th>已用 Token</th><th>Token 占比</th><th>月预算</th><th>已用预算</th><th>预算占比</th></tr></thead><tbody>${quotaRows}</tbody></table></div>
    </section>`
        : ""
    }

    <section>
      <h2>最近调用</h2>
      ${
        runRows
          ? `<div class="table-wrap"><table><thead><tr><th>开始时间</th><th>状态</th><th>Agent</th><th>模型</th><th>思考强度</th><th>耗时</th><th>输入</th><th>输出</th><th>费用</th></tr></thead><tbody>${runRows}</tbody></table></div>`
          : `<div class="empty">运行一次 Agent 任务后，这里会出现调用记录。</div>`
      }
    </section>
  </main>
</body>
</html>`;
}

function metric(label, value) {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div></div>`;
}

function send(response, statusCode, contentType, body) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  response.end(body);
}

function formatDuration(ms) {
  const value = Number(ms || 0);
  if (value < 1000) {
    return `${value} 毫秒`;
  }
  if (value < 60_000) {
    return `${(value / 1000).toFixed(1)} 秒`;
  }
  return `${(value / 60_000).toFixed(1)} 分钟`;
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function formatPercent(value, total) {
  if (!total) {
    return "未设置";
  }
  return `${((Number(value || 0) / Number(total)) * 100).toFixed(1)}%`;
}

function formatStatus(status) {
  if (status === "ok") {
    return "成功";
  }
  return "失败";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
