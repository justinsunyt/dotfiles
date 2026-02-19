#!/usr/bin/env bun
/**
 * Cost breakdown per model.
 *
 * Usage:
 *   bun costs.ts                          # since 7 days ago
 *   bun costs.ts --since 30d              # last 30 days
 *   bun costs.ts --since 2026-01-05       # since date
 *   bun costs.ts --cwd ~/Dev/scout        # filter by project
 *   bun costs.ts --daily                  # daily burn rate breakdown
 *   bun costs.ts --model opus              # filter to sessions using this model
 *   bun costs.ts --json                   # JSON output
 *   bun costs.ts --fancy                  # unicode/bars formatting
 */

import {
  loadSessions,
  summariseSession,
  formatCost,
  formatTokens,
  parseArgs,
  parseDateArg,
} from "./lib";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 7 * 86400000);
  const until = args.until ? parseDateArg(args.until as string) : undefined;
  const cwd = args.cwd as string | undefined;
  const daily = !!args.daily;
  const json = !!args.json;
  const fancy = !!args.fancy;

  const model = args.model as string | undefined;
  const sessions = await loadSessions({ cwd, since, until, model });
  const summaries = sessions.map(summariseSession);

  // Aggregate by model
  const modelStats = new Map<string, {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    sessions: number;
    messages: number;
  }>();

  for (const s of summaries) {
    for (const model of s.models) {
      const stats = modelStats.get(model) || { cost: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, sessions: 0, messages: 0 };
      stats.cost += s.totalCost / (s.models.length || 1);
      stats.inputTokens += s.inputTokens / (s.models.length || 1);
      stats.outputTokens += s.outputTokens / (s.models.length || 1);
      stats.cacheRead += s.cacheRead / (s.models.length || 1);
      stats.sessions++;
      stats.messages += s.messageCount;
      modelStats.set(model, stats);
    }
  }

  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86400000));
  const totalCost = summaries.reduce((s, x) => s + x.totalCost, 0);

  if (json) {
    console.log(JSON.stringify({
      since: since.toISOString(),
      days,
      totalCost,
      dailyAvg: totalCost / days,
      sessions: summaries.length,
      models: Object.fromEntries(modelStats),
    }, null, 2));
    return;
  }

  const sep = fancy ? "─" : "-";

  console.log(`\nCost Report -- ${since.toLocaleDateString()} to today (${days} days)`);
  if (cwd) console.log(`Filtered to: ${cwd}`);
  console.log(`${summaries.length} sessions\n`);

  const header = `${"Model".padEnd(42)} ${"Cost".padStart(10)} ${"Sessions".padStart(9)} ${"In Tokens".padStart(12)} ${"Out Tokens".padStart(12)} ${"Cache Read".padStart(12)}`;
  console.log(header);
  console.log(sep.repeat(header.length));

  const sorted = [...modelStats.entries()].sort((a, b) => b[1].cost - a[1].cost);
  for (const [model, stats] of sorted) {
    if (stats.cost < 0.001 && stats.messages === 0) continue;
    console.log(
      `${model.padEnd(42)} ${formatCost(stats.cost).padStart(10)} ${String(stats.sessions).padStart(9)} ${formatTokens(Math.round(stats.inputTokens)).padStart(12)} ${formatTokens(Math.round(stats.outputTokens)).padStart(12)} ${formatTokens(Math.round(stats.cacheRead)).padStart(12)}`
    );
  }

  console.log(sep.repeat(header.length));
  console.log(`${"TOTAL".padEnd(42)} ${formatCost(totalCost).padStart(10)}`);
  console.log(`\nDaily average: ${formatCost(totalCost / days)}/day\n`);

  // Daily breakdown
  if (daily) {
    console.log(fancy ? "-- Daily Breakdown --\n" : "Daily Breakdown\n");
    const dayBuckets = new Map<string, number>();
    for (const s of summaries) {
      const day = s.startTime.toISOString().slice(0, 10);
      dayBuckets.set(day, (dayBuckets.get(day) || 0) + s.totalCost);
    }
    const sortedDays = [...dayBuckets.entries()].sort();
    for (const [day, cost] of sortedDays) {
      if (fancy) {
        const bar = "#".repeat(Math.max(1, Math.round(cost / 5)));
        console.log(`${day}  ${formatCost(cost).padStart(8)}  ${bar}`);
      } else {
        console.log(`${day}  ${formatCost(cost).padStart(8)}`);
      }
    }
    console.log();
  }
}

main().catch(console.error);
