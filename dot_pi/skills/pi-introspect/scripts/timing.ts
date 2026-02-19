#!/usr/bin/env bun
/**
 * Time analysis -- where does time go across sessions?
 *
 * Usage:
 *   bun timing.ts                          # last 7d
 *   bun timing.ts --since 30d              # last 30 days
 *   bun timing.ts --cwd ~/Dev/scout        # filter by project
 *   bun timing.ts --hourly                 # by hour of day
 *   bun timing.ts --tools                  # tool call frequency
 *   bun timing.ts --fancy                  # unicode/bar formatting
 */

import {
  loadSessions,
  summariseSession,
  formatDuration,
  formatTokens,
  formatCost,
  parseArgs,
  parseDateArg,
  type SessionSummary,
} from "./lib";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 7 * 86400000);
  const cwd = args.cwd as string | undefined;
  const hourly = !!args.hourly;
  const tools = !!args.tools;
  const fancy = !!args.fancy;

  const model = args.model as string | undefined;
  const sessions = await loadSessions({ cwd, since, model });
  const summaries = sessions.map(summariseSession);

  const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86400000));
  const sep = fancy ? "─" : "-";

  let totalWallClock = 0;
  let totalActive = 0;

  const toolCounts = new Map<string, number>();
  const cwdCounts = new Map<string, { sessions: number; cost: number; duration: number }>();

  for (const s of summaries) {
    totalWallClock += s.durationMs;
    const estimatedActive = Math.min(s.durationMs, s.messageCount * 60000);
    totalActive += estimatedActive;

    for (const tc of s.toolCalls) {
      toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
    }

    const key = s.cwd;
    const existing = cwdCounts.get(key) || { sessions: 0, cost: 0, duration: 0 };
    existing.sessions++;
    existing.cost += s.totalCost;
    existing.duration += s.durationMs;
    cwdCounts.set(key, existing);
  }

  console.log(`\nTime Analysis -- ${since.toLocaleDateString()} to today (${days} days)\n`);
  console.log(`Sessions:        ${summaries.length}`);
  console.log(`Wall clock:      ${formatDuration(totalWallClock)}`);
  console.log(`Est. active:     ${formatDuration(totalActive)}`);
  console.log(`Avg per session: ${formatDuration(summaries.length > 0 ? totalWallClock / summaries.length : 0)}`);

  // By project
  console.log(`\nBy Project\n`);
  const sortedCwd = [...cwdCounts.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const projHeader = `${"Project".padEnd(50)} ${"Sessions".padStart(9)} ${"Cost".padStart(10)} ${"Duration".padStart(10)}`;
  console.log(projHeader);
  console.log(sep.repeat(projHeader.length));
  for (const [path, data] of sortedCwd.slice(0, 15)) {
    const short = path.replace(/^\/Users\/\w+\//, "~/");
    console.log(
      `${short.padEnd(50)} ${String(data.sessions).padStart(9)} ${formatCost(data.cost).padStart(10)} ${formatDuration(data.duration).padStart(10)}`
    );
  }

  // Tool usage
  if (tools) {
    console.log(`\nTool Usage\n`);
    const sortedTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    const toolHeader = `${"Tool".padEnd(25)} ${"Calls".padStart(7)} ${"Avg/session".padStart(12)}`;
    console.log(toolHeader);
    console.log(sep.repeat(toolHeader.length));
    for (const [name, count] of sortedTools.slice(0, 20)) {
      console.log(
        `${name.padEnd(25)} ${String(count).padStart(7)} ${(count / summaries.length).toFixed(1).padStart(12)}`
      );
    }
  }

  // Hourly distribution
  if (hourly) {
    console.log(`\nBy Hour of Day\n`);
    const hours = new Array(24).fill(0);
    for (const s of summaries) hours[s.startTime.getHours()]++;
    const maxH = Math.max(...hours);
    for (let h = 0; h < 24; h++) {
      if (hours[h] > 0) {
        if (fancy) {
          const bar = "#".repeat(Math.round((hours[h] / maxH) * 30));
          console.log(`${String(h).padStart(2)}:00  ${bar} ${hours[h]}`);
        } else {
          console.log(`${String(h).padStart(2)}:00  ${hours[h]}`);
        }
      }
    }
  }

  // Longest sessions
  console.log(`\nLongest Sessions (top 10)\n`);
  const longest = [...summaries].sort((a, b) => b.durationMs - a.durationMs).slice(0, 10);
  for (const s of longest) {
    const date = s.startTime.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const firstMsg = s.userMessages[0]?.text.replace(/\n/g, " ").slice(0, 50) ?? "";
    const short = s.cwd.replace(/^\/Users\/\w+\//, "~/");
    console.log(`${formatDuration(s.durationMs).padEnd(10)} ${formatCost(s.totalCost).padEnd(8)} ${date}  ${short.slice(-30).padEnd(32)} "${firstMsg}"`);
  }

  console.log();
}

main().catch(console.error);
